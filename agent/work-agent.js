import { buildCUASystemPrompt } from './prompts.js';
import { getStagehand } from '../electron/stagehand-manager.js';
import { pushStatus, pushCUAState } from '../electron/status-bus.js';

let activeAbortController = null;
let cuaRunning = false;
let lastProgressAt = 0;
let progressTimer = null;
const CUA_TRACE_MAX_CHARS = Number(process.env.CUA_TRACE_MAX_CHARS || 2500);
const DEFAULT_EXECUTION_MODEL = 'google/gemini-3-flash-preview';

function stringifyForTrace(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function pushCUATrace(label, payload) {
  const serialized = stringifyForTrace(payload);
  const clipped =
    serialized.length > CUA_TRACE_MAX_CHARS
      ? `${serialized.slice(0, CUA_TRACE_MAX_CHARS)}... [truncated ${serialized.length - CUA_TRACE_MAX_CHARS} chars]`
      : serialized;
  pushStatus(`CUA trace - ${label}: ${clipped}`, 'api');
}

function startNoProgressWatchdog() {
  clearNoProgressWatchdog();
  progressTimer = setInterval(() => {
    if (!cuaRunning) return;
    const elapsed = Date.now() - lastProgressAt;
    if (elapsed > 5 * 60 * 1000) {
      pushStatus('Warning: no browser progress for over 5 minutes. You can say stop and retry.', 'warning');
      lastProgressAt = Date.now();
    }
  }, 10_000);
}

function clearNoProgressWatchdog() {
  if (progressTimer) {
    clearInterval(progressTimer);
    progressTimer = null;
  }
}

function resolveExecutionConfig(decision) {
  const configuredModel = String(
    process.env.CUA_MODEL || process.env.STAGEHAND_MODEL || DEFAULT_EXECUTION_MODEL
  ).trim();
  const normalizedModel = normalizeOpenRouterModel(configuredModel) || DEFAULT_EXECUTION_MODEL;
  const model =
    normalizedModel === 'google/gemini-2.5-flash' ? DEFAULT_EXECUTION_MODEL : normalizedModel;
  const apiKey = process.env.OPENROUTER_API_KEY;

  if (!apiKey) {
    throw new Error('Missing OPENROUTER_API_KEY for CUA execution.');
  }
  if (model !== normalizedModel) {
    pushStatus(
      `Configured model "${configuredModel}" is not CUA-capable; using ${DEFAULT_EXECUTION_MODEL} for mode=cua.`,
      'warning'
    );
  }

  return {
    model,
    apiKey,
    endpoint: 'https://openrouter.ai/api/v1',
    taskScope: decision.taskScope || 'short'
  };
}

function normalizeOpenRouterModel(modelName) {
  const trimmed = String(modelName || '').trim();
  if (!trimmed) return DEFAULT_EXECUTION_MODEL;
  const parts = trimmed.split('/');
  if (parts.length >= 3 && parts[0] === 'openai') {
    return parts.slice(1).join('/');
  }
  return trimmed;
}

export async function executeCUAInstruction(decision) {
  const sh = await getStagehand();
  const execution = resolveExecutionConfig(decision);
  const systemPrompt = buildCUASystemPrompt(decision);

  activeAbortController = new AbortController();
  cuaRunning = true;
  pushCUAState(true);
  lastProgressAt = Date.now();
  startNoProgressWatchdog();

  pushStatus(`Executing: ${decision.taskDescription}`, 'status');
  pushStatus(`CUA execution ready (model=${execution.model}, endpoint=${execution.endpoint}).`, 'api');

  try {
    const agent = sh.agent({
      mode: 'cua',
      model: {
        modelName: execution.model,
        apiKey: execution.apiKey,
        baseURL: execution.endpoint
      },
      maxSteps: execution.taskScope === 'long' ? 35 : 15,
      systemPrompt,
      callbacks: {
        onStepFinish: (step) => {
          const summary = step?.text || step?.description || 'Completed browser step';
          lastProgressAt = Date.now();
          pushStatus(summary, 'status');
        }
      }
    });
    pushCUATrace('execute.request', {
      model: execution.model,
      taskScope: execution.taskScope,
      instruction: decision.cuaInstruction
    });

    const result = await agent.execute({
      instruction: decision.cuaInstruction,
      maxSteps: execution.taskScope === 'long' ? 35 : 15
    });
    pushCUATrace('execute.result', result || {});

    const reportedSuccess = result?.success !== false && result?.completed !== false;
    return {
      success: reportedSuccess,
      summary: result?.summary || result?.message || (reportedSuccess ? 'Task completed.' : 'Task failed.'),
      raw: result
    };
  } catch (error) {
    if (activeAbortController?.signal.aborted) {
      pushStatus('CUA execution interrupted by user.', 'warning');
      return { success: false, interrupted: true, summary: 'Execution interrupted by user.' };
    }

    const details = String(error?.message || error || 'unknown error');
    pushCUATrace('execute.error', {
      name: error?.name || 'Error',
      message: details,
      code: error?.code || null,
      status: error?.status || error?.statusCode || null,
      cause: error?.cause ? String(error.cause?.message || error.cause) : null,
      responseBody: error?.response?.data || error?.response?.body || error?.body || null
    });
    pushStatus(`CUA execution error: ${details}`, 'error');
    if (/login|sign in|2fa|verification|captcha/i.test(details)) {
      return {
        success: false,
        blockedByAuth: true,
        summary: 'Hit a login or verification wall. Please sign in within the browser window, then retry.'
      };
    }

    return {
      success: false,
      summary: `Execution failed: ${details}`
    };
  } finally {
    cuaRunning = false;
    activeAbortController = null;
    clearNoProgressWatchdog();
    pushCUAState(false);
  }
}

export async function pauseCUA() {
  if (!cuaRunning || !activeAbortController) return { ok: true, interrupted: false };

  activeAbortController.abort();
  pushStatus('Paused current task. Listening for your next instruction.', 'status');
  return { ok: true, interrupted: true };
}

export function isCUARunning() {
  return cuaRunning;
}
