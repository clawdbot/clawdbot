import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import path from "node:path";
import { resolveQaWindowsSystem32ExePath } from "./windows-system-tools.js";

export type QaScenarioCommandExecution = {
  args: string[];
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs?: number;
};

export type QaScenarioCommandResult = {
  exitCode: number;
  failureMessage?: string;
  signal?: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
};

type QaScenarioCommandTerminalResult = Pick<
  QaScenarioCommandResult,
  "exitCode" | "failureMessage" | "signal"
>;

type QaScenarioTaskkillRunner = typeof spawnSync;
type QaScenarioCommandTimers = Partial<
  Record<"timeout" | "forceKill" | "forceSettle", NodeJS.Timeout>
>;

const QA_SCENARIO_COMMAND_TIMEOUT_KILL_GRACE_MS = 2_000;
const QA_SCENARIO_COMMAND_TIMEOUT_FORCE_SETTLE_MS = 500;
const QA_SCENARIO_COMMAND_PARENT_SIGNALS = ["SIGINT", "SIGTERM"] as const;
type QaScenarioParentSignal = (typeof QA_SCENARIO_COMMAND_PARENT_SIGNALS)[number];
let timeoutKillGraceMs = QA_SCENARIO_COMMAND_TIMEOUT_KILL_GRACE_MS;
let timeoutForceSettleMs = QA_SCENARIO_COMMAND_TIMEOUT_FORCE_SETTLE_MS;

export function killQaScenarioWindowsProcessTree(
  pid: number | undefined,
  signal: NodeJS.Signals,
  runTaskkill: QaScenarioTaskkillRunner = spawnSync,
) {
  if (pid === undefined) {
    return false;
  }
  const taskkillPath = resolveQaWindowsSystem32ExePath("taskkill.exe");
  const args = ["/pid", String(pid), "/T"];
  const run = (force: boolean) => {
    const result = runTaskkill(taskkillPath, force ? [...args, "/F"] : args, {
      stdio: "ignore",
      windowsHide: true,
    });
    return !result.error && result.status === 0;
  };
  return signal === "SIGKILL" ? run(true) : run(false) || run(true);
}

// One owner keeps timers, parent handlers, child signals, and final result
// settlement symmetric across every command exit path.
class QaScenarioCommandLifecycle {
  private readonly stderr: Buffer[] = [];
  private readonly stdout: Buffer[] = [];
  private resolve: ((result: QaScenarioCommandResult) => void) | undefined;
  private settled = false;
  private timers: QaScenarioCommandTimers = {};
  private timedOut = false;

  constructor(
    private readonly execution: QaScenarioCommandExecution,
    private readonly child: ChildProcess,
    private readonly useProcessGroup: boolean,
  ) {}

  start(resolve: (result: QaScenarioCommandResult) => void, reject: (reason?: unknown) => void) {
    this.resolve = resolve;
    this.armTimeout();
    this.child.stdout?.on("data", (chunk: Buffer) => this.stdout.push(chunk));
    this.child.stderr?.on("data", (chunk: Buffer) => this.stderr.push(chunk));
    process.once("exit", this.handleParentExit);
    for (const signal of QA_SCENARIO_COMMAND_PARENT_SIGNALS) {
      process.once(signal, this.handleParentSignal);
    }
    this.child.on("error", (error) => {
      if (this.settled) {
        return;
      }
      this.clearTimers();
      this.cleanupParentHandlers();
      reject(error);
    });
    this.child.on("close", this.handleClose);
  }

  private readonly handleParentExit = () => {
    this.signalChild("SIGKILL");
  };

  private readonly handleParentSignal = (signal: QaScenarioParentSignal) => {
    this.removeParentSignalHandlers();
    this.signalChild(signal);
    this.scheduleForcedCleanup({
      exitCode: 1,
      failureMessage: `${this.commandLabel()} interrupted by ${signal}`,
      signal,
    });
    process.kill(process.pid, signal);
  };

  private readonly handleClose = (exitCode: number | null, signal: NodeJS.Signals | null) => {
    if (this.settled) {
      return;
    }
    if (!this.timedOut) {
      this.clearTimeoutTimer();
    }
    const result = {
      exitCode: this.timedOut ? 1 : (exitCode ?? (signal ? 1 : 0)),
      signal,
      ...(this.timedOut
        ? {
            failureMessage: `${this.commandLabel()} timed out after ${this.execution.timeoutMs}ms`,
          }
        : {}),
    };
    if (
      this.timedOut &&
      !this.useProcessGroup &&
      (this.timers.forceKill || this.timers.forceSettle)
    ) {
      return;
    }
    if (this.isProcessGroupRunning()) {
      if (!this.timedOut) {
        this.signalChild("SIGTERM");
      }
      this.scheduleForcedCleanup(result);
      return;
    }
    this.finish(result);
  };

