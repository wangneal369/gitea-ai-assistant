import { describe, expect, test } from 'bun:test';
import { buildReviewPrompt } from '../review-entrypoint';

/**
 * 三层审查提示词在 Agent 引擎中的拼装与优先级。
 *
 * 这里直接调用 buildReviewPrompt，而不是跑完整审查流程：
 * 全量测试时各测试文件共享进程级的 DB 单例，跑完整流程会读到别的文件写入的数据。
 * DB 层的读取由 src/db/__tests__/repository-review-prompt-repo.test.ts 覆盖。
 */

const PROJECT_MARKER = 'ZZPROJECTPROMPTMARKERZZ';

function makeContext() {
  return {
    reviewRunId: 'run-1',
    sessionScope: 'pr:octo/demo#7',
    eventType: 'pull_request' as const,
    repository: { owner: 'octo', repo: 'demo', cloneUrl: '', headCloneUrl: '' },
    pullRequest: {
      prNumber: 7,
      relatedPrNumber: null,
      baseSha: 'base-sha',
      headSha: 'head-sha',
      commitSha: 'head-sha',
      commitMessage: 'msg',
    },
    workspace: { workspacePath: '/tmp/ws', mirrorPath: '/tmp/ws.git' },
    diffSummary: {
      changedFiles: [{ path: 'src/app.ts', status: 'M' as const, additions: 1, deletions: 0 }],
      diff: 'diff --git a/src/app.ts b/src/app.ts\n+throw new Error("boom")',
    },
  };
}

describe('Agent 引擎的三层审查提示词', () => {
  test('仓库级提示词被拼进提示词', () => {
    const prompt = buildReviewPrompt(makeContext(), 'gpt-4.1', PROJECT_MARKER);
    expect(prompt).toContain(PROJECT_MARKER);
    expect(prompt).toContain('## Project-specific requirements');
  });

  test('优先级声明显式写出：仓库级 > 全局 > 审查原则', () => {
    const prompt = buildReviewPrompt(makeContext(), 'gpt-4.1', PROJECT_MARKER);
    expect(prompt).toContain(
      'Project-specific requirements > Global requirements > Review guidelines'
    );
  });

  test('提交契约不可被提示词覆盖', () => {
    const prompt = buildReviewPrompt(makeContext(), 'gpt-4.1', PROJECT_MARKER);
    expect(prompt).toContain('call submit_review_findings exactly once');
  });

  test('未提供仓库级提示词时，不出现该段落，也不写优先级声明', () => {
    const prompt = buildReviewPrompt(makeContext(), 'gpt-4.1', undefined);
    expect(prompt).not.toContain('## Project-specific requirements');
    expect(prompt).not.toContain('Project-specific requirements >');
  });

  test('diff 内容确实进了提示词', () => {
    const prompt = buildReviewPrompt(makeContext(), 'gpt-4.1', PROJECT_MARKER);
    expect(prompt).toContain('+throw new Error("boom")');
    expect(prompt).toContain('src/app.ts');
  });

  test('审查原则段始终存在（未配置时用内置默认）', () => {
    const prompt = buildReviewPrompt(makeContext(), 'gpt-4.1', undefined);
    expect(prompt).toContain('## Review guidelines');
    expect(prompt).toContain('Review only the supplied change context');
  });
});
