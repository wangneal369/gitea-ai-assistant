/**
 * Context Trimming
 *
 * Keeps a running agent conversation inside its token budget by dropping the
 * payloads of stale tool results.
 *
 * Codex solves the same problem with automatic compaction: when the context
 * crosses 65% of the window, it asks the model to summarise the history and
 * starts a fresh window from that summary (see `run_auto_compact` in
 * `core/src/session/turn.rs`).
 *
 * For a code-review agent a summary step is the wrong trade-off:
 *
 * - a summary is a lossy rewrite of evidence the model is supposed to reason
 *   over, and review findings must point at concrete lines;
 * - summarisation costs an extra model round-trip on every run;
 * - the bulk of the context is tool output (diffs, file contents) that the
 *   model has already consumed — the finding, if any, was already formed.
 *
 * So we trim instead of summarise: the oldest tool messages get their
 * content replaced by a short marker, while the user prompt, the diff, and
 * the most recent exchanges stay intact. The model keeps its conclusion and
 * loses only the raw payload it no longer needs.
 */

import type { LLMMessage } from '../../llm/types';

/** Default fraction of the budget at which trimming starts. Matches Codex's 65%. */
export const DEFAULT_CONTEXT_TRIM_THRESHOLD = 0.65;

/** Default number of trailing tool messages that are never trimmed. */
export const DEFAULT_KEEP_RECENT_TOOL_MESSAGES = 4;

export interface ContextTrimOptions {
  /** Total token budget for the conversation. */
  budgetTokens: number;
  /** Fraction of the budget at which trimming starts. Defaults to 0.65. */
  threshold?: number;
  /** Trailing tool messages to keep intact. Defaults to 4. */
  keepRecentToolMessages?: number;
  /** Token estimator. Defaults to a chars/3.5 approximation. */
  countTokens?: (text: string) => number;
}

export interface ContextTrimResult {
  /** The messages to send to the model. */
  messages: LLMMessage[];
  /** How many tool messages were trimmed. */
  trimmed: number;
  /** Estimated tokens before trimming. */
  tokensBefore: number;
  /** Estimated tokens after trimming. */
  tokensAfter: number;
  /** True when trimming was applied. */
  trimmedApplied: boolean;
}

function defaultCountTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}

function messageText(message: LLMMessage): string {
  return typeof message.content === 'string' ? message.content : '';
}

/**
 * Replace the content of a tool message with a compact marker.
 *
 * The marker states explicitly that the payload was dropped, so the model
 * does not mistake it for an empty result and start reasoning about a
 * missing value.
 */
export function buildTrimMarker(originalLength: number): string {
  return `[trimmed: tool result of ${originalLength} characters was removed to stay within the context budget. Re-run the tool if you still need this data.]`;
}

/**
 * Trim the conversation so it fits inside the token budget.
 *
 * The user message (which carries the diff and the review instructions) and
 * the trailing `keepRecentToolMessages` tool messages are never touched.
 */
export function trimContext(
  messages: LLMMessage[],
  options: ContextTrimOptions
): ContextTrimResult {
  const countTokens = options.countTokens ?? defaultCountTokens;
  const threshold = options.threshold ?? DEFAULT_CONTEXT_TRIM_THRESHOLD;
  const keepRecent = options.keepRecentToolMessages ?? DEFAULT_KEEP_RECENT_TOOL_MESSAGES;

  const totalText = messages.map(messageText).join('\n');
  const tokensBefore = countTokens(totalText);

  const triggerTokens = Math.floor(options.budgetTokens * threshold);

  if (options.budgetTokens <= 0 || tokensBefore <= triggerTokens) {
    return {
      messages,
      trimmed: 0,
      tokensBefore,
      tokensAfter: tokensBefore,
      trimmedApplied: false,
    };
  }

  // Identify the tool messages that are eligible for trimming: role === 'tool'
  // and not among the trailing `keepRecent` tool messages.
  const toolIndexes: number[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    if (messages[index]?.role === 'tool') toolIndexes.push(index);
  }

  if (toolIndexes.length <= keepRecent) {
    // Nothing safe to trim — the context is mostly instructions and assistant
    // turns. Report the overflow so the caller can decide.
    return {
      messages,
      trimmed: 0,
      tokensBefore,
      tokensAfter: tokensBefore,
      trimmedApplied: false,
    };
  }

  const eligible = toolIndexes.slice(0, toolIndexes.length - keepRecent);
  const trimmedMessages = messages.map((message) => ({ ...message }));
  let trimmed = 0;

  for (const index of eligible) {
    const message = trimmedMessages[index];
    if (!message) continue;
    const original = messageText(message);
    if (original.length <= 200) continue; // nothing worth trimming
    trimmedMessages[index] = {
      ...message,
      content: buildTrimMarker(original.length),
    };
    trimmed += 1;

    const currentText = trimmedMessages.map(messageText).join('\n');
    if (countTokens(currentText) <= triggerTokens) break;
  }

  const tokensAfter = countTokens(trimmedMessages.map(messageText).join('\n'));

  return {
    messages: trimmedMessages,
    trimmed,
    tokensBefore,
    tokensAfter,
    trimmedApplied: trimmed > 0,
  };
}
