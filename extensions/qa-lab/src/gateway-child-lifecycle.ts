import type { ChildProcess } from "node:child_process";
import type { WriteStream } from "node:fs";
import path from "node:path";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { QaSuiteInfraError } from "./errors.js";
import {
  cleanupQaGatewayTempRoots,
  preserveQaGatewayDebugArtifacts,
} from "./gateway-child-artifacts.js";
import { closeQaGatewayLogStream, stopQaGatewayChildProcessTree } from "./gateway-child-process.js";
import type { reserveQaGatewayPort } from "./gateway-port-reservation.js";
import type {
  createQaGatewayProcessBoundaryController,
  QaGatewayVerifiedProcessIdentity,
} from "./gateway-process-boundary.js";
import type { startQaGatewayRpcClient } from "./gateway-rpc-client.js";

type BoundaryController = Awaited<ReturnType<typeof createQaGatewayProcessBoundaryController>>;
type PreparedSpawn = Awaited<ReturnType<BoundaryController["prepare"]>>;
export type QaGatewayStopResult = {
  process: "never-spawned" | "confirmed-stopped" | "unconfirmed";
  errors: unknown[];
};
export type QaGatewayStopOptions = { keepTemp?: boolean; preserveToDir?: string };

type OwnedProcess = {
  child: ChildProcess;
  prepared: PreparedSpawn | null;
  identity: QaGatewayVerifiedProcessIdentity | null;
  settlement?: Promise<QaGatewayStopResult>;
  ready: boolean;
  checkFailure: () => void;
};

// One lifetime owns staging, every spawn (including unaccepted launchers), and
// teardown. Diagnostic failures never substitute for process-group settlement.
export class QaGatewayChildLifecycle {
  tempRoot: string | null = null;
  stagedBundledPluginsRoot: string | null = null;
  portReservation: Awaited<ReturnType<typeof reserveQaGatewayPort>> | null = null;
  controller: BoundaryController | null = null;
  rpcClient: Awaited<ReturnType<typeof startQaGatewayRpcClient>> | null = null;
  readonly logStreams: Array<["stdout" | "stderr", WriteStream]> = [];
  private closed = false;
  private current: OwnedProcess | null = null;
  private operation: Promise<unknown> | null = null;
  private stopping: Promise<QaGatewayStopResult> | null = null;
  private readonly keepTemp = process.env.OPENCLAW_QA_KEEP_TEMP === "1";

  repoRoot?: string;

  assertOpen() {
    if (this.closed) {
      throw new Error("qa gateway child lifecycle is closed");
    }
  }

  register(child: ChildProcess, prepared: PreparedSpawn | null) {
    this.current = { child, prepared, identity: null, ready: false, checkFailure: () => {} };
    return this.current;
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    this.assertOpen();
    if (this.operation) {
      throw new Error("qa gateway child lifecycle operation already in progress");
    }
    const pending = Promise.resolve().then(() => {
      this.assertOpen();
      return operation();
    });
    this.operation = pending;
    try {
      return await pending;
    } catch (error) {
      this.closed = true;
      // Settle the failed operation's process, but leave logs and staging owned
      // until explicit stop supplies the caller's artifact preservation policy.
      const result = await this.stopProcess();
      const message = `${formatErrorMessage(error)}${this.tempRoot ? `\nQA gateway temp root preserved at ${this.tempRoot}` : ""}`;
      const primary =
        error instanceof QaSuiteInfraError
          ? new QaSuiteInfraError(error.code, message, { cause: error })
          : new Error(message, { cause: error });
      if (result.errors.length) {
        // Oxlint 1.78 checks cause at argument 2; AggregateError takes it at 3.
        // oxlint-disable-next-line preserve-caught-error
        throw new AggregateError(
          [primary, ...result.errors],
          "qa gateway startup and cleanup failed",
          { cause: error },
        );
      }
      throw primary;
    } finally {
      this.operation = null;
    }
  }

