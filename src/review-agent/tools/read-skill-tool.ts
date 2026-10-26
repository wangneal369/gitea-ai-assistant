import type { MainAgentTool } from '../../agent-kernel/loop/types';
import {
  type RepositorySkillMetadata,
  readRepositorySkillBody,
} from '../../review/context/repository-skill-loader';

export interface CreateReadSkillToolOptions {
  /** Skill metadata discovered in the repository workspace. */
  skills: RepositorySkillMetadata[];
}

/**
 * Create the `read_skill` tool.
 *
 * This is the second stage of progressive disclosure: the prompt only carries
 * the skill catalog (name + description + location), and the model pulls the
 * full instructions for a skill on demand. Codex exposes the same capability
 * as `skills_read`, OpenClaw as `skills_read`.
 *
 * The tool is intentionally not a terminal tool — reading a skill consumes the
 * exploration budget like any other read, but the review submission still does
 * not.
 */
export function createReadSkillTool(options: CreateReadSkillToolOptions): MainAgentTool {
  const { skills } = options;
  const byName = new Map(skills.map((skill) => [skill.name, skill]));

  return {
    definition: {
      name: 'read_skill',
      description:
        'Load the full instructions of a repository review skill listed in the skills catalog. ' +
        'Call this before applying any skill guidance — the catalog only carries the name and summary. ' +
        'Use the exact skill name from the catalog.',
      parameters: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'Exact skill name from the repository skills catalog.',
          },
        },
        required: ['name'],
        additionalProperties: false,
      },
    },
    execute: async (argumentsValue: unknown) => {
      const input =
        argumentsValue && typeof argumentsValue === 'object' && !Array.isArray(argumentsValue)
          ? (argumentsValue as Record<string, unknown>)
          : {};
      const name = typeof input.name === 'string' ? input.name.trim() : '';

      if (!name) {
        return { found: false, error: 'name is required' };
      }

      const metadata = byName.get(name);
      if (!metadata) {
        return {
          found: false,
          error: `Unknown skill "${name}". Available skills: ${skills.map((s) => s.name).join(', ') || '(none)'}`,
        };
      }

      const document = await readRepositorySkillBody(metadata);
      if (!document) {
        return { found: false, error: `Failed to read skill "${name}"` };
      }

      return {
        found: true,
        name: metadata.name,
        path: metadata.path,
        content: document.content,
        truncated: document.truncated,
      };
    },
  };
}
