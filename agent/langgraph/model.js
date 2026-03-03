import { ChatOpenAI } from '@langchain/openai';

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
const DEFAULT_HEADERS = {
  'HTTP-Referer': 'https://github.com/your-org/universal-agent',
  'X-Title': 'Universal Agent'
};

export function createOpenRouterChatModel({ model, temperature = 0.1, maxTokens } = {}) {
  return new ChatOpenAI({
    model: model || process.env.ORCHESTRATOR_MODEL || 'google/gemini-3-flash-preview',
    temperature,
    maxTokens,
    apiKey: process.env.OPENROUTER_API_KEY,
    configuration: {
      baseURL: OPENROUTER_BASE_URL,
      defaultHeaders: DEFAULT_HEADERS
    }
  });
}
