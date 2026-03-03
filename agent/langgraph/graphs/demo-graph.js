import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { StateGraph, START, END } from '../internal/langgraph-lite.js';
import { DemoGraphState } from '../state.js';
import { createOpenRouterChatModel } from '../model.js';
import { runObservePage } from '../tools/observe-page.js';
import { DEMO_AGENT_SYSTEM_PROMPT } from '../../prompts.js';
import { isAffirmative, normalizeDomain, safeJsonParse } from '../utils.js';
import { writeSkillFromDemo } from '../../../skills/skill-writer.js';
import { pushStatus } from '../../../electron/status-bus.js';

function isCorrection(text = '') {
  return text.trim().length > 0;
}

function normalizeDemoPayload(payload) {
  return {
    message: typeof payload?.message === 'string' ? payload.message : '',
    updatedDraft: typeof payload?.updatedDraft === 'string' ? payload.updatedDraft : null,
    skillComplete: Boolean(payload?.skillComplete),
    finalSkill: typeof payload?.finalSkill === 'string' ? payload.finalSkill : null,
    skillName: typeof payload?.skillName === 'string' && payload.skillName.trim() ? payload.skillName.trim() : 'new-skill'
  };
}

function renderVoiceContext(segments = []) {
  if (!segments.length) return '- (none)';
  return segments.map((segment) => `- ${segment.transcript}`).join('\n');
}

function renderObservedContext(observedElements = []) {
  if (!observedElements.length) return '(No observed interactive elements.)';
  return observedElements
    .slice(0, 20)
    .map((element, index) => `${index + 1}. "${element.description}" [${element.method || 'act'}]`)
    .join('\n');
}

async function synthesizeDraft({ pageUrl, voiceSegments, observedElements, currentDraft, correction }) {
  const model = createOpenRouterChatModel({
    model: process.env.DEMO_MODEL || 'google/gemini-2.5-flash',
    temperature: 0.1,
    maxTokens: 500
  });

  const completion = await model.invoke([
    new SystemMessage(DEMO_AGENT_SYSTEM_PROMPT),
    new HumanMessage(`Site: ${normalizeDomain(pageUrl)}
Page URL: ${pageUrl}
Voice:
${renderVoiceContext(voiceSegments)}

Observed elements:
${renderObservedContext(observedElements)}

Current draft:
${currentDraft || '(none)'}

Correction from user: ${correction || '(none)'}

Return strict JSON only.`)
  ]);

  const parsed = safeJsonParse(typeof completion.content === 'string' ? completion.content : '', null);
  return normalizeDemoPayload(parsed || {});
}

async function ingestDemoEvent(state) {
  const eventType = state.eventType || 'voice';
  const transcript = String(state.transcript || '').trim();

  const next = {
    saveRequested: eventType === 'save',
    reviewRequested: eventType === 'finalize',
    agentMessage: '',
    skillWritten: null
  };

  if (eventType === 'voice' && transcript) {
    next.messages = [new HumanMessage(transcript)];
    next.pendingVoice = [{ transcript, timestamp: Date.now() }];
  }

  return next;
}

async function contextCollect(state) {
  if (state.eventType === 'save') return {};

  try {
    const observe = await runObservePage({
      reason: state.eventType === 'finalize' ? 'review-start' : 'demo-voice',
      limit: 25
    });
    return {
      observedElements: observe.observedElements,
      pageUrl: observe.url
    };
  } catch (error) {
    pushStatus(`Demo observe failed: ${String(error?.message || error)}`, 'warning');
    return {
      observedElements: state.observedElements || [],
      pageUrl: state.pageUrl || 'https://example.com'
    };
  }
}

