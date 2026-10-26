import { describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  discoverRepositorySkills,
  extractFrontmatter,
  loadRepositorySkills,
  parseSkillFrontmatter,
  parseSkillFrontmatterMetadata,
  readRepositorySkillBody,
  renderSkillCatalog,
  skillMetadataBudget,
} from '../repository-skill-loader';

async function makeWorkspace(): Promise<string> {
  return await mkdtemp(path.join(tmpdir(), 'skill-loader-'));
}

describe('frontmatter 解析', () => {
  test('提取标准 frontmatter 块', () => {
    const contents = ['---', 'name: review', 'description: 审查代码', '---', '', '正文'].join('\n');
    const frontmatter = extractFrontmatter(contents);
    expect(frontmatter).not.toBeUndefined();
    expect(frontmatter).toContain('name: review');
    expect(frontmatter).not.toContain('正文');
  });

  test('没有 frontmatter 时返回 undefined', () => {
    expect(extractFrontmatter('# 标题\n\n正文')).toBeUndefined();
    expect(extractFrontmatter('---\nname: x\n没有结束')).toBeUndefined();
  });

  test('解析 name / description / short-description', () => {
    const frontmatter = [
      'name: code-review',
      'description: 用于审查 PR 的技能',
      'metadata:',
      '  short-description: 审查 PR',
    ].join('\n');
    const parsed = parseSkillFrontmatter(frontmatter);
    expect(parsed.name).toBe('code-review');
    expect(parsed.description).toBe('用于审查 PR 的技能');
    expect(parsed.shortDescription).toBe('审查 PR');
  });

  test('description 含冒号时不截断', () => {
    const frontmatter = ['name: aws', 'description: Build for AWS: ECS'].join('\n');
    const parsed = parseSkillFrontmatter(frontmatter);
    expect(parsed.description).toBe('Build for AWS: ECS');
  });

  test('缺少 name 时回退到目录名', () => {
    const contents = ['---', 'description: 只有描述', '---', '', '正文'].join('\n');
    const { metadata } = parseSkillFrontmatterMetadata(contents, 'my-skill');
    expect(metadata.name).toBe('my-skill');
    expect(metadata.description).toBe('只有描述');
  });

  test('正文不包含 frontmatter 本身', () => {
    const contents = ['---', 'name: x', 'description: y', '---', '', '真正的正文'].join('\n');
    const { body } = parseSkillFrontmatterMetadata(contents, 'x');
    expect(body).not.toContain('name: x');
    expect(body).toContain('真正的正文');
  });
});

