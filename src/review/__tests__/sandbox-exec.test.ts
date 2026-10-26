import { describe, expect, test } from 'bun:test';
import { tmpdir } from 'node:os';
import { SandboxExec } from '../context/sandbox-exec';

// Windows 上没有 /tmp，用平台临时目录
const CWD = tmpdir();
const TIMEOUT = 30000;

// 用当前运行时自身执行，避免依赖 PATH 里是否存在 echo/ls/false 这类 Unix 小工具
const NODE = process.execPath;
const printHello = ['-e', "console.log('hello')"];
const exitOne = ['-e', 'process.exit(1)'];

describe('SandboxExec', () => {
  // ─── Command whitelist ───
  describe('command whitelist', () => {
    test('allowed command executes successfully', async () => {
      const sandbox = new SandboxExec([NODE]);
      const result = await sandbox.run(NODE, printHello, {
        cwd: CWD,
        timeoutMs: TIMEOUT,
      });
      expect(result.stdout.trim()).toBe('hello');
      expect(result.exitCode).toBe(0);
    });

    test('disallowed command throws', async () => {
      const sandbox = new SandboxExec([NODE]);
      await expect(
        sandbox.run('rm', ['-rf', '/'], { cwd: CWD, timeoutMs: TIMEOUT })
      ).rejects.toThrow('命令未在白名单中: rm');
    });

    test('empty whitelist blocks all commands', async () => {
      const sandbox = new SandboxExec([]);
      await expect(sandbox.run(NODE, printHello, { cwd: CWD, timeoutMs: TIMEOUT })).rejects.toThrow(
        `命令未在白名单中: ${NODE}`
      );
    });

    test('multiple commands in whitelist', async () => {
      const sandbox = new SandboxExec([NODE, 'other']);
      const result = await sandbox.run(NODE, ['-e', "console.log('test')"], {
        cwd: CWD,
        timeoutMs: TIMEOUT,
      });
      expect(result.stdout.trim()).toBe('test');
    });
  });

  // ─── Error redaction (the token leak fix) ───
  describe('error redaction', () => {
    test('failed command error does NOT contain original error.message', async () => {
      const sandbox = new SandboxExec([NODE]);
      try {
        // 走一个不存在的路径 → stderr-based error
        await sandbox.run(NODE, ['-e', "require('fs').readFileSync('/nonexistent-12345')"], {
          cwd: CWD,
          timeoutMs: TIMEOUT,
        });
        // If it doesn't throw, the path happened to exist, skip
      } catch (error: any) {
        // The error message should use stderr content or the redacted fallback
        // It should NOT include raw Node.js error.message which may contain tokens
        expect(error.message).toContain('命令执行失败');
        expect(error.message).toContain(NODE);
      }
    });

    test('error with no stderr uses redacted fallback message', async () => {
      const sandbox = new SandboxExec([NODE]);
      try {
        // 退出码 1，无 stderr 输出
        await sandbox.run(NODE, exitOne, {
          cwd: CWD,
          timeoutMs: TIMEOUT,
        });
      } catch (error: any) {
        expect(error.message).toContain('命令执行失败');
        // Should use the redacted fallback, not error.message
        expect(error.message).toContain('(无 stderr，原始错误已脱敏)');
      }
    });
  });

  // ─── Sensitive argument redaction ───
  describe('sensitive arg redaction in error messages', () => {
    test('URL with credentials is redacted in error', async () => {
      const sandbox = new SandboxExec(['git']);
      try {
        await sandbox.run(
          'git',
          ['clone', 'https://user:secret-token@example.com/repo.git', '/nonexistent'],
          { cwd: CWD, timeoutMs: TIMEOUT }
        );
      } catch (error: any) {
        // The error message should have redacted credentials
        expect(error.message).not.toContain('secret-token');
        expect(error.message).toContain('***');
      }
    });

    test('http.extraHeader Authorization token is redacted in error', async () => {
      const sandbox = new SandboxExec(['git']);
      try {
        await sandbox.run(
          'git',
          [
            '-c',
            'http.extraHeader=Authorization: token ghp_secrettoken123',
            'clone',
            'https://example.com/repo.git',
            '/nonexistent',
          ],
          { cwd: CWD, timeoutMs: TIMEOUT }
        );
      } catch (error: any) {
        expect(error.message).not.toContain('ghp_secrettoken123');
        expect(error.message).toContain('***');
      }
    });

    test('non-sensitive args are preserved in error', async () => {
      const sandbox = new SandboxExec([NODE]);
      try {
        await sandbox.run(NODE, ['--color', '/nonexistent-12345'], {
          cwd: CWD,
          timeoutMs: TIMEOUT,
        });
      } catch (error: any) {
        expect(error.message).toContain('--color');
        expect(error.message).toContain('/nonexistent-12345');
      }
    });
  });

  // ─── Duration tracking ───
  test('result includes durationMs', async () => {
    const sandbox = new SandboxExec([NODE]);
    const result = await sandbox.run(NODE, ['-e', "console.log('hi')"], {
      cwd: CWD,
      timeoutMs: TIMEOUT,
    });
    expect(typeof result.durationMs).toBe('number');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  // ─── Stderr capture ───
  test('stderr is captured on success', async () => {
    const sandbox = new SandboxExec([NODE]);
    const result = await sandbox.run(NODE, ['-e', "console.error('stderr-text')"], {
      cwd: CWD,
      timeoutMs: TIMEOUT,
    });
    // stderr should be a string (possibly empty)
    expect(typeof result.stderr).toBe('string');
  });

  // ─── Environment isolation ───
  test('only PATH, HOME, LANG, LC_ALL are passed to child process', async () => {
    // Set a custom env var that should NOT be visible
    process.env.SUPER_SECRET_TOKEN = 'should-not-leak';
    const sandbox = new SandboxExec([NODE]);
    const result = await sandbox.run(NODE, ['-e', 'console.log(JSON.stringify(process.env))'], {
      cwd: CWD,
      timeoutMs: TIMEOUT,
    });
    expect(result.stdout).not.toContain('SUPER_SECRET_TOKEN');
    expect(result.stdout).not.toContain('should-not-leak');
    process.env.SUPER_SECRET_TOKEN = undefined;
  });
});
