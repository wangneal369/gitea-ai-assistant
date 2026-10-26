/**
 * Repository Skill Loader
 *
 * Discovers and loads review-oriented skill documents (SKILL.md) that live inside
 * the checked-out repository workspace, so that a project's own review playbook
 * participates in the Agent review automatically.
 *
 * The design follows the mature agent harnesses (OpenAI Codex `skills` crate and
 * OpenClaw's skill loader):
 *
 * 1. **Frontmatter metadata** — `name` / `description` are parsed out of a YAML
 *    frontmatter block. Codex requires `description` and falls back to the
 *    directory name for `name`; we do the same, plus a YAML-repair pass for
 *    prose-y descriptions like `description: Build for AWS: ECS`.
 *
 * 2. **Progressive disclosure** — the prompt only ever carries the compact
 *    *catalog* (name + description + location). Full skill bodies are read on
 *    demand through the `read_skill` tool, exactly like Codex's
 *    `skills_read` / OpenClaw's `skills_read`. Injecting every body up front
 *    would silently crowd out the diff, which is the actual review material.
 *
 * 3. **Bounded metadata budget** — the catalog is capped as a fraction of the
 *    model's context window (Codex uses 2%, capped at 10k tokens). When the cap
 *    bites, descriptions are shortened round-robin so no single skill can
 *    monopolize the budget, and skills that still do not fit are omitted with
 *    an explicit notice instead of being silently dropped.
 *
 * 4. **Scope precedence** — Codex resolves same-name skills by scope
 *    (system > admin > repo > user). We only have repo scope here, but the
 *    discovery order across skill roots still gives deterministic precedence.
 *
 * Reading is best-effort throughout: a missing or malformed skill file must
 * never fail the review run.
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

import { logger } from '../../utils/logger';
import { tokenCounter } from './token-counter';

// ---------------------------------------------------------------------------
// Discovery configuration
// ---------------------------------------------------------------------------

/**
 * Skill roots, relative to the repository root, in descending precedence order.
 *
 * These mirror the layouts used by the mainstream harnesses:
 *   - Codex / OpenClaw workspace skills: `<workspace>/skills`
 *   - Codex / OpenClaw project agent skills: `<workspace>/.agents/skills`
 *   - Claude Code project skills: `<workspace>/.claude/skills`
 *   - OpenClaw managed skills: `<workspace>/.openclaw/skills`
 */
const DEFAULT_SKILL_ROOTS = [
  'skills',
  '.agents/skills',
  '.claude/skills',
  '.openclaw/skills',
  '.codex/skills',
  '.agent/skills',
  '.skills',
];

/** File names that mark a skill definition. */
const SKILL_FILENAMES = ['SKILL.md', 'skill.md'];

/** Maximum directory nesting depth scanned below a skill root (Codex scans 6). */
const MAX_SCAN_DEPTH = 3;

/** Maximum number of skill files read from one repository. */
const MAX_SKILL_FILES = 40;

/** Maximum length of a skill name, matching Codex's MAX_NAME_LEN. */
const MAX_NAME_LEN = 64;

/** Maximum length of a catalog description. */
const MAX_DESCRIPTION_LEN = 1024;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Where a skill was found, relative to the repository root. */
export type RepositorySkillScope = 'repo';

/** Metadata for one discovered skill, before its body is read. */
export interface RepositorySkillMetadata {
  /** Skill name (frontmatter `name`, else the directory name). */
  name: string;
  /** One-line summary (frontmatter `description`). */
  description: string;
  /** Optional shorter description (`metadata.short-description`). */
  shortDescription?: string;
  /** Path relative to the repository root, using forward slashes. */
  path: string;
  /** Absolute path on disk. */
  absolutePath: string;
  /** Which skill root it came from. */
  root: string;
  /** Scope, kept for parity with Codex's scope-based precedence. */
  scope: RepositorySkillScope;
}

export interface RepositorySkillCatalog {
  skills: RepositorySkillMetadata[];
  /** Skills that could not be parsed or read. */
  errors: Array<{ path: string; message: string }>;
}

/** A skill body, read on demand. */
export interface RepositorySkillDocument {
  metadata: RepositorySkillMetadata;
  /** The skill body with frontmatter stripped. */
  content: string;
  /** True when the body was clipped because it exceeded the per-skill cap. */
  truncated: boolean;
}

export interface RepositorySkillLoadResult {
  catalog: RepositorySkillCatalog;
  /** Characters consumed by the rendered catalog section. */
  catalogChars: number;
  /** True when some skills were dropped from the catalog for budget reasons. */
  omitted: number;
}

