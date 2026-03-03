/**
 * @typedef {Object} ToolResult
 * @property {boolean} success
 * @property {string} summary
 * @property {boolean=} interrupted
 * @property {boolean=} blockedByAuth
 * @property {unknown=} raw
 * @property {string=} error
 * @property {number=} attempts
 */

/**
 * @typedef {Object} SafetyDecision
 * @property {boolean} requiresConfirmation
 * @property {string=} confirmationPrompt
 * @property {Object=} pendingExecution
 */

/**
 * @typedef {Object} AgentState
 * @property {import('@langchain/core/messages').BaseMessage[]} messages
 * @property {string=} userVoice
 * @property {string=} domain
 * @property {string=} pageUrl
 * @property {boolean=} awaitingConfirmation
 * @property {Object=} pendingExecution
 * @property {string=} finalResponse
 * @property {number=} loopCount
 * @property {number=} toolErrorCount
 */

/**
 * @typedef {Object} DemoState
 * @property {import('@langchain/core/messages').BaseMessage[]} messages
 * @property {'voice'|'finalize'|'save'=} eventType
 * @property {string=} transcript
 * @property {string=} pageUrl
 * @property {Array<{transcript: string, timestamp: number}>=} pendingVoice
 * @property {Array<{description: string, method: string}>=} observedElements
 * @property {string=} currentSkillDraft
 * @property {{finalSkill: string, skillName: string, domain: string}=} awaitingConfirmation
 * @property {boolean=} saveRequested
 * @property {boolean=} reviewRequested
 * @property {string=} agentMessage
 * @property {Object=} skillWritten
 */
