import type { LLMMessage, LLMToolCall } from '../../llm/types';
import { logger } from '../../utils/logger';
import { trimContext } from './context-trim';
import { buildLoopWarningMessage, createLoopDetector } from './loop-detection';
import { agentSessionRepository } from '../session/session-repository';
import type {
  MainAgentRunInput,
  MainAgentRunResult,
  MainAgentRunnerOptions,
  MainAgentTerminalStatus,
  MainAgentTool,
  MainAgentTranscriptRepository,
  ToolExecutionResult,
} from './types';

function parseToolArguments(toolCall: LLMToolCall): ToolExecutionResult {
  try {
    return { ok: true, value: JSON.parse(toolCall.arguments || '{}') };
  } catch (error) {
    const parsedError = error instanceof Error ? error : new Error(String(error));
    return {
      ok: false,
      error: {
        name: parsedError.name,
        message: parsedError.message,
      },
    };
  }
}

function stringifyToolResult(result: ToolExecutionResult): string {
  return JSON.stringify(result);
}

function normalizeError(error: unknown): ToolExecutionResult['error'] {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
    };
  }

  return {
    name: 'Error',
    message: String(error),
  };
}

export class MainAgentRunner {
  private readonly modelClient: MainAgentRunnerOptions['modelClient'];
  private readonly transcriptRepository: MainAgentTranscriptRepository;
  private readonly toolsByName: Map<string, MainAgentTool>;
  private readonly now: () => number;

  constructor(options: MainAgentRunnerOptions) {
    this.modelClient = options.modelClient;
    this.transcriptRepository = options.transcriptRepository;
    this.toolsByName = new Map((options.tools ?? []).map((tool) => [tool.definition.name, tool]));
    this.now = options.now ?? Date.now;
  }

