import { type AgentDefinition, createAgentRegistry } from '../agent-kernel/definitions';
import {
  type MainAgentModelClient,
  MainAgentRunner,
  type MainAgentTool,
} from '../agent-kernel/loop';
import { type AgentSessionRepository, agentSessionRepository } from '../agent-kernel/session';
import { SubagentRunner } from '../agent-kernel/subagents/subagent-runner';
import { createSpawnSubagentTool } from '../agent-kernel/tools';
import config from '../config';
import { DiffExtractor } from '../review/context/diff-extractor';
import type { LocalRepoPaths } from '../review/context/local-repo-manager';
import { LocalRepoManager } from '../review/context/local-repo-manager';
import {
  loadRepositorySkills,
  renderSkillCatalog,
  skillMetadataBudget,
} from '../review/context/repository-skill-loader';
import { tokenCounter } from '../review/context/token-counter';
import { resolveProjectReviewPrompt } from '../review/project-review-prompt';
import { FileReviewStore } from '../review/store/file-review-store';
import type { Finding, ReviewContext, ReviewRun } from '../review/types';
import { logger } from '../utils/logger';
import { applyDeterministicPublishAdapter } from './deterministic-publish-adapter';
import { buildRepairPrompt, parseFindingResponse } from './schema';
import { createReadSkillTool } from './tools/read-skill-tool';
import {
  type ReviewToolState,
  type SubmittedReviewFindings,
  createReviewTaskTools,
  normalizeSubmission,
  parseSubmissionFromText,
} from './tools';

export interface ReviewAgentRepositoryContext {
  owner: string;
  repo: string;
  cloneUrl: string;
  headCloneUrl?: string;
}

export interface ReviewAgentPullRequestContext {
  prNumber?: number;
  relatedPrNumber?: number;
  baseSha?: string;
  headSha?: string;
  commitSha?: string;
  commitMessage?: string;
}

export interface ReviewAgentRunContext {
  reviewRunId: string;
  sessionScope: string;
  eventType: ReviewRun['eventType'];
  repository: ReviewAgentRepositoryContext;
  pullRequest: ReviewAgentPullRequestContext;
  workspace?: Pick<ReviewContext, 'workspacePath' | 'mirrorPath'>;
  diffSummary?: {
    changedFiles: ReviewContext['changedFiles'];
    diff?: string;
  };
}

export interface ReviewAgentEntrypointResult {
  status: 'submitted' | 'completed_without_submission';
  sessionId: string;
  reviewRunId: string;
  sessionScope: string;
  summaryMarkdown: string;
  findings: Finding[];
  finalText?: string;
}

interface ReviewAgentEntrypointOptions {
  store: FileReviewStore;
  localRepoManager: LocalRepoManager;
  diffExtractor: DiffExtractor;
  modelClient: MainAgentModelClient;
  transcriptRepository?: AgentSessionRepository;
  model?: string;
  runnerFactory?: (tools: MainAgentTool[]) => MainAgentRunner;
}

function nowIso(): string {
  return new Date().toISOString();
}

function buildSessionScope(run: ReviewRun): string {
  if (run.prNumber) {
    return `pr:${run.owner}/${run.repo}#${run.prNumber}`;
  }
  if (run.relatedPrNumber) {
    return `pr:${run.owner}/${run.repo}#${run.relatedPrNumber}`;
  }
  return `commit:${run.owner}/${run.repo}@${run.commitSha ?? run.headSha ?? run.id}`;
}

function tryParseFinalSubmission(text?: string): SubmittedReviewFindings | null {
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object') {
      const result = normalizeSubmission(parsed);
      if (result.findings.length > 0 || result.summaryMarkdown) return result;
    }
  } catch {}
  return parseSubmissionFromText(text);
}

const DEFAULT_AGENT_REVIEW_GUIDELINES = [
  'Review only the supplied change context and report actionable correctness, security, reliability, or maintainability findings.',
].join('\n');

const AGENT_OUTPUT_CONTRACT = [
  'You are the main code review agent for Gitea AI Assistant.',
  'When finished, call submit_review_findings exactly once with summaryMarkdown and findings. If no issues are found, submit an empty findings array.',
].join('\n');

