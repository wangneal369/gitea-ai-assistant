import { describe, expect, test } from 'bun:test';

import { buildLoopWarningMessage, createLoopDetector } from '../loop-detection';

describe('循环检测', () => {
  test('相同工具 + 相同参数连续调用达到阈值时判定为循环', () => {
    const detector = createLoopDetector({ threshold: 3 });

    expect(detector.record('read_file', { path: 'src/a.ts' })).toBe(false);
    expect(detector.record('read_file', { path: 'src/a.ts' })).toBe(false);
    // 第 3 次命中阈值
    expect(detector.record('read_file', { path: 'src/a.ts' })).toBe(true);
  });

  test('参数不同不算循环', () => {
    const detector = createLoopDetector({ threshold: 3 });

    for (const path of ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts']) {
      expect(detector.record('read_file', { path })).toBe(false);
    }
  });

  test('工具不同不算循环', () => {
    const detector = createLoopDetector({ threshold: 3 });

    expect(detector.record('read_file', { path: 'x' })).toBe(false);
    expect(detector.record('search_code', { path: 'x' })).toBe(false);
    expect(detector.record('find_references', { path: 'x' })).toBe(false);
    expect(detector.record('read_file', { path: 'x' })).toBe(false);
  });

  test('中间插入其它调用会重置连续计数', () => {
    const detector = createLoopDetector({ threshold: 3 });

    expect(detector.record('read_file', { path: 'a' })).toBe(false);
    expect(detector.record('read_file', { path: 'a' })).toBe(false);
    // 换个工具，连续计数归零
    expect(detector.record('search_code', { query: 'x' })).toBe(false);
    expect(detector.consecutiveRepeats).toBe(1);
    expect(detector.record('read_file', { path: 'a' })).toBe(false);
    expect(detector.record('read_file', { path: 'a' })).toBe(false);
    // 又回到第 3 次，命中
    expect(detector.record('read_file', { path: 'a' })).toBe(true);
  });

  test('参数键顺序不同视为相同参数', () => {
    const detector = createLoopDetector({ threshold: 3 });

    expect(detector.record('search_code', { query: 'x', maxResults: 5 })).toBe(false);
    expect(detector.record('search_code', { maxResults: 5, query: 'x' })).toBe(false);
    expect(detector.record('search_code', { query: 'x', maxResults: 5 })).toBe(true);
  });

  test('reset 后计数归零', () => {
    const detector = createLoopDetector({ threshold: 3 });
    detector.record('read_file', { path: 'a' });
    detector.record('read_file', { path: 'a' });
    detector.reset();
    expect(detector.consecutiveRepeats).toBe(0);
    expect(detector.record('read_file', { path: 'a' })).toBe(false);
  });

  test('阈值下限为 2', () => {
    const detector = createLoopDetector({ threshold: 1 });
    expect(detector.record('read_file', { path: 'a' })).toBe(false);
    expect(detector.record('read_file', { path: 'a' })).toBe(true);
  });

  test('告警文案包含工具名与换思路指引', () => {
    const message = buildLoopWarningMessage('read_file', 3);
    expect(message).toContain('read_file');
    expect(message).toContain('submit_review_findings');
  });
});
