import { readSkillsTool } from './read-skills.js';
import { observePageTool } from './observe-page.js';
import { readSessionMemoryTool } from './read-session-memory.js';
import { navigateTool } from './navigate.js';
import { browserExecuteTool } from './browser-execute.js';

export const WORK_TOOLS = [readSkillsTool, observePageTool, readSessionMemoryTool, navigateTool, browserExecuteTool];

export { readSkillsTool, observePageTool, readSessionMemoryTool, navigateTool, browserExecuteTool };
