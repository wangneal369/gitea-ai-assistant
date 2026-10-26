/**
 * Loop Detection
 *
 * Guards against the agent spinning on the same tool call.
 *
 * The runner deliberately does not cap tool calls or model turns: a review
 * that needs to read twelve files should be allowed to read twelve files, and
 * Codex likewise imposes no `maxTurns` ceiling. What must not happen is the
 * agent repeating the same action forever — burning tokens without producing
 * new evidence.
 *
 * The signal is deliberately narrow: it only fires when the *same tool* is
 * called with *byte-identical arguments* repeatedly. Genuine investigation
 * reads different files, searches different terms, or calls different tools,
 * so it never trips the detector. A genuine loop looks like:
 *
 *   read_file {path: "src/a.ts"}   → same → same → same → ...
 *   search_code {query: "TODO"}    → same → same → same → ...
 *
 * A repeated call that returns a *different* result is fine — the agent may
 * legitimately re-read a file after other context changed, and the tool
 * result fingerprint would differ.
 */

import { createHash } from 'node:crypto';

export interface LoopDetectionOptions {
  /**
   * How many consecutive identical calls are tolerated before the runner
   * intervenes. The third identical call in a row is treated as a loop.
   */
  threshold?: number;
  /**
   * How many distinct call signatures to remember.
   */
  windowSize?: number;
}

export interface LoopDetector {
  /**
   * Record a tool call and report whether it looks like a loop.
   *
   * Returns true when this call repeats the previous calls too many times.
   */
  record(toolName: string, argumentsValue: unknown): boolean;
  /** Number of consecutive identical calls seen for the current signature. */
  readonly consecutiveRepeats: number;
  /** Reset the detector state. */
  reset(): void;
}

const DEFAULT_THRESHOLD = 3;
const DEFAULT_WINDOW_SIZE = 32;

function fingerprint(toolName: string, argumentsValue: unknown): string {
  let serialized: string;
  try {
    serialized = JSON.stringify(argumentsValue ?? null, Object.keys(argumentsValue ?? {}).sort());
  } catch {
    serialized = String(argumentsValue);
  }
  return createHash('sha256').update(`${toolName}::${serialized}`).digest('hex');
}

export function createLoopDetector(options: LoopDetectionOptions = {}): LoopDetector {
  const threshold = Math.max(2, options.threshold ?? DEFAULT_THRESHOLD);
  const windowSize = Math.max(threshold, options.windowSize ?? DEFAULT_WINDOW_SIZE);

  const counts = new Map<string, number>();
  let currentSignature: string | undefined;
  let consecutive = 0;

  return {
    get consecutiveRepeats() {
      return consecutive;
    },
    reset() {
      counts.clear();
      currentSignature = undefined;
      consecutive = 0;
    },
    record(toolName: string, argumentsValue: unknown): boolean {
      const signature = fingerprint(toolName, argumentsValue);

      if (signature === currentSignature) {
        consecutive += 1;
      } else {
        currentSignature = signature;
        consecutive = 1;
      }

      const next = (counts.get(signature) ?? 0) + 1;
      counts.set(signature, next);

      // Keep the window bounded so long runs do not leak memory.
      if (counts.size > windowSize) {
        const oldest = counts.keys().next();
        if (!oldest.done) counts.delete(oldest.value);
      }

      return consecutive >= threshold;
    },
  };
}

/**
 * Build the message injected when a tool loop is detected.
 *
 * The wording mirrors Codex's guard behaviour: stop repeating the action and
 * either change the approach or deliver the conclusion.
 */
export function buildLoopWarningMessage(
  toolName: string,
  threshold: number
): string {
  return (
    `[loop-guard] You have called '${toolName}' with identical arguments ${threshold} times in a row ` +
    `and are no longer making progress. Stop repeating this call. Either change the approach ` +
    `(different query, different file, or a different tool) or submit your conclusions now with ` +
    `submit_review_findings using the evidence you already have.`
  );
}
