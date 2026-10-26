import type {
  LLMChatRequest,
  LLMChatResponse,
  LLMMessage,
  LLMToolCall,
  LLMToolDefinition,
} from '../../llm/types';
import type {
  AgentMessageRecord,
  AgentSessionRecord,
  AgentToolCallRecord,
  CreateAgentSessionInput,
} from '../session/types';

export type MainAgentTerminalStatus =
  | 'completed'
  | 'max_turns_reached'
  | 'max_tool_calls_reached'
  | 'max_subagents_reached'
  | 'timeout_reached'
  | 'max_empty_responses'
  | 'max_consecutive_tool_failures'
  /**
   * 收尾阶段结束：预算触顶后 Agent 已完成强制收尾并给出了结论。
   *
   * 这与 `max_tool_calls_reached` 的区别是：后者是「被硬切断，结论可能不完整」，
   * 本状态是「预算用尽后走完了收尾流程，有可交付的结论」。
   */
  | 'finalized';

export interface MainAgentModelClient {
  chat(request: LLMChatRequest): Promise<LLMChatResponse>;
}

export interface MainAgentToolContext {
  sessionId: string;
  model: string;
  toolCall: LLMToolCall;
  turn: number;
}

export type ToolPermissionScope =
  | 'read'
  | 'write'
  | 'command'
  | 'network'
  | 'git_write'
  | 'cross_session';

export type ToolPermissionBehavior = 'allow' | 'deny';

export interface MainAgentTool {
  definition: LLMToolDefinition;
  permissionScope?: ToolPermissionScope;
  /**
   * 终态工具：只负责收尾（如 submit_review_findings），不消耗探索预算。
   *
   * 背景：探索预算耗尽时若「提交」也算一次工具调用，模型可能正好卡在
   * 调不出 submit 的临界点上，导致整轮审查没有结论。终态工具豁免预算后，
   * 模型用完探索额度仍能提交已有结论。
   */
  isTerminal?: boolean;
  execute(argumentsValue: unknown, context: MainAgentToolContext): Promise<unknown> | unknown;
}

export interface MainAgentTranscriptRepository {
  createSession(input: CreateAgentSessionInput): AgentSessionRecord;
  appendMessage(input: {
    sessionId: string;
    role: string;
    content: unknown;
    metadata?: Record<string, unknown>;
  }): AgentMessageRecord;
  appendToolCall(input: {
    sessionId: string;
    messageId?: string;
    toolName: string;
    status?: 'running' | 'completed' | 'failed';
    arguments?: unknown;
    result?: unknown;
    error?: unknown;
  }): AgentToolCallRecord;
  completeSession(input: {
    sessionId: string;
    status: 'completed' | 'failed' | 'cancelled';
    finalResult?: unknown;
    error?: unknown;
  }): AgentSessionRecord;
}

export interface MainAgentRunnerOptions {
  modelClient: MainAgentModelClient;
  transcriptRepository: MainAgentTranscriptRepository;
  tools?: MainAgentTool[];
  now?: () => number;
}

export interface MainAgentRunInput {
  session?: Omit<CreateAgentSessionInput, 'model'> & { model?: string };
  sessionId?: string;
  agentType?: string;
  model: string;
  systemPrompt?: string;
  userMessage: string;
  temperature?: number;
  maxTokens?: number;
  responseFormat?: 'text' | 'json';
  providerOptions?: Record<string, unknown>;
  /**
   * Maximum number of model turns. `0` or undefined means unlimited.
   *
   * The review agent is deliberately not capped here: a review that needs to
   * read twelve files must be allowed to read twelve files. Codex likewise
   * imposes no `maxTurns` ceiling. Runaway behaviour is prevented by the loop
   * detector and the timeout instead.
   */
  maxTurns?: number;
  /**
   * Maximum number of exploration tool calls. `0` or undefined means unlimited.
   *
   * Terminal tools (such as `submit_review_findings`) never count against
   * this budget.
   */
  maxToolCalls?: number;
  maxSubagents?: number;
  timeoutMs: number;
  maxEmptyResponses?: number;
  maxConsecutiveToolFailures?: number;
  /**
   * How many consecutive identical tool calls are tolerated before the loop
   * guard intervenes. Defaults to 3.
   */
  loopGuardThreshold?: number;
  /**
   * Token budget for the running context.
   *
   * When the accumulated context exceeds this, the runner trims older tool
   * results instead of letting the request grow without bound. Codex applies
   * the same idea via automatic compaction, but with a summary step; for a
   * review agent, dropping stale tool payloads keeps the diff intact and is
   * both cheaper and more faithful to the original evidence.
   */
  contextTokenBudget?: number;
  /**
   * Fraction of the context budget at which trimming kicks in.
   * Codex compacts at 65% of the window; we use the same default.
   */
  contextTrimThreshold?: number;
  /**
   * Number of recent tool messages that are never trimmed.
   */
  contextKeepRecentToolMessages?: number;
  /**
   * How many extra model turns the runner grants during the finalization phase.
   *
   * When the exploration budget is exhausted the runner does not stop — it
   * switches to a finalization phase where only terminal tools (such as
   * `submit_review_findings`) are allowed, so the agent always gets to deliver
   * a conclusion instead of having its work cut in half.
   */
  maxFinalizationTurns?: number;
}

export interface MainAgentRunResult {
  status: MainAgentTerminalStatus;
  sessionId: string;
  turns: number;
  toolCalls: number;
  finalText?: string;
  messages: LLMMessage[];
}

export interface ToolExecutionResult {
  ok: boolean;
  value?: unknown;
  error?: {
    name: string;
    message: string;
  };
}
