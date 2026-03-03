import { getPage } from '../electron/stagehand-manager.js';
import { pushStatus } from '../electron/status-bus.js';
import { pauseExecution } from './work-agent.js';
import { runWorkGraphTurn, resetWorkGraphState } from './langgraph/runtime.js';

export async function runOrchestratorTurn(userVoice) {
  const page = await getPage();
  const pageUrl = typeof page?.url === 'function' ? page.url() : 'https://example.com';

  pushStatus(
    `LangGraph work turn started (model=${process.env.ORCHESTRATOR_MODEL || 'google/gemini-3-flash-preview'}).`,
    'api'
  );

  const result = await runWorkGraphTurn({ userVoice, pageUrl });

  pushStatus('LangGraph work turn completed.', 'api');
  return { response: result.response };
}

export async function interruptCurrentTask() {
  await pauseExecution();
  return { response: 'Paused. What should I change?' };
}

export function resetOrchestratorState() {
  resetWorkGraphState();
}
