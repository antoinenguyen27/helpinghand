import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from '@langchain/core/messages';
import { StateGraph, START, END, ToolNode } from '../internal/langgraph-lite.js';
import { WorkGraphState } from '../state.js';
import { createOpenRouterChatModel } from '../model.js';
import { WORK_TOOLS } from '../tools/index.js';
import { isAffirmative, isIrreversible, isNegative, normalizeDomain, safeJsonParse } from '../utils.js';
import { pushStatus } from '../../../electron/status-bus.js';
import { addToMemory } from '../../../memory/session-memory.js';

const MAX_AGENT_LOOPS = Number(process.env.LANGGRAPH_MAX_LOOPS || 8);
const TRACE_ENABLED = process.env.LANGGRAPH_TRACE !== '0';
const TRACE_MAX_CHARS = Number(process.env.LANGGRAPH_TRACE_MAX_CHARS || 2500);

function stringifyForTrace(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function trace(label, payload) {
  if (!TRACE_ENABLED) return;
  const serialized = stringifyForTrace(payload);
  const clipped =
    serialized.length > TRACE_MAX_CHARS
      ? `${serialized.slice(0, TRACE_MAX_CHARS)}… [truncated ${serialized.length - TRACE_MAX_CHARS} chars]`
      : serialized;
  pushStatus(`LangGraph trace - ${label}: ${clipped}`, 'api');
}

function latestMessageOfType(messages, predicate) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (predicate(messages[i])) return messages[i];
  }
  return null;
}

function messageText(message) {
  const content = message?.content;
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((item) => (typeof item?.text === 'string' ? item.text : ''))
      .join(' ')
      .trim();
  }
  return '';
}

function parseToolMessage(toolMessage) {
  if (!(toolMessage instanceof ToolMessage)) return null;
  const parsed = safeJsonParse(String(toolMessage.content || ''), null);
  if (parsed) return parsed;
  return { success: false, summary: String(toolMessage.content || 'Tool execution failed.') };
}

function workSystemPrompt({ domain, pageUrl }) {
  return `You are a voice-controlled browser orchestrator running in a LangGraph tool loop.
You must decide between direct response or tool usage.

Current domain: ${domain || 'unknown'}
Current page URL: ${pageUrl || 'unknown'}

Use tools intentionally:
- read_skills(domain): retrieve existing domain workflows before acting.
- observe_page(reason): inspect visible interactive elements before uncertain actions.
- read_session_memory(limit): retrieve recent turn outcomes.
- navigate(url): navigate to needed pages.
- cua_execute(taskDescription, cuaInstruction, taskScope): execute browser work.

Rules:
- Keep replies short and spoken-friendly.
- Use cua_execute only when instruction is concrete.
- Never execute irreversible actions (send/delete/publish/payment/purchase/checkout) unless user confirmed.
- If a tool reports auth/security blocker, explain blocker and ask user to unblock in Chrome.
- If a tool fails twice, report blocker and ask one concrete follow-up.
- Prefer clarification over guessing.
- Return plain conversational text when not calling tools.`;
}

async function ingestUserTurn(state) {
  const userVoice = String(state.userVoice || '').trim();
  trace('ingest_user_turn.input', { userVoice, pageUrl: state.pageUrl, domain: state.domain });
  if (!userVoice) {
    return { finalResponse: 'I did not catch that. Please repeat the request.' };
  }
  return {
    loopCount: 0,
    finalResponse: '',
    messages: [new HumanMessage(userVoice)]
  };
}

async function agentPlan(state) {
  const messages = state.messages || [];
  const lastUser = latestMessageOfType(messages, (msg) => msg instanceof HumanMessage);
  const lastUserText = messageText(lastUser);

  if (state.awaitingConfirmation) {
    trace('agent_plan.awaiting_confirmation', { lastUserText });
    if (isAffirmative(lastUserText)) {
      const pending = state.pendingExecution || {};
      pushStatus('Confirmation received. Executing pending irreversible action.', 'status');
      return {
        awaitingConfirmation: false,
        pendingExecution: null,
        finalResponse: '',
        messages: [
          new AIMessage({
            content: 'Executing confirmed action.',
            tool_calls: [
              {
                id: `cua_confirm_${Date.now()}`,
                name: 'cua_execute',
                args: pending,
                type: 'tool_call'
              }
            ]
          })
        ]
      };
    }

    if (isNegative(lastUserText)) {
      return {
        awaitingConfirmation: false,
        pendingExecution: null,
        finalResponse: 'Cancelled. I did not perform the irreversible action.'
      };
    }

    return { finalResponse: 'Please say yes to proceed, or no to cancel.' };
  }

  const toolResultMsg = latestMessageOfType(messages, (msg) => msg instanceof ToolMessage);
  const parsedToolResult = parseToolMessage(toolResultMsg);
  trace('agent_plan.last_tool_result', parsedToolResult);
  if (parsedToolResult && parsedToolResult.success === false && parsedToolResult.retriesExhausted) {
    return {
      finalResponse:
        parsedToolResult.summary || 'I hit repeated execution failures. Please adjust the page state and retry.'
    };
  }

  if ((state.loopCount || 0) >= MAX_AGENT_LOOPS) {
    return { finalResponse: 'I reached the step limit. Please refine the instruction and I can retry.' };
  }

  const model = createOpenRouterChatModel({
    model: process.env.ORCHESTRATOR_MODEL || 'google/gemini-3-flash-preview',
    temperature: 0.1,
    maxTokens: 280
  }).bindTools(WORK_TOOLS);

  const aiMessage = await model.invoke([
    new SystemMessage(workSystemPrompt({ domain: state.domain, pageUrl: state.pageUrl })),
    ...messages
  ]);
  trace('agent_plan.ai_output', {
    content: messageText(aiMessage),
    toolCalls: Array.isArray(aiMessage?.tool_calls) ? aiMessage.tool_calls : []
  });

  return {
    loopCount: (state.loopCount || 0) + 1,
    messages: [aiMessage]
  };
}

