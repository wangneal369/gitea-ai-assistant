import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** 向上查找 package.json 的最大层级，覆盖 src/utils、dist/utils 两种运行位置 */
const MAX_LOOKUP_DEPTH = 4;

function readVersionFrom(filePath: string): string | null {
  try {
    const raw = readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw) as { version?: unknown };

    if (typeof parsed.version === 'string' && parsed.version.trim() !== '') {
      return parsed.version.trim();
    }
  } catch {
    // 文件不存在或不是合法 JSON，交给上层继续向上查找
  }

  return null;
}

function resolveAppVersion(): string {
  let currentDir = __dirname;

  for (let depth = 0; depth <= MAX_LOOKUP_DEPTH; depth += 1) {
    const candidate = join(currentDir, 'package.json');

    if (existsSync(candidate)) {
      const version = readVersionFrom(candidate);
      if (version) return version;
    }

    const parentDir = dirname(currentDir);
    if (parentDir === currentDir) break;

    currentDir = parentDir;
  }

  return 'unknown';
}

/**
 * 应用版本号，唯一来源是 package.json 的 version 字段，避免多处硬编码导致漂移。
 * 源码直跑（src/utils → 仓库根）与容器内运行（/app/src/utils → /app）均可命中。
 */
export const APP_VERSION = resolveAppVersion();
