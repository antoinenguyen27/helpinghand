import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { getSessionMemory } from '../../../memory/session-memory.js';

export async function runReadSessionMemory({ limit = 20 } = {}) {
  const max = Math.max(1, Math.min(Number(limit) || 20, 100));
  const entries = getSessionMemory().slice(-max);
  return { entries };
}

export const readSessionMemoryTool = tool(
  async ({ limit }) => {
    return runReadSessionMemory({ limit });
  },
  {
    name: 'read_session_memory',
    description: 'Read recent in-process session memory entries from prior turns.',
    schema: z.object({
      limit: z.number().int().min(1).max(100).optional().describe('Max number of entries to return.')
    })
  }
);