export function buildReviewPrompt(
  context: ReviewAgentRunContext,
  model?: string,
  projectPrompt?: string,
  repositorySkills?: string
): string {
  const changedFiles = context.diffSummary?.changedFiles ?? [];
  const fileSummary = changedFiles
    .map((file) => `- ${file.status} ${file.path} (+${file.additions}/-${file.deletions})`)
    .join('\n');
  const rawDiff = context.diffSummary?.diff?.trim() || '(diff omitted)';

  const guidelines = config.review.agentReviewPrompt?.trim() || DEFAULT_AGENT_REVIEW_GUIDELINES;
  const globalPrompt = config.review.globalPrompt?.trim();

  const header = [AGENT_OUTPUT_CONTRACT, '', '## Review guidelines', '', guidelines];

  if (globalPrompt) {
    header.push('', '## Global requirements', '', globalPrompt);
  }

  if (projectPrompt) {
    header.push('', '## Project-specific requirements', '', projectPrompt);
  }

  if (repositorySkills) {
    header.push('', repositorySkills);
  }

  if (globalPrompt || projectPrompt || repositorySkills) {
    header.push(
      '',
      'When requirements conflict: Project-specific requirements > Repository review skills > Global requirements > Review guidelines.'
    );
  }

  header.push(
    '',
    `Review run: ${context.reviewRunId}`,
    `Session scope: ${context.sessionScope}`,
    `Repository: ${context.repository.owner}/${context.repository.repo}`,
    `Event type: ${context.eventType}`,
    `PR: ${context.pullRequest.prNumber ?? context.pullRequest.relatedPrNumber ?? 'n/a'}`,
    `Base SHA: ${context.pullRequest.baseSha ?? 'n/a'}`,
    `Head SHA: ${context.pullRequest.headSha ?? context.pullRequest.commitSha ?? 'n/a'}`,
    '',
    'Changed files:',
    fileSummary || '- none',
    '',
    'Diff:'
  );

  // Reserve room for the header itself plus model output; a long custom prompt
  // shrinks the diff budget instead of silently overflowing the context window.
  const usableBudget = model ? tokenCounter.getUsableBudget(model) : 124_000;
  const headerText = header.join('\n');
  const reservedForPrompt = tokenCounter.count(headerText) + 4000;
  const diffBudget = Math.max(1000, usableBudget - reservedForPrompt);
  const diff =
    tokenCounter.count(rawDiff) > diffBudget ? tokenCounter.clip(rawDiff, diffBudget) : rawDiff;

  return `${headerText}\n${diff}`;
}

function defaultSubagentDefinition(): AgentDefinition {
  return {
    agentType: 'general-purpose',
    name: 'General Purpose Review Subagent',
    whenToUse: 'Use for delegated focused code checks from the review main agent.',
    source: 'built-in',
    tools: ['search_code', 'read_file', 'find_references', 'get_file_patch'],
    disallowedTools: [],
    skills: [],
    hooks: {},
    maxTurns: 4,
    permissionMode: 'default',
    background: false,
    isolation: 'none',
    getSystemPrompt: () =>
      'You are a focused code-review subagent. Read only provided context, use tools deterministically, and return concise risk-focused findings summary.',
  };
}

export class ReviewAgentEntrypoint {
  private readonly store: FileReviewStore;
  private readonly localRepoManager: LocalRepoManager;
  private readonly diffExtractor: DiffExtractor;
  private readonly transcriptRepository: AgentSessionRepository;
  private readonly modelClient: MainAgentModelClient;
  private readonly model: string;
  private readonly runnerFactory: (tools: MainAgentTool[]) => MainAgentRunner;

  constructor(options: ReviewAgentEntrypointOptions) {
    this.store = options.store;
    this.localRepoManager = options.localRepoManager;
    this.diffExtractor = options.diffExtractor;
    this.modelClient = options.modelClient;
    this.transcriptRepository = options.transcriptRepository ?? agentSessionRepository;
    this.model = options.model ?? config.review.agentMainModel;
    this.runnerFactory =
      options.runnerFactory ??
      ((tools) =>
        new MainAgentRunner({
          modelClient: this.modelClient,
          transcriptRepository: this.transcriptRepository,
          tools,
        }));
  }