  async run(input: MainAgentRunInput): Promise<MainAgentRunResult> {
    const startedAt = this.now();
    const sessionId =
      input.sessionId ??
      this.transcriptRepository.createSession({
        agentType: input.session?.agentType ?? input.agentType ?? 'main',
        model: input.session?.model ?? input.model,
        parentSessionId: input.session?.parentSessionId,
        parentInvocationId: input.session?.parentInvocationId,
        status: input.session?.status,
        metadata: input.session?.metadata,
      }).id;

    const messages: LLMMessage[] = [];
    if (input.systemPrompt) {
      messages.push({ role: 'system', content: input.systemPrompt });
    }

    const userMessage: LLMMessage = { role: 'user', content: input.userMessage };
    messages.push(userMessage);
    this.transcriptRepository.appendMessage({
      sessionId,
      role: 'user',
      content: { text: input.userMessage },
    });

    let turns = 0;
    let toolCalls = 0;
    let subagentCount = 0;
    let emptyResponseCount = 0;
    let consecutiveToolFailures = 0;
    const maxSubagents = input.maxSubagents ?? Number.POSITIVE_INFINITY;
    const maxEmptyResponses = input.maxEmptyResponses ?? 3;
    const maxConsecutiveToolFailures = input.maxConsecutiveToolFailures ?? 5;
    // 触顶时模型可能已写出结论但没机会提交，这里留住最后一条非空正文
    let lastAssistantText: string | undefined;
    // 循环检测：允许无限探索，但禁止反复调用同一工具的同一参数。
    // 这替代了原来的 maxTurns / maxToolCalls 硬上限。
    const loopThreshold = input.loopGuardThreshold ?? 3;
    const loopDetector = createLoopDetector({ threshold: loopThreshold });
    // 循环告警只提醒一次，之后若模型继续空转则强制收尾
    let loopWarningSent = false;
    // 收尾阶段：进入后只允许终态工具，直到 Agent 交付结论
    let finalizing = false;
    let finalizationTurns = 0;
    const maxFinalizationTurns = input.maxFinalizationTurns ?? 3;

    while (true) {
      const budgetStatus = this.getBudgetStatus(
        input,
        startedAt,
        turns,
        emptyResponseCount,
        consecutiveToolFailures,
        maxEmptyResponses,
        maxConsecutiveToolFailures
      );
      if (budgetStatus) {
        return this.finish(sessionId, budgetStatus, turns, toolCalls, messages, lastAssistantText);
      }

      // 循环告警：模型在重复同一动作时提醒它换思路或收尾
      if (loopWarningSent && finalizing) {
        return this.finish(sessionId, 'finalized', turns, toolCalls, messages, lastAssistantText);
      }

      // 收尾阶段也有上限：模型反复拒绝提交时不能无限等
      if (finalizing && finalizationTurns >= maxFinalizationTurns) {
        return this.finish(sessionId, 'finalized', turns, toolCalls, messages, lastAssistantText);
      }

      const response = await this.modelClient.chat({
        messages: this.trimMessagesIfNeeded(input, messages),
        model: input.model,
        temperature: input.temperature,
        maxTokens: input.maxTokens,
        responseFormat: input.responseFormat,
        providerOptions: input.providerOptions,
        tools: [...this.toolsByName.values()].map((tool) => tool.definition),
      });

      turns += 1;
      if (finalizing) finalizationTurns += 1;
      if (!response.content?.trim() && response.toolCalls.length === 0) {
        emptyResponseCount += 1;
        messages.push({ role: 'assistant', content: '' });
        this.transcriptRepository.appendMessage({
          sessionId,
          role: 'assistant',
          content: { text: '' },
        });
        continue;
      }

      emptyResponseCount = 0;

      // 记录模型这一轮写出的正文。工具调用触顶时没有走 completed 分支，
      // 这段正文就是唯一能带走的结论，不能丢。
      if (response.content?.trim()) {
        lastAssistantText = response.content;
      }

      const assistantMessage: LLMMessage = {
        role: 'assistant',
        content: response.content ?? '',
        toolCalls: response.toolCalls,
      };
      messages.push(assistantMessage);

      const assistantRecord = this.transcriptRepository.appendMessage({
        sessionId,
        role: 'assistant',
        content: {
          text: response.content ?? '',
          toolCalls: response.toolCalls,
          finishReason: response.finishReason,
          usage: response.usage,
        },
      });

      if (response.toolCalls.length === 0) {
        return this.finish(
          sessionId,
          'completed',
          turns,
          toolCalls,
          messages,
          response.content ?? undefined
        );
      }

      for (const toolCall of response.toolCalls) {
        if (this.isTimedOut(input, startedAt)) {
          return this.finish(
            sessionId,
            'timeout_reached',
            turns,
            toolCalls,
            messages,
            lastAssistantText
          );
        }
        // 终态工具（submit 之类）不参与循环检测：交付结论永远允许
        const isTerminalTool = this.toolsByName.get(toolCall.name)?.isTerminal === true;

        // 工具调用上限默认关闭（0 = 不限）。保留为可选兜底。
        if (!isTerminalTool && input.maxToolCalls && input.maxToolCalls > 0) {
          if (toolCalls >= input.maxToolCalls) {
            if (!finalizing) {
              finalizing = true;
              finalizationTurns = 0;
              const notice = this.buildFinalizationNotice(input, turns, toolCalls);
              messages.push({ role: 'user', content: notice });
              this.transcriptRepository.appendMessage({
                sessionId,
                role: 'user',
                content: { text: notice },
              });
              logger.info('工具调用额度用尽，转入收尾阶段', { turns, toolCalls });
            }
            const refusal = this.buildFinalizationRefusal(toolCall.name);
            messages.push({ role: 'tool', toolCallId: toolCall.id, content: refusal });
            this.transcriptRepository.appendToolCall({
              sessionId,
              messageId: assistantRecord.id,
              toolName: toolCall.name,
              status: 'failed',
              arguments: parseToolArguments(toolCall).value ?? {},
              error: { name: 'BudgetExceeded', message: refusal },
            });
            this.transcriptRepository.appendMessage({
              sessionId,
              role: 'tool',
              content: {
                toolCallId: toolCall.id,
                toolName: toolCall.name,
                result: {
                  ok: false,
                  error: { name: 'BudgetExceeded', message: refusal },
                },
              },
            });
            continue;
          }
        }

        // 循环检测：同一个工具 + 同样的参数反复调用 = 空转。
        // 这是替代 maxToolCalls / maxTurns 硬上限的机制 ——
        // 允许模型无限探索真实需要的文件，但禁止它原地打转。
        if (!isTerminalTool && !finalizing) {
          const parsedArgs = parseToolArguments(toolCall);
          const isLoop = loopDetector.record(toolCall.name, parsedArgs.value ?? {});
          if (isLoop) {
            if (!loopWarningSent) {
              loopWarningSent = true;
              const warning = buildLoopWarningMessage(toolCall.name, loopThreshold);
              messages.push({ role: 'user', content: warning });
              this.transcriptRepository.appendMessage({
                sessionId,
                role: 'user',
                content: { text: warning },
              });
              logger.warn('检测到重复工具调用，已提醒模型换思路或收尾', {
                toolName: toolCall.name,
                threshold: loopThreshold,
                toolCalls,
              });
            } else {
              // 已经提醒过还在重复 —— 转入收尾，强制它交结论
              finalizing = true;
              finalizationTurns = 0;
              const notice = this.buildFinalizationNotice(input, turns, toolCalls);
              messages.push({ role: 'user', content: notice });
              this.transcriptRepository.appendMessage({
                sessionId,
                role: 'user',
                content: { text: notice },
              });
              logger.warn('重复工具调用持续，转入收尾阶段', {
                toolName: toolCall.name,
                toolCalls,
              });
            }

            const refusal = this.buildLoopRefusal(toolCall.name);
            messages.push({ role: 'tool', toolCallId: toolCall.id, content: refusal });
            this.transcriptRepository.appendToolCall({
              sessionId,
              messageId: assistantRecord.id,
              toolName: toolCall.name,
              status: 'failed',
              arguments: parsedArgs.value ?? {},
              error: { name: 'LoopDetected', message: refusal },
            });
            this.transcriptRepository.appendMessage({
              sessionId,
              role: 'tool',
              content: {
                toolCallId: toolCall.id,
                toolName: toolCall.name,
                result: {
                  ok: false,
                  error: { name: 'LoopDetected', message: refusal },
                },
              },
            });
            continue;
          }
        }

        // 收尾阶段：探索类工具一律拒绝并回推收尾指令。
        // 与硬切断的区别是——模型仍然能调用 submit 交付已有结论。
        if (finalizing && !isTerminalTool) {
          const refusal = this.buildFinalizationRefusal(toolCall.name);
          messages.push({ role: 'tool', toolCallId: toolCall.id, content: refusal });
          this.transcriptRepository.appendToolCall({
            sessionId,
            messageId: assistantRecord.id,
            toolName: toolCall.name,
            status: 'failed',
            arguments: parseToolArguments(toolCall).value ?? {},
            error: { name: 'BudgetExceeded', message: refusal },
          });
          this.transcriptRepository.appendMessage({
            sessionId,
            role: 'tool',
            content: {
              toolCallId: toolCall.id,
              toolName: toolCall.name,
              result: {
                ok: false,
                error: { name: 'BudgetExceeded', message: refusal },
              },
            },
          });
          continue;
        }

        if (toolCall.name === 'spawn_subagent') {
          if (subagentCount >= maxSubagents) {
            // 子 agent 是独立模型调用，数量必须硬限制。
            // 拒绝而不是放行，但主 Agent 继续跑完 —— 只是不能再委派。
            const refusalMessage: LLMMessage = {
              role: 'tool',
              toolCallId: toolCall.id,
              content: JSON.stringify({
                ok: false,
                error: {
                  name: 'BudgetExceeded',
                  message: `Subagent limit reached (${maxSubagents}). Please summarize your findings instead.`,
                },
              }),
            };
            messages.push(refusalMessage);
            this.transcriptRepository.appendToolCall({
              sessionId,
              messageId: assistantRecord.id,
              toolName: toolCall.name,
              status: 'failed',
              arguments: parseToolArguments(toolCall).value ?? {},
              error: {
                name: 'BudgetExceeded',
                message: `Subagent limit reached (${maxSubagents})`,
              },
            });
            this.transcriptRepository.appendMessage({
              sessionId,
              role: 'tool',
              content: {
                toolCallId: toolCall.id,
                toolName: toolCall.name,
                result: {
                  ok: false,
                  error: {
                    name: 'BudgetExceeded',
                    message: `Subagent limit reached (${maxSubagents})`,
                  },
                },
              },
            });
            continue;
          }
          subagentCount += 1;
        }

        const result = await this.executeTool(toolCall, sessionId, input.model, turns);
        // 终态工具不计入探索配额
        if (!isTerminalTool) {
          toolCalls += 1;
        }
        if (!result.ok) {
          consecutiveToolFailures += 1;
        } else {
          consecutiveToolFailures = 0;
        }

        this.transcriptRepository.appendToolCall({
          sessionId,
          messageId: assistantRecord.id,
          toolName: toolCall.name,
          status: result.ok ? 'completed' : 'failed',
          arguments: parseToolArguments(toolCall).value ?? {},
          result: result.ok ? result.value : undefined,
          error: result.ok ? undefined : result.error,
        });

        const toolMessage: LLMMessage = {
          role: 'tool',
          toolCallId: toolCall.id,
          content: stringifyToolResult(result),
        };
        messages.push(toolMessage);
        this.transcriptRepository.appendMessage({
          sessionId,
          role: 'tool',
          content: {
            toolCallId: toolCall.id,
            toolName: toolCall.name,
            result,
          },
        });

        if (!result.ok && consecutiveToolFailures >= maxConsecutiveToolFailures) {
          return this.finish(
            sessionId,
            'max_consecutive_tool_failures',
            turns,
            toolCalls,
            messages
          );
        }
      }
    }
  }

