# Agent Runtime Spec (LangGraph)

## Scope
This spec defines LangGraph runtime behavior for Work and Demo modes, with browser execution standardized on Stagehand hybrid mode.

## Provider Contract
- OpenRouter:
  - Voice transcription (`voxtral-small-24b-2507` path)
  - Work/demo orchestration chat model
- Google Generative AI:
  - Stagehand hybrid execution with locked model `google/gemini-3-flash-preview`
- ElevenLabs:
  - Optional TTS only

## Required Environment
- Required: `OPENROUTER_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`
- Optional: `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID`
- Startup is blocked when required keys are missing.

## Work Graph

### Nodes
1. `ingest_user_turn`
- Adds latest user transcript.

2. `agent_plan`
- Uses OpenRouter-backed chat model with tool calling.
- Handles yes/no confirmation turns for irreversible operations.

3. `tool_exec`
- Executes tool calls through LangGraph `ToolNode`.

4. `safety_gate`
- Intercepts irreversible `browser_execute` calls.
- Stores pending action and returns confirmation prompt.

5. `respond`
- Produces final response and writes session memory entry.

### Tools
- `read_skills`
- `observe_page`
- `read_session_memory`
- `navigate`
- `browser_execute`
  - Input: `{ taskDescription, instruction, taskScope }`
  - Output: `{ success, summary, blockedByAuth?, interrupted?, raw?, attempts, retriesExhausted }`

### Rules
- Retry one transient execution failure.
- Do not retry auth/security blockers.
- Require explicit confirmation for irreversible actions.
- Respect execution interrupts and return control to planner.

## Interrupt and State Channels
- Interrupt invoke channel: `exec:interrupt`
- Execution state stream channel: `exec:state`
- Preload API:
  - `interruptExecution()`
  - `onExecutionState(callback)`

## Demo Graph
Demo flow remains functionally unchanged:
- capture narration
- synthesize/refine draft
- confirmation loop
- save skill markdown
