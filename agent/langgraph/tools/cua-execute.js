import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { executeCUAInstruction } from '../../work-agent.js';
import { sleep } from '../utils.js';

function isRetryableFailure(result) {
  if (!result || result.success) return false;
  if (result.interrupted) return false;
  if (result.blockedByAuth) return false;
  return true;
}

export async function runCUAExecute(input) {
  const decision = {
    taskDescription: input.taskDescription,
    cuaInstruction: input.cuaInstruction,
    taskScope: input.taskScope || 'short'
  };

  let attempts = 0;
  let lastResult = null;

  while (attempts < 2) {
    attempts += 1;
    lastResult = await executeCUAInstruction(decision);
    if (!isRetryableFailure(lastResult)) break;
    if (attempts < 2) await sleep(350);
  }

  return {
    ...lastResult,
    attempts,
    retriesExhausted: Boolean(lastResult && !lastResult.success && attempts >= 2 && !lastResult.blockedByAuth)
  };
}

export const cuaExecuteTool = tool(
  async ({ taskDescription, cuaInstruction, taskScope }) => {
    return runCUAExecute({ taskDescription, cuaInstruction, taskScope });
  },
  {
    name: 'cua_execute',
    description:
      'Execute a browser task using Stagehand agent(). Use only after intent is concrete and irreversible actions are confirmed.',
    schema: z.object({
      taskDescription: z.string().min(1).describe('Short summary of what to do.'),
      cuaInstruction: z.string().min(1).describe('Concrete browser instruction to execute.'),
      taskScope: z.enum(['short', 'long']).default('short').describe('Estimated task length.')
    })
  }
);