  private getBudgetStatus(
    input: MainAgentRunInput,
    startedAt: number,
    turns: number,
    emptyResponseCount: number,
    consecutiveToolFailures: number,
    maxEmptyResponses: number,
    maxConsecutiveToolFailures: number
  ): MainAgentTerminalStatus | undefined {
    if (this.isTimedOut(input, startedAt)) return 'timeout_reached';
    // 超时是硬终止：超时后无法再与模型交互，拿不到结论。
    if (emptyResponseCount >= maxEmptyResponses) return 'max_empty_responses';
    if (consecutiveToolFailures >= maxConsecutiveToolFailures)
      return 'max_consecutive_tool_failures';

    // 轮次上限默认关闭（0 = 不限）。保留为可选的兜底 —— 运维需要时
    // 可以在后台配置一个硬上限，但它不会干扰正常的长审查。
    if (input.maxTurns && input.maxTurns > 0 && turns >= input.maxTurns) {
      return 'max_turns_reached';
    }

    return undefined;
  }

  private isTimedOut(input: MainAgentRunInput, startedAt: number): boolean {
    return this.now() - startedAt >= input.timeoutMs;
  }

  /**
   * 转入收尾阶段时给模型的指令。
   */
  private buildFinalizationNotice(
    input: MainAgentRunInput,
    turns: number,
    toolCalls: number
  ): string {
    void input;
    return (
      `[finalize] The review is now in its finalization phase (turns=${turns}, toolCalls=${toolCalls}). ` +
      `No further exploration tools are available. ` +
      `Using the evidence you already gathered, call submit_review_findings now with your conclusions. ` +
      `If you found nothing, submit an empty findings array and a short summary explaining why. ` +
      `Do not attempt any further tool calls other than submitting.`
    );
  }