async function safetyGate(state) {
  const lastAi = latestMessageOfType(state.messages || [], (msg) => msg instanceof AIMessage);
  const toolCall = Array.isArray(lastAi?.tool_calls)
    ? lastAi.tool_calls.find((call) => call?.name === 'cua_execute')
    : null;
  if (!toolCall) return {};

  const args = toolCall.args || {};
  const instructionText = `${args.taskDescription || ''} ${args.cuaInstruction || ''}`;
  trace('safety_gate.inspect', { toolCall, instructionText });
  if (!isIrreversible(instructionText)) return {};

  const confirmationPrompt =
    args.confirmationPrompt ||
    `This action looks irreversible (${args.taskDescription || 'requested action'}). Say yes to proceed or no to cancel.`;
  return {
    awaitingConfirmation: true,
    pendingExecution: {
      taskDescription: args.taskDescription || 'Confirmed action',
      cuaInstruction: args.cuaInstruction || args.taskDescription || '',
      taskScope: args.taskScope || 'short'
    },
    finalResponse: confirmationPrompt
  };
}

async function respond(state) {
  if (state.finalResponse) {
    addToMemory({ task: state.userVoice, result: state.finalResponse, timestamp: Date.now() });
    return {};
  }

  const lastToolMessage = latestMessageOfType(state.messages || [], (msg) => msg instanceof ToolMessage);
  const toolResult = parseToolMessage(lastToolMessage);
  trace('respond.tool_result', toolResult);
  if (toolResult?.summary) {
    const response = toolResult.success
      ? String(toolResult.summary)
      : `I could not complete that: ${String(toolResult.summary)}`;
    addToMemory({ task: state.userVoice, result: response, timestamp: Date.now() });
    return { finalResponse: response };
  }

  const lastAi = latestMessageOfType(state.messages || [], (msg) => msg instanceof AIMessage);
  const fallbackResponse = messageText(lastAi) || 'Understood.';
  trace('respond.fallback', { fallbackResponse });
  addToMemory({ task: state.userVoice, result: fallbackResponse, timestamp: Date.now() });
  return { finalResponse: fallbackResponse };
}

function routeAfterPlan(state) {
  if (state.finalResponse) return 'respond';

  const lastAi = latestMessageOfType(state.messages || [], (msg) => msg instanceof AIMessage);
  const toolCalls = Array.isArray(lastAi?.tool_calls) ? lastAi.tool_calls : [];
  if (!toolCalls.length) return 'respond';

  const cuaCall = toolCalls.find((call) => call?.name === 'cua_execute');
  if (!cuaCall) return 'tool_exec';

  const args = cuaCall.args || {};
  const instructionText = `${args.taskDescription || ''} ${args.cuaInstruction || ''}`;
  if (isIrreversible(instructionText)) {
    trace('route_after_plan', { route: 'safety_gate', instructionText });
    return 'safety_gate';
  }

  trace('route_after_plan', { route: 'tool_exec', toolCalls });
  return 'tool_exec';
}

function routeAfterSafety(state) {
  if (state.awaitingConfirmation && state.finalResponse) {
    trace('route_after_safety', { route: 'respond', awaitingConfirmation: state.awaitingConfirmation });
    return 'respond';
  }
  trace('route_after_safety', { route: 'tool_exec', awaitingConfirmation: state.awaitingConfirmation });
  return 'tool_exec';
}

export function createWorkGraph(checkpointer) {
  const toolNode = new ToolNode(WORK_TOOLS);

  const graph = new StateGraph(WorkGraphState)
    .addNode('ingest_user_turn', ingestUserTurn)
    .addNode('agent_plan', agentPlan)
    .addNode('tool_exec', toolNode)
    .addNode('safety_gate', safetyGate)
    .addNode('respond', respond)
    .addEdge(START, 'ingest_user_turn')
    .addEdge('ingest_user_turn', 'agent_plan')
    .addConditionalEdges('agent_plan', routeAfterPlan, ['tool_exec', 'safety_gate', 'respond'])
    .addEdge('tool_exec', 'agent_plan')
    .addConditionalEdges('safety_gate', routeAfterSafety, ['respond', 'tool_exec'])
    .addEdge('respond', END);

  return graph.compile({ checkpointer });
}

export async function buildWorkGraphInput({ userVoice, pageUrl }) {
  return {
    userVoice,
    pageUrl,
    domain: normalizeDomain(pageUrl)
  };
}
