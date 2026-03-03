import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { navigateTo } from '../../../electron/stagehand-manager.js';

export async function runNavigate({ url }) {
  const page = await navigateTo(url);
  const currentUrl = typeof page.url === 'function' ? page.url() : url;
  return {
    url: currentUrl,
    navigated: currentUrl === url
  };
}

export const navigateTool = tool(
  async ({ url }) => {
    return runNavigate({ url });
  },
  {
    name: 'navigate',
    description: 'Navigate the controlled browser page to the provided URL.',
    schema: z.object({
      url: z.string().url().describe('The destination URL to open in the browser.')
    })
  }
);
