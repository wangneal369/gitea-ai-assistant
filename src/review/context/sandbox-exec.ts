import { execFile } from 'node:child_process';

export interface SandboxCommandResult {
  stdout: string;
  stderr: string;
  durationMs: number;
  exitCode: number;
}

export interface SandboxRunOptions {
  cwd: string;
  timeoutMs: number;
}

/**
 * PowerShell 可执行文件名。Windows 自带的是 Windows PowerShell 5.1，
 * PowerShell 7+ 用 pwsh。两者都需要单独处理编码，行为却不同。
 */
const POWERSHELL_EXECUTABLES = new Set(['powershell', 'powershell.exe', 'pwsh', 'pwsh.exe']);

/**
 * PowerShell 前置语句：强制 UTF-8 输出。
 *
 * Windows PowerShell 5.1 默认按系统 ANSI 代码页输出（简体中文机器是 GBK/936），
 * 中文在日志、模型上下文、审查结论里全是乱码；PowerShell 6 起才默认 UTF-8。
 * 两行都得设：$OutputEncoding 管管道输入，[Console]::OutputEncoding 管 stdout。
 */
const POWERSHELL_UTF8_PRELUDE =
  '$OutputEncoding = [Console]::OutputEncoding = [Text.Encoding]::UTF8;';

/**
 * Windows 上通常不存在的 Unix 命令 → 对应的 PowerShell 写法。
 *
 * 只在命令执行失败时作为提示附在错误信息里，不做自动改写：
 * Git for Windows 自带 usr/bin，那边的 cat/sed/grep 是能用的，
 * 一刀切地拦截反而会误伤。
 */
const WINDOWS_UNIX_COMMAND_HINTS: Record<string, string> = {
  cat: 'Get-Content -Raw -LiteralPath <path>',
  head: 'Get-Content -LiteralPath <path> -TotalCount <n>',
  tail: 'Get-Content -LiteralPath <path> -Tail <n>',
  wc: '(Get-Content -LiteralPath <path>).Count',
  grep: 'Select-String -Path <path> -Pattern <pattern>',
  ls: 'Get-ChildItem -LiteralPath <path>',
  find: 'Get-ChildItem -LiteralPath <path> -Recurse',
  sed: 'Windows 无 sed，请改用 Select-String 或 -replace',
};

/**
 * Windows 子进程必需的环境变量。
 *
 * 原来的实现在所有平台只保留 PATH/HOME/LANG/LC_ALL。
 * Windows 上这会导致子进程缺少 SYSTEMROOT 等变量，
 * 表现为「系统找不到指定的路径」、找不到用户目录、临时目录不可写等诡异错误。
 */
const WINDOWS_REQUIRED_ENV_KEYS = [
  'SystemRoot',
  'SystemDrive',
  'windir',
  'COMSPEC',
  'PATHEXT',
  'TEMP',
  'TMP',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMDATA',
  'ProgramFiles',
  'ProgramFiles(x86)',
  'ProgramW6432',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
  'PROCESSOR_IDENTIFIER',
  'OS',
];

export class SandboxExec {
  private readonly allowedCommands: Set<string>;

  constructor(allowedCommands: string[]) {
    this.allowedCommands = new Set(allowedCommands);
  }

  /**
   * Redact敏感信息（如URLs中的token、git config中的认证header）以防止泄露到日志
   */
  private redactSensitiveArgs(args: string[]): string[] {
    return args.map((arg) => {
      // Redact git config中的http.extraHeader认证token
      if (arg.includes('http.extraHeader=Authorization:')) {
        return arg.replace(/(Authorization:\s*token\s+)[^\s]+/i, '$1***');
      }

      try {
        // 检测URL格式并redact认证信息
        const url = new URL(arg);
        if (url.username || url.password) {
          url.username = '***';
          url.password = '***';
          return url.toString();
        }
      } catch {
        // 不是URL，保持原样
      }
      return arg;
    });
  }