describe('技能发现', () => {
  test('发现 skills/<name>/SKILL.md 布局', async () => {
    const workspace = await makeWorkspace();
    try {
      const skillDir = path.join(workspace, 'skills', 'security-review');
      await mkdir(skillDir, { recursive: true });
      await writeFile(
        path.join(skillDir, 'SKILL.md'),
        ['---', 'name: security-review', 'description: 安全审查', '---', '', '检查注入漏洞'].join('\n'),
        'utf-8'
      );

      const catalog = await discoverRepositorySkills(workspace);
      expect(catalog.skills.length).toBe(1);
      expect(catalog.skills[0]?.name).toBe('security-review');
      expect(catalog.skills[0]?.description).toBe('安全审查');
      expect(catalog.skills[0]?.path).toBe('skills/security-review/SKILL.md');
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test('发现 .agents/skills 与 .claude/skills 布局', async () => {
    const workspace = await makeWorkspace();
    try {
      for (const root of ['.agents/skills', '.claude/skills']) {
        const skillDir = path.join(workspace, root, 'proj');
        await mkdir(skillDir, { recursive: true });
        await writeFile(
          path.join(skillDir, 'SKILL.md'),
          ['---', `name: ${root.includes('claude') ? 'claude-skill' : 'agent-skill'}`, 'description: d', '---', '', 'body'].join('\n'),
          'utf-8'
        );
      }

      const catalog = await discoverRepositorySkills(workspace);
      const names = catalog.skills.map((skill) => skill.name).sort();
      expect(names).toEqual(['agent-skill', 'claude-skill']);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test('缺少 description 的技能被跳过并记录错误', async () => {
    const workspace = await makeWorkspace();
    try {
      const skillDir = path.join(workspace, 'skills', 'broken');
      await mkdir(skillDir, { recursive: true });
      await writeFile(path.join(skillDir, 'SKILL.md'), '---\nname: broken\n---\n\nbody', 'utf-8');

      const catalog = await discoverRepositorySkills(workspace);
      expect(catalog.skills.length).toBe(0);
      expect(catalog.errors.length).toBe(1);
      expect(catalog.errors[0]?.message).toContain('description');
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test('同名技能由更高优先级的 root 胜出', async () => {
    const workspace = await makeWorkspace();
    try {
      for (const root of ['skills', '.claude/skills']) {
        const skillDir = path.join(workspace, root, 'dup');
        await mkdir(skillDir, { recursive: true });
        await writeFile(
          path.join(skillDir, 'SKILL.md'),
          ['---', 'name: dup', `description: from-${root}`, '---', '', 'body'].join('\n'),
          'utf-8'
        );
      }

      const catalog = await discoverRepositorySkills(workspace);
      expect(catalog.skills.length).toBe(1);
      expect(catalog.skills[0]?.description).toBe('from-skills');
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test('工作区不存在时不报错', async () => {
    const catalog = await discoverRepositorySkills(path.join(tmpdir(), 'definitely-not-here-xyz'));
    expect(catalog.skills.length).toBe(0);
    expect(catalog.errors.length).toBe(0);
  });
});

describe('目录渲染（渐进式披露）', () => {
  const skills = [
    {
      name: 'security',
      description: '检查注入与鉴权绕过',
      path: 'skills/security/SKILL.md',
      absolutePath: '/tmp/security/SKILL.md',
      root: 'skills',
      scope: 'repo' as const,
    },
  ];

  test('目录只含名称、描述与路径，不含正文', () => {
    const { section } = renderSkillCatalog(skills, 2000);
    expect(section).toContain('security');
    expect(section).toContain('skills/security/SKILL.md');
    expect(section).toContain('检查注入与鉴权绕过');
    // 目录里不能有技能正文，只提示模型按需读取
    expect(section).toContain('read_skill');
    expect(section).not.toContain('检查注入漏洞');
  });

  test('预算不足时先丢描述再丢条目', () => {
    const many = Array.from({ length: 20 }, (_, index) => ({
      ...skills[0]!,
      name: `skill-${index}`,
      description: 'x'.repeat(300),
      path: `skills/skill-${index}/SKILL.md`,
    }));

    const { section, omitted } = renderSkillCatalog(many, 200);
    expect(omitted).toBeGreaterThan(0);
    expect(section).toContain('omitted from this bounded skills list');
  });

  test('没有技能时返回空串', () => {
    expect(renderSkillCatalog([], 2000).section).toBe('');
  });

  test('预算按上下文窗口的 2% 计算并封顶 10k', () => {
    expect(skillMetadataBudget(100_000)).toBe(2000);
    expect(skillMetadataBudget(1_000_000)).toBe(10_000);
    expect(skillMetadataBudget(undefined)).toBe(2000);
  });
});

describe('技能正文按需读取', () => {
  test('读取正文并剥离 frontmatter', async () => {
    const workspace = await makeWorkspace();
    try {
      const skillDir = path.join(workspace, 'skills', 'perf');
      await mkdir(skillDir, { recursive: true });
      await writeFile(
        path.join(skillDir, 'SKILL.md'),
        ['---', 'name: perf', 'description: 性能检查', '---', '', '第一步：找热点', '第二步：分析'].join('\n'),
        'utf-8'
      );

      const catalog = await discoverRepositorySkills(workspace);
      const metadata = catalog.skills[0];
      expect(metadata).toBeDefined();

      const document = await readRepositorySkillBody(metadata!);
      expect(document).toBeDefined();
      expect(document?.content).toContain('第一步：找热点');
      expect(document?.content).not.toContain('name: perf');
      expect(document?.truncated).toBe(false);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test('端到端：加载目录并渲染注入片段', async () => {
    const workspace = await makeWorkspace();
    try {
      const skillDir = path.join(workspace, 'skills', 'audit');
      await mkdir(skillDir, { recursive: true });
      await writeFile(
        path.join(skillDir, 'SKILL.md'),
        ['---', 'name: audit', 'description: 数据流表审查', '---', '', '先建数据流表'].join('\n'),
        'utf-8'
      );

      const result = await loadRepositorySkills(workspace);
      expect(result.catalog.skills.length).toBe(1);
      expect(result.catalogChars).toBeGreaterThan(0);
      expect(result.omitted).toBe(0);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