  stopProcess() {
    const current = this.current;
    if (!current) {
      return Promise.resolve<QaGatewayStopResult>({ process: "never-spawned", errors: [] });
    }
    // Cache settlement for this exact spawn; retries/replacements install a new
    // record only after confirmed termination, never after a leader-only exit.
    current.settlement ??= (async (): Promise<QaGatewayStopResult> => {
      const errors: unknown[] = [];
      if (this.controller) {
        try {
          if (current.identity) {
            await this.controller.markExited(current.identity);
          } else if (current.prepared) {
            await this.controller.abort({ child: current.child, prepared: current.prepared });
          }
        } catch (error) {
          errors.push(error);
        }
      }
      try {
        await stopQaGatewayChildProcessTree(
          current.child,
          !current.ready
            ? {
                gracefulTimeoutMs: 1_500,
                forceTimeoutMs: 1_500,
              }
            : undefined,
        );
        return { process: "confirmed-stopped", errors };
      } catch (error) {
        return { process: "unconfirmed", errors: [...errors, error] };
      }
    })();
    return current.settlement;
  }

  stop(opts?: QaGatewayStopOptions): Promise<QaGatewayStopResult> {
    // Close admission before any await: staging/acceptance/replacement cannot
    // spawn or resume a child after a caller has requested stop.
    this.closed = true;
    this.stopping ??= this.stopOnce(opts).then((result) => {
      if (result.errors.length) {
        this.stopping = null;
      }
      return result;
    });
    return this.stopping;
  }

  private async stopOnce(opts?: QaGatewayStopOptions): Promise<QaGatewayStopResult> {
    const settlement = await this.current?.settlement;
    if (settlement?.process === "unconfirmed" && this.current) {
      this.current.settlement = undefined;
    }
    await this.stopProcess();
    await this.operation?.catch(() => {});
    return this.finish(opts);
  }

  private async finish(opts?: QaGatewayStopOptions): Promise<QaGatewayStopResult> {
    const stopped = await this.stopProcess();
    const errors = [...stopped.errors];
    const attempt = async (cleanup: () => Promise<unknown>) => {
      try {
        await cleanup();
      } catch (error) {
        errors.push(error);
      }
    };
    await attempt(async () => this.portReservation?.release());
    await attempt(async () => this.rpcClient?.stop());
    // A surviving group can still write through inherited pipes. Keep its log
    // sinks owned until settlement; closing them early turns output into errors.
    if (stopped.process !== "unconfirmed") {
      for (const [label, stream] of this.logStreams) {
        await attempt(() => closeQaGatewayLogStream(stream, label));
      }
    }
    await attempt(async () => this.current?.checkFailure());
    const tempRoot = this.tempRoot;
    const keepTemp = opts?.keepTemp ?? this.keepTemp;
    let artifactsPreserved = true;
    if (tempRoot && opts?.preserveToDir && !keepTemp) {
      try {
        await preserveQaGatewayDebugArtifacts({
          preserveToDir: opts.preserveToDir,
          stdoutLogPath: path.join(tempRoot, "gateway.stdout.log"),
          stderrLogPath: path.join(tempRoot, "gateway.stderr.log"),
          tempRoot,
          repoRoot: this.repoRoot,
        });
      } catch (error) {
        artifactsPreserved = false;
        errors.push(
          new Error(`${formatErrorMessage(error)}\nQA gateway temp root preserved at ${tempRoot}`, {
            cause: error,
          }),
        );
      }
    }
    if (tempRoot && stopped.process !== "unconfirmed" && artifactsPreserved && !keepTemp) {
      await attempt(() =>
        cleanupQaGatewayTempRoots({
          tempRoot,
          stagedBundledPluginsRoot: this.stagedBundledPluginsRoot,
        }),
      );
    }
    return { process: stopped.process, errors };
  }
}