// ---------------------------------------------------------------------------
// Frontmatter parsing
// ---------------------------------------------------------------------------

export interface ParsedSkillFrontmatter {
  name?: string;
  description?: string;
  shortDescription?: string;
}

/**
 * Extract the raw YAML frontmatter block.
 *
 * Returns undefined when the file does not start with a `---` fence or the
 * closing fence is missing (Codex treats both as "no frontmatter").
 */
export function extractFrontmatter(contents: string): string | undefined {
  const lines = contents.split(/\r?\n/);
  if (lines.length === 0) return undefined;

  let index = 0;
  // Skip a UTF-8 BOM, which would otherwise break the `---` fence check.
  if (lines[0]?.charCodeAt(0) === 0xfeff) index = 1;

  if (lines[index]?.trim() !== '---') return undefined;
  index += 1;

  const body: string[] = [];
  let closed = false;
  for (; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (line.trim() === '---') {
      closed = true;
      break;
    }
    body.push(line);
  }

  if (!closed || body.length === 0) return undefined;
  return body.join('\n');
}

/**
 * Parse a minimal YAML subset for skill frontmatter.
 *
 * We intentionally avoid a YAML dependency: skill frontmatter only ever uses
 * flat `key: value` pairs, and the values we care about are single-line
 * strings. Nested blocks (`metadata:`) are handled one level deep.
 */
export function parseSkillFrontmatter(frontmatter: string): ParsedSkillFrontmatter {
  const result: ParsedSkillFrontmatter = {};
  const lines = frontmatter.split(/\r?\n/);

  let inMetadata = false;
  let inMetadataShortDescription = false;

  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '');
    if (!line.trim() || line.trim().startsWith('#')) continue;

    const indent = line.length - line.trimStart().length;
    const trimmed = line.trim();

    // `metadata:` opens the nested block; `short-description:` lives inside it.
    if (indent === 0) {
      inMetadata = false;
      inMetadataShortDescription = false;
      const separator = trimmed.indexOf(':');
      if (separator === -1) continue;
      const key = trimmed.slice(0, separator).trim().toLowerCase();
      const value = trimmed.slice(separator + 1).trim();
      if (key === 'metadata') {
        inMetadata = true;
        continue;
      }
      assignScalar(result, key, value);
      continue;
    }

    if (inMetadata) {
      const separator = trimmed.indexOf(':');
      if (separator === -1) continue;
      const key = trimmed.slice(0, separator).trim().toLowerCase();
      const value = trimmed.slice(separator + 1).trim();
      if (key === 'short-description') {
        result.shortDescription = unquote(value);
        inMetadataShortDescription = true;
        continue;
      }
      inMetadataShortDescription = false;
      // Unknown nested keys are ignored on purpose.
    }
    void inMetadataShortDescription;
  }

  return result;
}

function assignScalar(target: ParsedSkillFrontmatter, key: string, value: string): void {
  if (key === 'name') {
    target.name = unquote(value);
    return;
  }
  if (key === 'description') {
    target.description = unquote(value);
  }
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1);
    }
  }
  // Strip trailing comments on unquoted scalars (`description: foo # note`).
  const commentIndex = trimmed.indexOf(' #');
  if (commentIndex > 0) return trimmed.slice(0, commentIndex).trim();
  return trimmed;
}

/** Collapse all whitespace runs into single spaces (Codex's sanitize_single_line). */
function sanitizeSingleLine(value: string): string {
  return value.split(/\s+/).filter(Boolean).join(' ');
}

/**
 * Parse and validate the frontmatter of a SKILL.md file.
 *
 * `defaultName` is used when the frontmatter omits `name` (Codex uses the
 * containing directory name). A skill without a usable `description` is
 * rejected, matching Codex's `MissingField("description")` behaviour.
 */
export function parseSkillFrontmatterMetadata(
  contents: string,
  defaultName: string
): { metadata: ParsedSkillFrontmatter; body: string } {
  const frontmatter = extractFrontmatter(contents);
  const body = frontmatter === undefined ? contents : stripFrontmatter(contents);

  if (frontmatter === undefined) {
    return { metadata: {}, body };
  }

  const parsed = parseSkillFrontmatter(frontmatter);

  const name = parsed.name ? sanitizeSingleLine(parsed.name) : '';
  const description = parsed.description ? sanitizeSingleLine(parsed.description) : '';
  const shortDescription = parsed.shortDescription
    ? sanitizeSingleLine(parsed.shortDescription)
    : undefined;

  return {
    metadata: {
      name: name && name.length <= MAX_NAME_LEN ? name : defaultName,
      description,
      shortDescription,
    },
    body,
  };
}