async function demoSynthesisAgent(state) {
  if (state.eventType === 'save') return {};

  const transcript = String(state.transcript || '').trim();
  if (!transcript && state.eventType === 'voice') {
    return { agentMessage: 'I did not catch that. Please repeat what you demonstrated.' };
  }

  if (state.awaitingConfirmation && state.eventType === 'voice') {
    if (isAffirmative(transcript)) {
      return { saveRequested: true };
    }

    if (isCorrection(transcript)) {
      const revised = await synthesizeDraft({
        pageUrl: state.pageUrl || 'https://example.com',
        voiceSegments: [{ transcript, timestamp: Date.now() }],
        observedElements: state.observedElements || [],
        currentDraft: state.awaitingConfirmation.finalSkill,
        correction: transcript
      });

      if (revised.skillComplete && revised.finalSkill) {
        return {
          currentSkillDraft: revised.updatedDraft || revised.finalSkill,
          awaitingConfirmation: {
            finalSkill: revised.finalSkill,
            skillName: revised.skillName,
            domain: normalizeDomain(state.pageUrl || 'https://example.com')
          },
          agentMessage: revised.message || 'Updated draft based on your correction. Confirm when ready.'
        };
      }

      return {
        currentSkillDraft: revised.updatedDraft || state.currentSkillDraft,
        agentMessage:
          revised.message || 'I need one more clarification before I can finalize the skill. Reply with the detail.'
      };
    }
  }

  if (state.awaitingConfirmation && state.eventType === 'finalize') {
    return {
      agentMessage: `I have a complete draft for '${state.awaitingConfirmation.skillName}'. Click Create Skill to save, or reply with corrections.`
    };
  }

  const reviewSegments = state.reviewRequested
    ? state.pendingVoice.length
      ? state.pendingVoice
      : [{ transcript: 'User ended demo capture and wants to finalize the skill.', timestamp: Date.now() }]
    : state.pendingVoice;

  const synthesis = await synthesizeDraft({
    pageUrl: state.pageUrl || 'https://example.com',
    voiceSegments: reviewSegments,
    observedElements: state.observedElements || [],
    currentDraft: state.currentSkillDraft,
    correction: state.reviewRequested
      ? 'User ended demo capture and entered review. Ask one concise clarifying question if needed, otherwise finalize.'
      : null
  });

  if (synthesis.updatedDraft) {
    if (synthesis.skillComplete && synthesis.finalSkill) {
      return {
        currentSkillDraft: synthesis.updatedDraft,
        awaitingConfirmation: {
          finalSkill: synthesis.finalSkill,
          skillName: synthesis.skillName,
          domain: normalizeDomain(state.pageUrl || 'https://example.com')
        },
        agentMessage:
          synthesis.message ||
          `I have a complete draft for '${synthesis.skillName}'. Click Create Skill to save, or reply with corrections.`
      };
    }

    return {
      currentSkillDraft: synthesis.updatedDraft,
      agentMessage: synthesis.message || 'Captured. Continue demonstrating or refine the draft.'
    };
  }

  return {
    agentMessage:
      synthesis.message || 'I need one more clarification before I can finalize the skill. Reply with the detail.'
  };
}

async function demoConfirmationGate(state) {
  if (state.saveRequested && !state.awaitingConfirmation) {
    return {
      agentMessage: 'I still need to finalize the draft before saving. Continue review first.'
    };
  }
  return {};
}

async function saveSkillNode(state) {
  if (!state.saveRequested || !state.awaitingConfirmation) return {};

  const pending = state.awaitingConfirmation;
  const saved = await writeSkillFromDemo({
    domain: pending.domain,
    skillName: pending.skillName,
    finalSkill: pending.finalSkill
  });

  pushStatus(`Skill saved: ${saved.domain}/${saved.filename}`, 'status');

  return {
    awaitingConfirmation: null,
    currentSkillDraft: null,
    pendingVoice: [],
    saveRequested: false,
    skillWritten: saved,
    agentMessage: `Saved '${pending.skillName}' for ${pending.domain}.`
  };
}

async function demoResponse() {
  return {};
}

function routeAfterConfirmation(state) {
  if (state.saveRequested && state.awaitingConfirmation) return 'save_skill';
  return 'demo_response';
}

export function createDemoGraph(checkpointer) {
  const graph = new StateGraph(DemoGraphState)
    .addNode('ingest_demo_event', ingestDemoEvent)
    .addNode('context_collect', contextCollect)
    .addNode('demo_synthesis_agent', demoSynthesisAgent)
    .addNode('demo_confirmation_gate', demoConfirmationGate)
    .addNode('save_skill', saveSkillNode)
    .addNode('demo_response', demoResponse)
    .addEdge(START, 'ingest_demo_event')
    .addEdge('ingest_demo_event', 'context_collect')
    .addEdge('context_collect', 'demo_synthesis_agent')
    .addEdge('demo_synthesis_agent', 'demo_confirmation_gate')
    .addConditionalEdges('demo_confirmation_gate', routeAfterConfirmation, ['save_skill', 'demo_response'])
    .addEdge('save_skill', 'demo_response')
    .addEdge('demo_response', END);

  return graph.compile({ checkpointer });
}
