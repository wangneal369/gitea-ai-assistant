import { describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SandboxExec } from '../context/sandbox-exec';

const isWindows = process.platform === 'win32';

describe('SandboxExec Windows 兼容', () => {
  test.skipIf(!isWindows)('PowerShell 5.1 输出中文不乱码', async () => {
    const sandbox = new SandboxExec(['powershell']);
    const result = await sandbox.run(
      'powershell',
      ['-Command', "Write-Output '中文测试：铝电解电容选箔'"],
      { cwd: tmpdir(), timeoutMs: 20000 }
    );
    expect(result.stdout).toContain('中文测试：铝电解电容选箔');
  });

  test.skipIf(!isWindows)('PowerShell 的控制台输出编码被置为 UTF-8', async () => {
    const sandbox = new SandboxExec(['powershell']);
    const result = await sandbox.run(
      'powershell',
      ['-Command', '[Console]::OutputEncoding.WebName'],
      { cwd: tmpdir(), timeoutMs: 20000 }
    );
    expect(result.stdout.trim()).toBe('utf-8');
  });

  test.skipIf(!isWindows)('子进程能读到 SYSTEMROOT 等 Windows 必需变量', async () => {
    const sandbox = new SandboxExec(['powershell']);
    const result = await sandbox.run('powershell', ['-Command', 'Write-Output $env:SYSTEMROOT'], {
      cwd: tmpdir(),
      timeoutMs: 20000,
    });
    expect(result.stdout.trim()).toMatch(/^[A-Za-z]:\\Windows$/);
  });

  test.skipIf(!isWindows)('git 不把中文路径转义成八进制', async () => {
    const workDir = join(tmpdir(), `sandbox-cn-${Date.now()}`);
    mkdirSync(workDir, { recursive: true });
    try {
      const sandbox = new SandboxExec(['git']);
      await sandbox.run('git', ['init'], { cwd: workDir, timeoutMs: 20000 });
      writeFileSync(join(workDir, '中文文件名.txt'), '内容');

      const result = await sandbox.run('git', ['status', '--porcelain'], {
        cwd: workDir,
        timeoutMs: 20000,
      });
      expect(result.stdout).toContain('中文文件名.txt');
      expect(result.stdout).not.toContain('\\344');
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  test.skipIf(!isWindows)('PowerShell -File 脚本也能拿到 UTF-8 前置设置', async () => {
    const workDir = join(tmpdir(), `sandbox-ps1-${Date.now()}`);
    mkdirSync(workDir, { recursive: true });
    try {
      const scriptPath = join(workDir, 'probe.ps1');
      writeFileSync(scriptPath, "Write-Output '脚本中文输出'\n", 'utf8');
      const sandbox = new SandboxExec(['powershell']);
      const result = await sandbox.run('powershell', ['-File', scriptPath], {
        cwd: workDir,
        timeoutMs: 20000,
      });
      expect(result.stdout).toContain('脚本中文输出');
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  test.skipIf(!isWindows)(
    '调用 Windows 上不存在的 Unix 命令时给出 PowerShell 等价写法',
    async () => {
      const sandbox = new SandboxExec(['cat']);
      try {
        await sandbox.run('cat', ['/nonexistent-12345'], { cwd: tmpdir(), timeoutMs: 10000 });
      } catch (error: any) {
        expect(error.message).toContain('Get-Content');
      }
    }
  );

  test.skipIf(isWindows)('非 Windows 平台不注入 PowerShell 前置语句', async () => {
    const sandbox = new SandboxExec(['echo']);
    const result = await sandbox.run('echo', ['plain'], { cwd: tmpdir(), timeoutMs: 10000 });
    expect(result.stdout.trim()).toBe('plain');
  });
});