  /** 收尾阶段拒绝探索工具时回给模型的内容。 */
  private buildFinalizationRefusal(toolName: string): string {
    return JSON.stringify({
      ok: false,
      error: {
        name: 'BudgetExceeded',
        message:
          `Tool '${toolName}' is not available: the review is now in its finalization phase. ` +
          `Call submit_review_findings with the conclusions you have already gathered.`,
      },
    });
  }

  /** 循环检测命中时回给模型的内容。 */
  private buildLoopRefusal(toolName: string): string {
    return JSON.stringify({
      ok: false,
      error: {
        name: 'LoopDetected',
        message:
          `Tool '${toolName}' was called with identical arguments repeatedly and is now blocked. ` +
          `Change your approach — different query, different file, or a different tool — or call ` +
          `submit_review_findings with the conclusions you already have.`,
      },
    });
  }

  /**
   * Trim the conversation when it approaches the context budget.
   *
   * Codex compacts by asking the model to summarise the history. We trim the
   * stale tool payloads instead — a review agent's evidence is already
   * consumed by the time the context grows, and a summary would blur the
   * concrete file/line references that findings must carry.
   */
  private trimMessagesIfNeeded(input: MainAgentRunInput, messages: LLMMessage[]): LLMMessage[] {
    const budget = input.contextTokenBudget;
    if (!budget || budget <= 0) return messages;

    const result = trimContext(messages, {
      budgetTokens: budget,
      threshold: input.contextTrimThreshold,
      keepRecentToolMessages: input.contextKeepRecentToolMessages,
    });

    if (result.trimmedApplied) {
      logger.info('上下文接近预算上限，已裁剪早期工具输出', {
        trimmedMessages: result.trimmed,
        tokensBefore: result.tokensBefore,
        tokensAfter: result.tokensAfter,
        budgetTokens: budget,
      });
    }

    return result.messages;
  }

  private async executeTool(
    toolCall: LLMToolCall,
    sessionId: string,
    model: string,
    turn: number
  ): Promise<ToolExecutionResult> {
    const parsedArguments = parseToolArguments(toolCall);
    if (!parsedArguments.ok) return parsedArguments;

    const tool = this.toolsByName.get(toolCall.name);
    if (!tool) {
      return {
        ok: false,
        error: {
          name: 'ToolNotFoundError',
          message: `Tool '${toolCall.name}' is not registered`,
        },
      };
    }

    try {
      const value = await tool.execute(parsedArguments.value, {
        sessionId,
        model,
        toolCall,
        turn,
      });
      return { ok: true, value };
    } catch (error) {
      return {
        ok: false,
        error: normalizeError(error),
      };
    }
  }

  private finish(
    sessionId: string,
    status: MainAgentTerminalStatus,
    turns: number,
    toolCalls: number,
    messages: LLMMessage[],
    finalText?: string
  ): MainAgentRunResult {
    this.transcriptRepository.completeSession({
      sessionId,
      status: status === 'completed' ? 'completed' : 'failed',
      finalResult: {
        status,
        turns,
        toolCalls,
        finalText,
      },
      error: status === 'completed' ? undefined : { status },
    });

    return {
      status,
      sessionId,
      turns,
      toolCalls,
      finalText,
      messages,
    };
  }
}

export const mainAgentRunner = new MainAgentRunner({
  modelClient: {
    chat: () => {
      throw new Error('MainAgentRunner requires an injected model client');
    },
  },
  transcriptRepository: agentSessionRepository,
});
