import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { access, mkdir, mkdtemp, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LocalRepoManager } from '../local-repo-manager';
import { SandboxExec } from '../sandbox-exec';

/**
 * 回归用例：清理任务与正在 fetch 的审查撞车会留下残缺仓库。
 *
 * 表现是 git 报 "did not send all necessary objects" —— 因为清理把 mirror
 * 删在了 fetch 中途。原实现有两层问题：
 *   1. cleanStaleMirrors 压根没走 acquireMirrorLock
 *   2. 锁表挂在实例上，而 LocalRepoManager 在 controllers/review.ts、
 *      review/engine.ts、review/codex/codex-engine.ts、
 *      review/cleanup-scheduler.ts 四处各自 new —— 清理器与审查引擎
 *      拿到的是两把互不相干的锁，加锁也白加
 *
 * 本文件刻意不依赖真实 git 仓库：只验证锁的互斥语义，
 * 避免 git 子进程的环境问题（本机沙箱跑不动）掩盖断言。
 */

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

describe('LocalRepoManager 清理与并发互斥', () => {
  let tempDir: string;
  let workDir: string;
  let sandbox: SandboxExec;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'mirror-lock-test-'));
    workDir = path.join(tempDir, 'workdir');
    await mkdir(workDir, { recursive: true });
    sandbox = new SandboxExec(['git']);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test('清理与 fetch 并发时不会删掉正在使用的 mirror', async () => {
    const reposRoot = path.join(workDir, 'repos');
    const concurrentMirror = path.join(reposRoot, 'concurrent.git');
    await mkdir(concurrentMirror, { recursive: true });

    // 制造一个「很旧」的 mirror：清理任务会认为它该删
    const staleDate = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    await utimes(concurrentMirror, staleDate, staleDate);

    // 审查侧实例持有这个 mirror 的锁（模拟 fetch 进行中）
    const reviewManager = new LocalRepoManager(workDir, sandbox, 10_000);
    const releaseReviewLock = await reviewManager.acquireMirrorLock(concurrentMirror);

    try {
      // 清理器是另一个实例，必须被同一把锁挡住
      const cleanupManager = new LocalRepoManager(workDir, sandbox, 10_000);
      const cleaning = cleanupManager.cleanStaleMirrors(30);

      // 给清理任务一点时间去尝试删除
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(await pathExists(concurrentMirror)).toBe(true);

      // 审查侧释放锁后，清理任务才可能继续
      releaseReviewLock();
      await cleaning;
    } finally {
      releaseReviewLock();
    }
  });

  test('不同实例之间共享同一把锁', async () => {
    const mirrorPath = path.join(workDir, 'repos', 'shared.git');

    const instanceA = new LocalRepoManager(workDir, sandbox, 10_000);
    const instanceB = new LocalRepoManager(workDir, sandbox, 10_000);

    const releaseA = await instanceA.acquireMirrorLock(mirrorPath);

    let bAcquired = false;
    const pending = instanceB.acquireMirrorLock(mirrorPath).then((releaseB) => {
      bAcquired = true;
      return releaseB;
    });

    await new Promise((resolve) => setTimeout(resolve, 150));
    // B 必须还在排队，说明 A 的锁挡住了它
    expect(bAcquired).toBe(false);

    releaseA();
    const releaseB = await pending;
    expect(bAcquired).toBe(true);
    releaseB();
  });

  test('清理过期 mirror 时会真正删掉它（未加锁时）', async () => {
    const reposRoot = path.join(workDir, 'repos');
    const staleMirror = path.join(reposRoot, 'stale.git');
    await mkdir(staleMirror, { recursive: true });

    const staleDate = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    await utimes(staleMirror, staleDate, staleDate);

    const manager = new LocalRepoManager(workDir, sandbox, 10_000);
    const cleaned = await manager.cleanStaleMirrors(30);

    expect(cleaned).toBe(1);
    expect(await pathExists(staleMirror)).toBe(false);
  });

  test('近期使用过的 mirror 不会被清理', async () => {
    const reposRoot = path.join(workDir, 'repos');
    const recentMirror = path.join(reposRoot, 'recent.git');
    await mkdir(recentMirror, { recursive: true });

    const manager = new LocalRepoManager(workDir, sandbox, 10_000);
    const cleaned = await manager.cleanStaleMirrors(30);

    expect(cleaned).toBe(0);
    expect(await pathExists(recentMirror)).toBe(true);
  });
});