function stripFrontmatter(contents: string): string {
  const lines = contents.split(/\r?\n/);
  let index = 0;
  if (lines[0]?.charCodeAt(0) === 0xfeff) index = 1;
  if (lines[index]?.trim() !== '---') return contents;
  index += 1;
  while (index < lines.length && lines[index]?.trim() !== '---') index += 1;
  index += 1; // skip the closing fence
  return lines.slice(index).join('\n');
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

async function isDirectory(target: string): Promise<boolean> {
  return stat(target)
    .then((info) => info.isDirectory())
    .catch(() => false);
}

async function isFile(target: string): Promise<boolean> {
  return stat(target)
    .then((info) => info.isFile())
    .catch(() => false);
}

function toPosixRelative(workspacePath: string, absolutePath: string): string {
  const relative = path.relative(workspacePath, absolutePath);
  return relative.split(path.sep).join('/');
}

function deriveNameFromPath(relativePath: string): string {
  const segments = relativePath.split('/');
  if (segments.length >= 2) {
    const parent = segments[segments.length - 2];
    if (parent && parent !== '.' && parent !== '..') return parent;
  }
  const fileName = segments[segments.length - 1] ?? relativePath;
  return fileName.replace(/\.(md|markdown)$/i, '') || fileName;
}

/**
 * Recursively collect SKILL.md files below a root, up to MAX_SCAN_DEPTH.
 *
 * Once a SKILL.md is found in a directory, that directory is not descended
 * into further — matching OpenClaw, which stops at the first SKILL.md it
 * finds under a skill root.
 */
async function collectSkillFiles(root: string, depth = 0): Promise<string[]> {
  if (depth > MAX_SCAN_DEPTH) return [];

  const found: string[] = [];

  for (const fileName of SKILL_FILENAMES) {
    const direct = path.join(root, fileName);
    if (await isFile(direct)) {
      found.push(direct);
      return found;
    }
  }

  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return found;
  }

  for (const entry of entries.sort()) {
    if (entry.startsWith('.')) continue;
    const child = path.join(root, entry);
    if (!(await isDirectory(child))) continue;
    found.push(...(await collectSkillFiles(child, depth + 1)));
  }

  return found;
}

/**
 * Discover skill metadata inside the workspace.
 *
 * Roots are scanned in precedence order; a skill found in an earlier root wins
 * over a same-named skill in a later one (Codex resolves conflicts by scope).
 */