  /**
   * 构造子进程环境变量。
   *
   * Linux/macOS：只保留 PATH/HOME/LANG/LC_ALL，隔离其余变量。
   * Windows：额外保留系统必需变量，否则 git / powershell 可能起不来。
   */
  private buildEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      LANG: process.env.LANG,
      LC_ALL: process.env.LC_ALL,
    };

    if (process.platform !== 'win32') {
      return env;
    }

    for (const key of WINDOWS_REQUIRED_ENV_KEYS) {
      const value = process.env[key];
      if (value !== undefined && env[key] === undefined) {
        env[key] = value;
      }
    }

    // TEMP/TMP 缺失会让子进程找不到临时目录
    if (!env.TEMP) env.TEMP = process.env.TEMP ?? 'C:\\Windows\\Temp';
    if (!env.TMP) env.TMP = env.TEMP;

    return env;
  }

  /**
   * 给 PowerShell 调用注入 UTF-8 前置语句。
   *
   * -Command <script>：直接在脚本前拼上编码设置
   * -File <path> [args]：读成 UTF-8 文本后用 ScriptBlock 执行，参数原样透传
   * 都没给：补一条空的 -Command，让编码设置至少生效
   *
   * -File 之所以不直接交给 powershell.exe：Windows PowerShell 5.1 读取 .ps1 文件时，
   * 没有 BOM 就按系统 ANSI 代码页（简体中文机器是 GBK）解码，
   * UTF-8 写的脚本内容会变成 "鑴氭湰涓枃杈撳嚭" 这样的乱码。
   */
  private withPowerShellPrelude(args: string[]): string[] {
    const commandIndex = args.indexOf('-Command');
    if (commandIndex >= 0) {
      const script = args.slice(commandIndex + 1).join(' ');
      return [...args.slice(0, commandIndex + 1), `${POWERSHELL_UTF8_PRELUDE} ${script}`];
    }

    const fileIndex = args.indexOf('-File');
    if (fileIndex >= 0) {
      const scriptPath = args[fileIndex + 1] ?? '';
      const scriptArgs = args.slice(fileIndex + 2);
      const quotedPath = scriptPath.replace(/'/g, "''");
      const passthrough = scriptArgs.map((arg) => `'${arg.replace(/'/g, "''")}'`).join(',');
      const script = [
        POWERSHELL_UTF8_PRELUDE,
        `$__raw = Get-Content -Raw -Encoding UTF8 -LiteralPath '${quotedPath}';`,
        // 文件其实是 ANSI 编码时（无 BOM 的老脚本）退回系统默认编码再读一次
        `if ($__raw -match '\\uFFFD') { $__raw = Get-Content -Raw -Encoding Default -LiteralPath '${quotedPath}' };`,
        '$__sb = [ScriptBlock]::Create($__raw);',
        `& $__sb${passthrough ? ` @(${passthrough})` : ''}`,
      ].join(' ');
      return ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script];
    }

    return [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      POWERSHELL_UTF8_PRELUDE,
    ];
  }

  /**
   * 解码子进程输出。
   *
   * Windows 上并非所有程序都输出 UTF-8：老程序、部分 .NET 程序、Windows PowerShell 5.1
   * 的默认输出都是系统 ANSI 代码页（GBK）。按 UTF-8 解会得到满屏 U+FFFD 替换字符。
   * 这里做一次兜底：UTF-8 解码出现替换字符时，改用 GBK 再解一次，
   * 只要 GBK 解得干净就采用它。
   */
  private decodeOutput(buffer: Buffer): string {
    const utf8Text = buffer.toString('utf8');
    if (!utf8Text.includes('\uFFFD')) {
      return utf8Text;
    }

    if (process.platform === 'win32') {
      for (const encoding of ['gbk', 'gb18030']) {
        try {
          // TextDecoder 的 TS 类型不含 gbk，运行时是支持的（WHATWG Encoding / full-icu）
          const decoded = new TextDecoder(encoding as never).decode(buffer);
          if (!decoded.includes('\uFFFD')) {
            return decoded;
          }
        } catch {
          // 该运行时不支持此编码，继续尝试下一个
        }
      }
    }

    return utf8Text;
  }

  /**
   * 平台适配：在真正执行前调整命令与参数。
   */
  private adaptForPlatform(command: string, args: string[]): { command: string; args: string[] } {
    if (process.platform !== 'win32') {
      return { command, args };
    }

    const lower = command.toLowerCase();

    // git 在 Windows 上默认把非 ASCII 路径转义成八进制（"\346\226\207.jpg"），
    // 中文路径的仓库会看到一堆不可读的输出；日志输出编码同理跟随系统代码页。
    if (lower === 'git') {
      return {
        command,
        args: ['-c', 'core.quotepath=false', '-c', 'i18n.logOutputEncoding=UTF-8', ...args],
      };
    }

    // PowerShell：注入 UTF-8 前置语句，规避 Windows PowerShell 5.1 的中文乱码
    if (POWERSHELL_EXECUTABLES.has(lower)) {
      return { command, args: this.withPowerShellPrelude(args) };
    }

    return { command, args };
  }

  async run(
    command: string,
    args: string[],
    options: SandboxRunOptions
  ): Promise<SandboxCommandResult> {
    if (!this.allowedCommands.has(command)) {
      throw new Error(`命令未在白名单中: ${command}`);
    }

    const startedAt = Date.now();
    const { command: execCommand, args: execArgs } = this.adaptForPlatform(command, args);

    return new Promise<SandboxCommandResult>((resolve, reject) => {
      execFile(
        execCommand,
        execArgs,
        {
          cwd: options.cwd,
          timeout: options.timeoutMs,
          maxBuffer: 1024 * 1024 * 16,
          windowsHide: true,
          encoding: 'buffer',
          env: this.buildEnv(),
        },
        (error, stdout, stderr) => {
          const durationMs = Date.now() - startedAt;
          const stdoutText = this.decodeOutput(
            Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout ?? '')
          );
          const stderrText = this.decodeOutput(
            Buffer.isBuffer(stderr) ? stderr : Buffer.from(stderr ?? '')
          );
          if (error) {
            const code = typeof error.code === 'number' ? error.code : -1;
            // Redact敏感参数（如带token的URLs）以防止凭证泄露到日志和持久化错误
            const redactedArgs = this.redactSensitiveArgs(execArgs);
            const hint =
              process.platform === 'win32'
                ? WINDOWS_UNIX_COMMAND_HINTS[command.toLowerCase()]
                : undefined;
            const hintText = hint ? `；Windows 等价写法: ${hint}` : '';
            reject(
              new Error(
                `命令执行失败: ${command} ${redactedArgs.join(' ')}; code=${code}; stderr=${stderrText || '(无 stderr，原始错误已脱敏)'}${hintText}`
              )
            );
            return;
          }

          resolve({
            stdout: stdoutText,
            stderr: stderrText,
            durationMs,
            exitCode: 0,
          });
        }
      );
    });
  }
}
