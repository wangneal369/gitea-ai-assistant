import { describe, expect, test } from 'bun:test';
import type { LLMChatRequest, LLMChatResponse } from '../../../llm/types';
import { MainAgentRunner } from '../main-agent-runner';
import type { MainAgentModelClient, MainAgentTool } from '../types';

/**
 * 回归用例：工具调用预算耗尽时，整轮审查不能「跑完了却没结论」。
 *
 * 背景（两个独立缺陷）：
 *   1. 触顶时 main-agent-runner 走的是 finish(..., 'max_tool_calls_reached')
 *      且不传 finalText —— 模型已经写出的正文被丢掉，上层拿到空结论。
 *   2. 提交动作 submit_review_findings 也算一次工具调用。模型用完 4 次
 *      探索额度后正好卡在调不出 submit 的临界点，整轮白跑。
 */

function response(partial: Partial<LLMChatResponse>): LLMChatResponse {
  return {
    content: partial.content ?? null,
    toolCalls: partial.toolCalls ?? [],
    finishReason: partial.finishReason ?? 'stop',
    usage: partial.usage ?? {
      promptTokens: 1,
      completionTokens: 1,
      totalTokens: 2,
    },
  };
}

class FakeModelClient implements MainAgentModelClient {
  requests: LLMChatRequest[] = [];

  constructor(private readonly responses: LLMChatResponse[]) {}

  async chat(request: LLMChatRequest): Promise<LLMChatResponse> {
    this.requests.push(structuredClone(request));
    const next = this.responses.shift();
    if (!next) throw new Error('No fake model response queued');
    return next;
  }
}

/** 内存版 transcript repository，避免碰数据库（跨文件共享 DB 单例会串扰） */
function createMemoryRepository() {
  const sessions = new Map<string, { status: string; finalResult?: unknown }>();
  const messages: { sessionId: string; role: string; content: unknown }[] = [];
  const toolCalls: { sessionId: string; toolName: string; status?: string }[] = [];

  return {
    sessions,
    messages,
    toolCalls,
    createSession(_input: { agentType?: string; model?: string }) {
      const id = `session-${sessions.size + 1}`;
      sessions.set(id, { status: 'running' });
      return { id } as never;
    },
    appendMessage(input: { sessionId: string; role: string; content: unknown }) {
      messages.push({ sessionId: input.sessionId, role: input.role, content: input.content });
      return { id: `message-${messages.length}` } as never;
    },
    appendToolCall(input: {
      sessionId: string;
      toolName: string;
      status?: string;
      result?: unknown;
    }) {
      toolCalls.push({
        sessionId: input.sessionId,
        toolName: input.toolName,
        status: input.status,
      });
      return { id: `toolcall-${toolCalls.length}` } as never;
    },
    completeSession(input: { sessionId: string; status: string; finalResult?: unknown }) {
      const session = sessions.get(input.sessionId);
      if (session) {
        session.status = input.status;
        session.finalResult = input.finalResult;
      }
      return { id: input.sessionId } as never;
    },
  };
}

const exploreTool: MainAgentTool = {
  definition: {
    name: 'explore',
    description: 'Explore the change context.',
    parameters: { type: 'object' },
  },
  execute: () => ({ ok: true }),
};

const submitTool: MainAgentTool = {
  definition: {
    name: 'submit_review_findings',
    description: 'Submit the final review summary.',
    parameters: { type: 'object' },
  },
  isTerminal: true,
  execute: () => ({ accepted: true }),
};

describe('MainAgentRunner 预算耗尽时的结论保全', () => {
  test('触顶时保留模型已写出的正文，不让结论凭空消失', async () => {
    const modelClient = new FakeModelClient([
      response({
        content: '我已确认改动集中在鉴权分支，结论如下……',
        finishReason: 'tool_calls',
        toolCalls: [{ id: 'c1', name: 'explore', arguments: '{}' }],
      }),
      response({
        content: null,
        finishReason: 'tool_calls',
        toolCalls: [{ id: 'c2', name: 'explore', arguments: '{}' }],
      }),
    ]);
    const repository = createMemoryRepository();
    const runner = new MainAgentRunner({
      modelClient,
      transcriptRepository: repository as never,
      tools: [exploreTool],
    });

    const result = await runner.run({
      model: 'mock-model',
      userMessage: '审查这段改动',
      maxTurns: 10,
      maxToolCalls: 1,
      timeoutMs: 60_000,
    });

    expect(result.status).toBe('max_tool_calls_reached');
    // 关键断言：正文没被丢掉
    expect(result.finalText).toBe('我已确认改动集中在鉴权分支，结论如下……');
    expect(result.toolCalls).toBe(1);
  });

  test('终态工具不占探索额度，用完额度后仍能提交结论', async () => {
    const modelClient = new FakeModelClient([
      response({
        finishReason: 'tool_calls',
        toolCalls: [{ id: 'c1', name: 'explore', arguments: '{}' }],
      }),
      response({
        finishReason: 'tool_calls',
        toolCalls: [{ id: 'c2', name: 'explore', arguments: '{}' }],
      }),
      response({
        finishReason: 'tool_calls',
        toolCalls: [{ id: 'c3', name: 'submit_review_findings', arguments: '{}' }],
      }),
      response({ content: '审查完成' }),
    ]);
    const repository = createMemoryRepository();
    const runner = new MainAgentRunner({
      modelClient,
      transcriptRepository: repository as never,
      tools: [exploreTool, submitTool],
    });

    const result = await runner.run({
      model: 'mock-model',
      userMessage: '审查这段改动',
      maxTurns: 10,
      maxToolCalls: 2,
      timeoutMs: 60_000,
    });

    // 探索额度 2 次已用尽，但 submit 是终态工具，照样执行了
    expect(result.status).toBe('completed');
    expect(result.finalText).toBe('审查完成');
    // 终态工具不计入配额
    expect(result.toolCalls).toBe(2);
    expect(repository.toolCalls.map((call) => call.toolName)).toEqual([
      'explore',
      'explore',
      'submit_review_findings',
    ]);
  });

  test('探索额度耗尽且模型仍想探索时，终态提交依然放行', async () => {
    // 模型在同一轮里既想继续探索又想提交：探索被预算挡住，提交必须放行
    const modelClient = new FakeModelClient([
      response({
        finishReason: 'tool_calls',
        toolCalls: [
          { id: 'c1', name: 'explore', arguments: '{}' },
          { id: 'c2', name: 'submit_review_findings', arguments: '{}' },
        ],
      }),
      response({ content: '已提交' }),
    ]);
    const repository = createMemoryRepository();
    const runner = new MainAgentRunner({
      modelClient,
      transcriptRepository: repository as never,
      tools: [exploreTool, submitTool],
    });

    const result = await runner.run({
      model: 'mock-model',
      userMessage: '审查这段改动',
      maxTurns: 10,
      maxToolCalls: 1,
      timeoutMs: 60_000,
    });

    expect(result.status).toBe('completed');
    expect(result.finalText).toBe('已提交');
    expect(repository.toolCalls.map((call) => call.toolName)).toEqual([
      'explore',
      'submit_review_findings',
    ]);
  });
});