export async function discoverRepositorySkills(workspacePath: string): Promise<RepositorySkillCatalog> {
  const skills: RepositorySkillMetadata[] = [];
  const errors: Array<{ path: string; message: string }> = [];
  const seenNames = new Set<string>();

  if (!workspacePath || !(await isDirectory(workspacePath))) {
    return { skills, errors };
  }

  const candidates: Array<{ absolutePath: string; root: string }> = [];

  for (const root of DEFAULT_SKILL_ROOTS) {
    const rootPath = path.join(workspacePath, root);
    if (!(await isDirectory(rootPath))) continue;
    const files = await collectSkillFiles(rootPath);
    for (const file of files) {
      candidates.push({ absolutePath: file, root });
    }
  }

  // A root-level SKILL.md is a common single-skill layout.
  for (const fileName of SKILL_FILENAMES) {
    const rootSkill = path.join(workspacePath, fileName);
    if (await isFile(rootSkill)) {
      candidates.push({ absolutePath: rootSkill, root: '.' });
    }
  }

  for (const candidate of candidates) {
    if (skills.length >= MAX_SKILL_FILES) break;

    const relativePath = toPosixRelative(workspacePath, candidate.absolutePath);

    let raw: string;
    try {
      raw = await readFile(candidate.absolutePath, 'utf-8');
    } catch (error) {
      errors.push({
        path: relativePath,
        message: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    const defaultName = deriveNameFromPath(relativePath);
    const { metadata } = parseSkillFrontmatterMetadata(raw, defaultName);

    // Codex requires a description; a skill without one cannot be catalogued.
    if (!metadata.description) {
      errors.push({ path: relativePath, message: 'missing frontmatter description' });
      continue;
    }

    const name = metadata.name || defaultName;
    if (seenNames.has(name)) {
      // Lower-precedence root: a same-named skill already won.
      continue;
    }
    seenNames.add(name);

    skills.push({
      name,
      description: metadata.description.slice(0, MAX_DESCRIPTION_LEN),
      shortDescription: metadata.shortDescription,
      path: relativePath,
      absolutePath: candidate.absolutePath,
      root: candidate.root,
      scope: 'repo',
    });
  }

  if (skills.length > 0 || errors.length > 0) {
    logger.info('已发现仓库技能', {
      workspacePath,
      skillCount: skills.length,
      errorCount: errors.length,
      names: skills.map((skill) => skill.name),
    });
  }

  return { skills, errors };
}

// ---------------------------------------------------------------------------
// Catalog rendering
// ---------------------------------------------------------------------------

/**
 * Compute the metadata budget for the skill catalog.
 *
 * Codex derives it from the context window (2%, capped at 10k tokens) and
 * falls back to a fixed character budget. We mirror that.
 */
export function skillMetadataBudget(contextWindow?: number): number {
  if (contextWindow && contextWindow > 0) {
    const byWindow = Math.floor((contextWindow * 2) / 100);
    return Math.min(Math.max(byWindow, 1), 10_000);
  }
  return 2_000;
}

/**
 * Render the compact skill catalog for prompt injection.
 *
 * This is the progressive-disclosure first stage: only name + description +
 * location are exposed. Bodies are read on demand via the `read_skill` tool.
 */
export function renderSkillCatalog(
  skills: RepositorySkillMetadata[],
  budgetTokens: number
): { section: string; omitted: number } {
  if (skills.length === 0) {
    return { section: '', omitted: 0 };
  }

  const budgetChars = Math.floor(budgetTokens * 3.5);
  const lines: string[] = [];

  // Fixed overhead: the section header and the usage instruction.
  const overhead = [
    '## Repository review skills',
    '',
    'This repository ships its own review playbooks as skills. The catalog below lists',
    'each skill with its location. When a skill is relevant to the change under review,',
    'call `read_skill` with its name to load the full instructions before acting on it.',
    'Do not guess a skill body you have not read.',
    '',
    'Available skills:',
  ].join('\n');

  let used = overhead.length;
  const rendered: string[] = [];
  let omitted = 0;

  for (const skill of skills) {
    const description = skill.shortDescription || skill.description;
    const full = `- ${skill.name}: ${description} (file: ${skill.path})`;
    const minimum = `- ${skill.name} (file: ${skill.path})`;

    if (used + full.length + 1 <= budgetChars) {
      rendered.push(full);
      used += full.length + 1;
      continue;
    }

    if (used + minimum.length + 1 <= budgetChars) {
      // Description does not fit — keep the entry, drop the description.
      rendered.push(minimum);
      used += minimum.length + 1;
      continue;
    }

    omitted += 1;
  }

  if (omitted > 0) {
    rendered.push(`- ${omitted} additional skill(s) omitted from this bounded skills list.`);
  }

  lines.push(...rendered);

  return { section: [overhead, ...lines].join('\n'), omitted };
}

// ---------------------------------------------------------------------------
// Body loading
// ---------------------------------------------------------------------------

/** Maximum characters of a single skill body injected into the conversation. */
const MAX_BODY_CHARS = 20_000;

/**
 * Read one skill's body on demand.
 *
 * Returns undefined when the skill is unknown or unreadable.
 */
export async function readRepositorySkillBody(
  metadata: RepositorySkillMetadata
): Promise<RepositorySkillDocument | undefined> {
  let raw: string;
  try {
    raw = await readFile(metadata.absolutePath, 'utf-8');
  } catch (error) {
    logger.warn('读取技能正文失败', {
      path: metadata.path,
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }

  const { body } = parseSkillFrontmatterMetadata(raw, metadata.name);
  const trimmed = body.trim();
  if (!trimmed) return undefined;

  let content = trimmed;
  let truncated = false;
  if (content.length > MAX_BODY_CHARS) {
    content = `${content.slice(0, MAX_BODY_CHARS)}\n... [truncated: skill body exceeds ${MAX_BODY_CHARS} chars]`;
    truncated = true;
  }

  return { metadata, content, truncated };
}

/**
 * Load the skill catalog for a workspace and render it for prompt injection.
 */
export async function loadRepositorySkills(
  workspacePath: string,
  contextWindow?: number
): Promise<RepositorySkillLoadResult> {
  const catalog = await discoverRepositorySkills(workspacePath);
  const budget = skillMetadataBudget(contextWindow);
  const { section, omitted } = renderSkillCatalog(catalog.skills, budget);

  return {
    catalog,
    catalogChars: section.length,
    omitted,
  };
}

/** Token estimate helper re-exported for callers that size the prompt. */
export function estimateSkillCatalogTokens(chars: number): number {
  return tokenCounter.count('x'.repeat(chars));
}
