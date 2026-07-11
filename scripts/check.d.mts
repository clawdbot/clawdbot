/**
 * Returns command usage text for the aggregate check runner.
 */
export function usage(): string;
/**
 * Runs selected repository check lanes.
 */
export function main(argv?: string[]): Promise<void>;
/**
 * Runs one managed check command and returns timing/status details.
 */
export function runCommand(
  command: unknown,
  runManagedCommandImpl?: (options: { args: string[]; bin: string }) => Promise<number>,
): Promise<{
  name: unknown;
  durationMs: number;
  status: number;
}>;
