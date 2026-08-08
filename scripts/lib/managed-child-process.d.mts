/**
 * Return conventional shell exit code for a signal.
 *
 * @param {NodeJS.Signals} signal
 * @returns {number}
 */
export function signalExitCode(signal: NodeJS.Signals): number;
/**
 * @param {import("node:child_process").ChildProcess} child
 * @param {NodeJS.Signals} [signal]
 * @param {{ platform?: NodeJS.Platform; runTaskkill?: typeof spawnSync }} [options]
 */
export function terminateManagedChild(
  child: Pick<import("node:child_process").ChildProcess, "kill" | "pid">,
  signal?: NodeJS.Signals,
  {
    platform,
    runTaskkill,
  }?: {
    platform?: NodeJS.Platform;
    runTaskkill?: (
      command: string,
      args?: string[],
      options?: {
        killSignal?: NodeJS.Signals;
        stdio?: import("node:child_process").StdioOptions;
        timeout?: number;
      },
    ) => { error?: Error; status: number | null };
  },
): { processTreeState: "indeterminate" | "signaled" | "terminated" } | undefined;
/**
 * Run a child command while forwarding termination signals to the managed process group.
 *
 * @param {{
 *   bin: string;
 *   args?: string[];
 *   cwd?: string;
 *   env?: NodeJS.ProcessEnv;
 *   stdio?: import("node:child_process").StdioOptions;
 *   shell?: boolean;
 *   windowsVerbatimArguments?: boolean;
 *   platform?: NodeJS.Platform;
 *   comSpec?: string;
 *   timeoutMs?: number;
 *   requireProcessTreeExit?: boolean;
 *   runTaskkill?: typeof spawnSync;
 *   onReady?: (child: import("node:child_process").ChildProcess) => void;
 * }} options
 * @returns {Promise<number>}
 */
export function runManagedCommand({
  bin,
  args,
  cwd,
  env,
  stdio,
  platform,
  shell,
  windowsVerbatimArguments,
  comSpec,
  timeoutMs,
  requireProcessTreeExit,
  runTaskkill,
  onReady,
}: {
  bin: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdio?: import("node:child_process").StdioOptions;
  shell?: boolean;
  windowsVerbatimArguments?: boolean;
  platform?: NodeJS.Platform;
  comSpec?: string;
  timeoutMs?: number;
  requireProcessTreeExit?: boolean;
  runTaskkill?: (
    command: string,
    args?: string[],
    options?: {
      killSignal?: NodeJS.Signals;
      stdio?: import("node:child_process").StdioOptions;
      timeout?: number;
    },
  ) => { error?: Error; status: number | null };
  onReady?: (child: import("node:child_process").ChildProcess) => void;
}): Promise<number>;
/**
 * @param {{
 *   bin: string;
 *   args?: string[];
 *   cwd?: string;
 *   env?: NodeJS.ProcessEnv;
 *   stdio?: import("node:child_process").StdioOptions;
 *   shell?: boolean;
 *   windowsVerbatimArguments?: boolean;
 *   platform?: NodeJS.Platform;
 *   comSpec?: string;
 * }} options
 */
export function createManagedCommandSpawnSpec({
  bin,
  args,
  cwd,
  env,
  stdio,
  platform,
  shell,
  windowsVerbatimArguments,
  comSpec,
}: {
  bin: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdio?: import("node:child_process").StdioOptions;
  shell?: boolean;
  windowsVerbatimArguments?: boolean;
  platform?: NodeJS.Platform;
  comSpec?: string;
}): {
  args: string[];
  command: string;
  options: {
    cwd: string | undefined;
    env: import("node:child_process").SpawnOptions["env"];
    stdio: import("node:child_process").StdioOptions;
    shell: boolean;
    detached: boolean;
    windowsVerbatimArguments: boolean | undefined;
  };
};
/**
 * @param {{
 *   bin: string;
 *   args?: string[];
 *   env?: NodeJS.ProcessEnv;
 *   shell?: boolean;
 *   windowsVerbatimArguments?: boolean;
 *   platform?: NodeJS.Platform;
 *   comSpec?: string;
 * }} options
 */
export function createManagedCommandInvocation({
  bin,
  args,
  env,
  platform,
  shell,
  windowsVerbatimArguments,
  comSpec,
}: {
  bin: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
  shell?: boolean;
  windowsVerbatimArguments?: boolean;
  platform?: NodeJS.Platform;
  comSpec?: string;
}): {
  args: string[];
  command: string;
  shell: boolean;
  windowsVerbatimArguments: boolean | undefined;
};
import { spawnSync } from "node:child_process";