  async execute(run: ReviewRun): Promise<ReviewAgentEntrypointResult> {
    const targetSha = run.headSha || run.commitSha;
    if (!targetSha) throw new Error('缺少 target sha，无法启动主 Agent 审查');

    const workspaceStart = Date.now();
    await this.store.addStep({
      runId: run.id,
      stepName: 'prepare_workspace',
      status: 'started',
      startedAt: new Date(workspaceStart).toISOString(),
    });

    let repoPaths: LocalRepoPaths | null = null;
    try {
      repoPaths = await this.localRepoManager.prepareWorkspace(
        run.owner,
        run.repo,
        run.cloneUrl,
        targetSha,
        run.id,
        run.headCloneUrl
      );
      await this.store.addStep({
        runId: run.id,
        stepName: 'prepare_workspace',
        status: 'succeeded',
        startedAt: new Date(workspaceStart).toISOString(),
        finishedAt: nowIso(),
        latencyMs: Date.now() - workspaceStart,
      });

      const lastReviewedHead = await this.resolveLastReviewedHead(
        run,
        repoPaths.mirrorPath,
        targetSha
      );
      const contextStart = Date.now();
      await this.store.addStep({
        runId: run.id,
        stepName: 'build_context',
        status: 'started',
        startedAt: new Date(contextStart).toISOString(),
      });
      const reviewContext = await this.diffExtractor.buildContext(
        run,
        repoPaths.mirrorPath,
        repoPaths.workspacePath,
        lastReviewedHead
      );
      await this.store.addStep({
        runId: run.id,
        stepName: 'build_context',
        status: 'succeeded',
        startedAt: new Date(contextStart).toISOString(),
        finishedAt: nowIso(),
        latencyMs: Date.now() - contextStart,
      });

      if (!reviewContext.diff.trim()) {
        await this.store.addCommentRecord({
          runId: run.id,
          body: '本次变更无可审查差异内容，已跳过自动行级评论。',
          status: 'pending',
        });
        await this.store.markRunIgnored(run.id, '无可审查差异');
        return {
          status: 'completed_without_submission',
          sessionId: '',
          reviewRunId: run.id,
          sessionScope: buildSessionScope(run),
          summaryMarkdown: '',
          findings: [],
        };
      }

      // 仓库级提示词只读一次，放在 agent 循环之外，避免在会话进行中反复触碰 DB
      const projectPrompt = resolveProjectReviewPrompt(run.owner, run.repo)?.trim();
      const result = await this.runMainAgent(run, reviewContext, projectPrompt);      if (run.eventType === 'pull_request' && run.prNumber && run.baseSha) {
        await this.localRepoManager.saveReviewedRef(
          repoPaths.mirrorPath,
          run.prNumber,
          run.baseSha,
          targetSha
        );
      }
      return result;
    } finally {
      if (repoPaths) {
        await this.localRepoManager.cleanupWorkspace(repoPaths);
      }
    }
  }

  private async resolveLastReviewedHead(
    run: ReviewRun,
    mirrorPath: string,
    targetSha: string
  ): Promise<string | undefined> {
    if (run.eventType !== 'pull_request' || !run.prNumber) return undefined;
    const snapshot = await this.localRepoManager.resolveReviewedRef(mirrorPath, run.prNumber);
    if (!snapshot || snapshot.baseSha !== run.baseSha || snapshot.headSha === targetSha)
      return undefined;
    return snapshot.headSha;
  }

