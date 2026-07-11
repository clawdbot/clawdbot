/**
 * Parses comma-separated PR numbers from CLI/env input.
 */
export function parsePrNumberList(value: unknown): number[];
/**
 * Parses duplicate PR close workflow arguments.
 */
export function parseArgs(
  argv: string[],
  env?: NodeJS.ProcessEnv,
):
  | {
      apply: boolean;
      duplicates: number[];
      help: true;
      labels: string[];
      landedPr?: number;
      repo: string;
    }
  | {
      apply: boolean;
      duplicates: number[];
      help?: undefined;
      labels: string[];
      landedPr: number;
      repo: string;
    };
/**
 * Parses changed hunk ranges from unified diff text.
 */
export function parseUnifiedDiffRanges(diffText: unknown): Map<unknown, unknown>;
/**
 * Builds the close/skip plan for duplicate PR candidates.
 */
export function buildDuplicateClosePlan({
  candidates,
  diffs,
  landed,
  repo,
}: {
  candidates: unknown;
  diffs: unknown;
  landed: unknown;
  repo: unknown;
}): Array<Record<string, unknown>>;
/**
 * Applies labels/comments/closes for planned duplicate PR actions.
 */
export function applyClosePlan({
  labels,
  plan,
  repo,
  runGh,
}: {
  labels?: string[] | undefined;
  plan: unknown;
  repo: unknown;
  runGh: unknown;
}): void;
/**
 * Runs the duplicate PR close workflow.
 */
export function runDuplicateCloseWorkflow(
  args: unknown,
  runGh?: (args: string[], options?: Record<string, unknown>) => string,
): Array<Record<string, unknown>>;