  private armTimeout() {
    const timeoutMs = this.execution.timeoutMs;
    if (timeoutMs === undefined) {
      return;
    }
    this.timers.timeout = setTimeout(() => {
      delete this.timers.timeout;
      this.timedOut = true;
      this.signalChild("SIGTERM");
      this.scheduleForcedCleanup({
        exitCode: 1,
        failureMessage: `${this.commandLabel()} timed out after ${timeoutMs}ms`,
        signal: null,
      });
    }, timeoutMs);
  }

  private signalChild(signal: NodeJS.Signals) {
    if (this.useProcessGroup && this.child.pid) {
      try {
        process.kill(-this.child.pid, signal);
        return;
      } catch {
        // The process group may already be gone; fall back to the direct child.
      }
    }
    if (!this.useProcessGroup && process.platform === "win32") {
      if (killQaScenarioWindowsProcessTree(this.child.pid, signal)) {
        return;
      }
    }
    this.child.kill(signal);
  }

  private isProcessGroupRunning() {
    if (!this.useProcessGroup || !this.child.pid) {
      return false;
    }
    try {
      process.kill(-this.child.pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "EPERM";
    }
  }

  private scheduleForcedCleanup(result: QaScenarioCommandTerminalResult) {
    if (this.timers.forceKill || this.timers.forceSettle) {
      return;
    }
    this.timers.forceKill = setTimeout(() => {
      delete this.timers.forceKill;
      this.signalChild("SIGKILL");
      this.timers.forceSettle = setTimeout(() => {
        delete this.timers.forceSettle;
        const stillRunning = this.isProcessGroupRunning();
        const failureMessage =
          result.failureMessage ??
          (stillRunning ? `${this.commandLabel()} left background processes running` : undefined);
        this.finish({
          exitCode: stillRunning ? 1 : result.exitCode,
          signal: result.signal,
          ...(failureMessage ? { failureMessage } : {}),
        });
      }, timeoutForceSettleMs);
    }, timeoutKillGraceMs);
  }

  private finish(result: QaScenarioCommandTerminalResult) {
    if (this.settled) {
      return;
    }
    this.settled = true;
    this.clearTimers();
    this.cleanupParentHandlers();
    this.resolve?.({
      ...result,
      stdout: Buffer.concat(this.stdout).toString("utf8"),
      stderr: Buffer.concat(this.stderr).toString("utf8"),
    });
  }

  private commandLabel() {
    return path.basename(this.execution.command);
  }

  private clearTimeoutTimer() {
    if (this.timers.timeout) {
      clearTimeout(this.timers.timeout);
      delete this.timers.timeout;
    }
  }

  private clearTimers() {
    for (const timer of Object.values(this.timers)) {
      clearTimeout(timer);
    }
    this.timers = {};
  }

  private removeParentSignalHandlers() {
    for (const signal of QA_SCENARIO_COMMAND_PARENT_SIGNALS) {
      process.removeListener(signal, this.handleParentSignal);
    }
  }

  private cleanupParentHandlers() {
    this.removeParentSignalHandlers();
    process.removeListener("exit", this.handleParentExit);
  }
}

export function runQaScenarioCommandLifecycle(
  execution: QaScenarioCommandExecution,
): Promise<QaScenarioCommandResult> {
  return new Promise((resolve, reject) => {
    const useProcessGroup = process.platform !== "win32";
    const child = spawn(execution.command, execution.args, {
      cwd: execution.cwd,
      detached: useProcessGroup,
      env: execution.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    new QaScenarioCommandLifecycle(execution, child, useProcessGroup).start(resolve, reject);
  });
}

export function resetQaScenarioCommandCleanupTimings() {
  timeoutKillGraceMs = QA_SCENARIO_COMMAND_TIMEOUT_KILL_GRACE_MS;
  timeoutForceSettleMs = QA_SCENARIO_COMMAND_TIMEOUT_FORCE_SETTLE_MS;
}

export function setQaScenarioCommandCleanupTimings(params: {
  forceSettleMs: number;
  killGraceMs: number;
}) {
  timeoutKillGraceMs = params.killGraceMs;
  timeoutForceSettleMs = params.forceSettleMs;
}