  private async repairFindingsWithLLM(
    rawText: string,
    messages: Array<{ role: string; content: string; toolCalls?: unknown }>,
    maxAttempts = 2
  ): Promise<string> {
    let current = rawText;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const outcome = parseFindingResponse(current);
      if (outcome.ok) return current;
      const repairPrompt = buildRepairPrompt(outcome.error);
      messages.push({ role: 'assistant', content: current });
      messages.push({ role: 'user', content: repairPrompt });
      const response = await this.modelClient.chat({
        messages: messages as import('../llm/types').LLMMessage[],
        model: this.model,
        temperature: 0,
        responseFormat: 'json',
      });
      current = response.content ?? '{"findings":[]}';
      logger.info('LLM finding repair attempt', {
        attempt: attempt + 1,
        error: outcome.error.slice(0, 100),
      });
    }
    return current;
  }

  private async runMainAgent(
    run: ReviewRun,
    reviewContext: ReviewContext,
    projectPrompt?: string
  ): Promise<ReviewAgentEntrypointResult> {
    const sessionScope = buildSessionScope(run);
    const reviewToolState: ReviewToolState = { submittedReview: null };
    const reviewTools = createReviewTaskTools({ reviewContext, state: reviewToolState });

    // 仓库自带技能：只把「目录」（名称+描述+路径）注入提示词，
    // 正文由 read_skill 工具按需读取 —— 与 Codex 的渐进式披露一致，
    // 避免长技能正文挤掉真正的审查材料（diff）。
    const skillsEnabled = config.review.repositorySkills;
    const skillContext = skillsEnabled
      ? await loadRepositorySkills(reviewContext.workspacePath)
      : { catalog: { skills: [], errors: [] }, catalogChars: 0, omitted: 0 };
    const skillCatalogSection = renderSkillCatalog(
      skillContext.catalog.skills,
      skillMetadataBudget(tokenCounter.getContextWindow(this.model))
    ).section;

    const subagentRunner = new SubagentRunner({
      modelClient: this.modelClient,
      transcriptRepository: this.transcriptRepository,
      tools: reviewTools,
    });
    const spawnSubagentTool = createSpawnSubagentTool({
      agentRegistry: createAgentRegistry({ builtIn: [defaultSubagentDefinition()] }),
      executor: subagentRunner,
      defaultSubagentModel: config.review.agentDefaultSubagentModel,
    });

    const tools: MainAgentTool[] = [...reviewTools, spawnSubagentTool];
    if (skillContext.catalog.skills.length > 0) {
      tools.push(createReadSkillTool({ skills: skillContext.catalog.skills }));
    }

    const runner = this.runnerFactory(tools);

    const runContext: ReviewAgentRunContext = {
      reviewRunId: run.id,
      sessionScope,
      eventType: run.eventType,
      repository: {
        owner: run.owner,
        repo: run.repo,
        cloneUrl: run.cloneUrl,
        headCloneUrl: run.headCloneUrl,
      },
      pullRequest: {
        prNumber: run.prNumber,
        relatedPrNumber: run.relatedPrNumber,
        baseSha: run.baseSha,
        headSha: run.headSha,
        commitSha: run.commitSha,
        commitMessage: run.commitMessage,
      },
      workspace: {
        workspacePath: reviewContext.workspacePath,
        mirrorPath: reviewContext.mirrorPath,
      },
      diffSummary: {
        changedFiles: reviewContext.changedFiles,
        diff: reviewContext.diff,
      },
    };
    const agentResult = await runner.run({
      agentType: 'review-main-agent',
      model: this.model,
      userMessage: buildReviewPrompt(runContext, this.model, projectPrompt, skillCatalogSection),
      maxTurns: config.review.maxTurns,
      maxToolCalls: config.review.maxToolCalls,
      maxSubagents: config.review.maxSubagents,
      loopGuardThreshold: config.review.loopGuardThreshold,
      timeoutMs: config.review.commandTimeoutMs,
      maxEmptyResponses: 2,
      maxConsecutiveToolFailures: 3,
      // 上下文预算：显式配置优先，否则按模型上下文窗口的 65% 推导，
      // 与 Codex 的自动压缩阈值一致（DEFAULT_ASYNC_COMPACTION_THRESHOLD_PERCENT）。
      contextTokenBudget:
        config.review.contextTokenBudget > 0
          ? config.review.contextTokenBudget
          : Math.floor(tokenCounter.getUsableBudget(this.model) * 0.65),
      session: {
        agentType: 'review-main-agent',
        metadata: {
          reviewRunId: run.id,
          sessionScope,
          owner: run.owner,
          repo: run.repo,
          prNumber: run.prNumber,
          relatedPrNumber: run.relatedPrNumber,
          eventType: run.eventType,
          baseSha: run.baseSha,
          headSha: run.headSha,
          commitSha: run.commitSha,
        },
      },
    });

    const submitted =
      reviewToolState.submittedReview ?? tryParseFinalSubmission(agentResult.finalText);
    let submission: SubmittedReviewFindings;

    if (submitted) {
      submission = submitted;
    } else if (agentResult.finalText) {
      const repaired = await this.repairFindingsWithLLM(
        agentResult.finalText,
        agentResult.messages
      );
      const repairedSubmission = tryParseFinalSubmission(repaired);
      submission = repairedSubmission ?? { summaryMarkdown: agentResult.finalText, findings: [] };
    } else {
      submission = { summaryMarkdown: '', findings: [] };
    }
    const adapted = await applyDeterministicPublishAdapter({
      store: this.store,
      runId: run.id,
      submission,
    });

    logger.info('主 Agent 审查入口完成', {
      runId: run.id,
      sessionId: agentResult.sessionId,
      sessionScope,
      findings: adapted.findings.length,
    });

    return {
      status: submitted ? 'submitted' : 'completed_without_submission',
      sessionId: agentResult.sessionId,
      reviewRunId: run.id,
      sessionScope,
      summaryMarkdown: submission.summaryMarkdown,
      findings: adapted.findings,
      finalText: agentResult.finalText,
    };
  }
}
