import type { CommandOptions, SpawnResult } from "../../process/exec.js";
import { type PreparedWorkerSsh, runWorkerSshCandidates, workerSshCommandOptions } from "./ssh.js";
import {
  runBoundedInboundRsync as runBoundedInboundRsyncTransfer,
  workerWorkspaceRsyncRemoteCommand,
} from "./workspace-sync-helpers.js";

type WorkerWorkspaceRsyncTransportOptions = {
  ownerSignal: AbortSignal;
  runTask: (argv: string[], options: CommandOptions) => Promise<SpawnResult>;
  timeoutMs: number;
};

/** Runs fresh workspace transfers through the lifecycle's advertised SSH candidates. */
export function createWorkerWorkspaceRsyncTransport(options: WorkerWorkspaceRsyncTransportOptions) {
  const runRsync = async (
    prepared: PreparedWorkerSsh,
    argv: (rsyncSsh: string) => string[],
  ): Promise<SpawnResult> =>
    await runWorkerSshCandidates(
      prepared,
      async (port) =>
        await options.runTask(
          argv(workerWorkspaceRsyncRemoteCommand(prepared, port)),
          workerSshCommandOptions({
            timeoutMs: options.timeoutMs,
            signal: options.ownerSignal,
          }),
        ),
    );

  const runBoundedInboundRsync = async (params: {
    prepared: PreparedWorkerSsh;
    argv: (rsyncSsh: string) => string[];
    destinationRoot: string;
    entryLimit: number;
    totalByteLimit: number;
  }): Promise<SpawnResult> =>
    await runWorkerSshCandidates(
      params.prepared,
      async (port) =>
        await runBoundedInboundRsyncTransfer({
          argv: params.argv(workerWorkspaceRsyncRemoteCommand(params.prepared, port)),
          destinationRoot: params.destinationRoot,
          entryLimit: params.entryLimit,
          totalByteLimit: params.totalByteLimit,
          ownerSignal: options.ownerSignal,
          runTask: options.runTask,
          timeoutMs: options.timeoutMs,
        }),
    );

  return { runBoundedInboundRsync, runRsync };
}
