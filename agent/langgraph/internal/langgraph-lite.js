import { ToolMessage } from '@langchain/core/messages';
import { pushStatus } from '../../../electron/status-bus.js';

export const START = '__start__';
export const END = '__end__';
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

export function Annotation(config) {
  return config;
}

Annotation.Root = function root(spec) {
  return { spec };
};

export class MemorySaver {
  constructor() {
    this.store = new Map();
  }

  get(threadId) {
    return this.store.get(threadId) || null;
  }

  set(threadId, value) {
    this.store.set(threadId, value);
  }
}

function cloneValue(value) {
  if (Array.isArray(value)) return [...value];
  if (value && typeof value === 'object') return { ...value };
  return value;
}

function buildInitialState(spec = {}, previous = {}, input = {}) {
  const state = {};
  for (const [key, config] of Object.entries(spec)) {
    const defaultValue = typeof config?.default === 'function' ? config.default() : undefined;
    state[key] = cloneValue(defaultValue);
  }

  for (const [key, value] of Object.entries(previous || {})) {
    state[key] = cloneValue(value);
  }

  for (const [key, value] of Object.entries(input || {})) {
    state[key] = cloneValue(value);
  }

  return state;
}

function mergeState(state, update, spec = {}) {
  if (!update || typeof update !== 'object') return state;

  for (const [key, value] of Object.entries(update)) {
    const reducer = spec?.[key]?.reducer;
    if (typeof reducer === 'function') {
      state[key] = reducer(state[key], value);
    } else {
      state[key] = value;
    }
  }

  return state;
}

export class StateGraph {
  constructor(annotationRoot) {
    this.spec = annotationRoot?.spec || {};
    this.nodes = new Map();
    this.edges = new Map();
    this.conditionals = new Map();
  }

  addNode(name, handler) {
    const nodeHandler = typeof handler?.invoke === 'function' ? (state) => handler.invoke(state) : handler;
    this.nodes.set(name, nodeHandler);
    return this;
  }

  addEdge(from, to) {
    this.edges.set(from, to);
    return this;
  }

  addConditionalEdges(from, router, options = []) {
    this.conditionals.set(from, { router, options: new Set(options) });
    return this;
  }

  compile({ checkpointer } = {}) {
    const nodes = this.nodes;
    const edges = this.edges;
    const conditionals = this.conditionals;
    const spec = this.spec;
    const cp = checkpointer || new MemorySaver();

    return {
      invoke: async (input, config = {}) => {
        const threadId = config?.configurable?.thread_id || 'default';
        const previous = cp.get(threadId) || {};
        const state = buildInitialState(spec, previous, input);

        let current = edges.get(START);
        let guard = 0;
        while (current && current !== END) {
          guard += 1;
          if (guard > 200) {
            throw new Error('Graph execution aborted after exceeding 200 node transitions.');
          }

          const handler = nodes.get(current);
          if (typeof handler !== 'function') {
            throw new Error(`Missing handler for graph node: ${current}`);
          }

          const update = await handler(state);
          mergeState(state, update, spec);

          const conditional = conditionals.get(current);
          if (conditional) {
            const next = await conditional.router(state);
            if (!conditional.options.has(next)) {
              throw new Error(`Invalid conditional edge from ${current}: ${String(next)}`);
            }
            current = next;
          } else {
            current = edges.get(current);
          }
        }

        cp.set(threadId, state);
        return state;
      }
    };
  }
}

export class ToolNode {
  constructor(tools = []) {
    this.toolsByName = new Map(tools.map((tool) => [tool.name, tool]));
  }

  async invoke(state) {
    const messages = Array.isArray(state?.messages) ? state.messages : [];
    const last = messages[messages.length - 1];
    const toolCalls = Array.isArray(last?.tool_calls) ? last.tool_calls : [];

    const toolMessages = [];
    for (const call of toolCalls) {
      trace('tool_exec.call', {
        toolName: call?.name,
        toolCallId: call?.id,
        args: call?.args || {}
      });
      const selectedTool = this.toolsByName.get(call?.name);
      if (!selectedTool) {
        trace('tool_exec.unknown_tool', { toolName: String(call?.name || ''), toolCallId: call?.id });
        toolMessages.push(
          new ToolMessage({
            content: JSON.stringify({ success: false, summary: `Unknown tool: ${String(call?.name || '')}` }),
            tool_call_id: call?.id,
            name: call?.name
          })
        );
        continue;
      }

      try {
        const result = await selectedTool.invoke(call?.args || {});
        trace('tool_exec.result', {
          toolName: call?.name,
          toolCallId: call?.id,
          result
        });
        toolMessages.push(
          new ToolMessage({
            content: JSON.stringify(result),
            tool_call_id: call?.id,
            name: call?.name
          })
        );
      } catch (error) {
        trace('tool_exec.error', {
          toolName: call?.name,
          toolCallId: call?.id,
          error: String(error?.message || error || 'tool execution failed')
        });
        toolMessages.push(
          new ToolMessage({
            content: JSON.stringify({
              success: false,
              summary: String(error?.message || error || 'tool execution failed')
            }),
            tool_call_id: call?.id,
            name: call?.name
          })
        );
      }
    }

    return { messages: toolMessages };
  }
}
