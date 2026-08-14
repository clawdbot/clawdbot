import path from "node:path";
import type { SpawnResult } from "../../process/exec.js";
import type { WorkerWorkspaceCommand, WorkerWorkspaceQuiescence } from "./tunnel-contract.js";
import {
  REMOTE_WORKSPACE_QUIESCE_JS,
  REMOTE_WORKSPACE_RENEW_QUIESCENCE_JS,
  REMOTE_WORKSPACE_RESUME_JS,
} from "./workspace-quiescence-scripts.js";
import {
  waitForQuiescenceRenewal,
  workerWorkspaceCommandSucceeded,
  workspaceQuiescenceError,
} from "./workspace-sync-helpers.js";

const WORKSPACE_QUIESCENCE_TIMEOUT_MS = 12 * 60_000;
const WORKSPACE_QUIESCENCE_RENEW_INTERVAL_MS = 3 * 60_000;

export function createWorkerWorkspaceQuiescence(params: {
  ownerSignal: AbortSignal;
  sharedHost: boolean;
  runWorkspaceCommand: (command: WorkerWorkspaceCommand) => Promise<SpawnResult>;
}): (remoteWorkspaceDir: string) => Promise<WorkerWorkspaceQuiescence> {
  return async (remoteWorkspaceDir) => {
    if (!path.posix.isAbsolute(remoteWorkspaceDir)) {
      throw new Error("Worker workspace quiescence path must be absolute");
    }
    const hostMode = params.sharedHost ? "shared-host" : "dedicated";
    const run = async (argv: string[]) => {
      const result = await params.runWorkspaceCommand({ transportRetry: "never", argv });
      if (!workerWorkspaceCommandSucceeded(result)) {
        throw workspaceQuiescenceError(result);
      }
      return result;
    };
    const result = await run([
      "node",
      "-e",
      REMOTE_WORKSPACE_QUIESCE_JS,
      remoteWorkspaceDir,
      String(WORKSPACE_QUIESCENCE_TIMEOUT_MS),
      hostMode,
    ]);
    const acknowledgement = /^quiesced ([a-f0-9]{32})$/u.exec(result.stdout.trim());
    if (!acknowledgement) {
      throw new Error("Worker workspace quiescence returned an invalid acknowledgement");
    }
    const nonce = acknowledgement[1]!;
    let resumed = false;
    let renewalFailure: unknown;
    const renewalAbort = new AbortController();
    const abortRenewal = () => renewalAbort.abort(params.ownerSignal.reason);
    params.ownerSignal.addEventListener("abort", abortRenewal, { once: true });
    let renewalQueue = Promise.resolve();
    const renew = (validationMode: "heartbeat" | "final") => {
      const operation = renewalQueue.then(async () => {
        const renewedResult = await run([
          "node",
          "-e",
          REMOTE_WORKSPACE_RENEW_QUIESCENCE_JS,
          remoteWorkspaceDir,
          nonce,
          String(WORKSPACE_QUIESCENCE_TIMEOUT_MS),
          validationMode,
          hostMode,
        ]);
        if (renewedResult.stdout.trim() !== `renewed ${nonce}`) {
          throw new Error(
            "Worker workspace quiescence renewal returned an invalid acknowledgement",
          );
        }
      });
      renewalQueue = operation.catch(() => undefined);
      return operation;
    };
    const renewalLoop = (async () => {
      while (!renewalAbort.signal.aborted) {
        if (
          !(await waitForQuiescenceRenewal(
            renewalAbort.signal,
            WORKSPACE_QUIESCENCE_RENEW_INTERVAL_MS,
          ))
        ) {
          return;
        }
        try {
          await renew("heartbeat");
        } catch (error) {
          renewalFailure = error;
          return;
        }
      }
    })();
    return {
      assertActive: async () => {
        if (resumed) {
          throw new Error("Worker workspace quiescence was already released");
        }
        if (renewalFailure) {
          throw new Error("Worker workspace quiescence renewal failed", {
            cause: renewalFailure,
          });
        }
        await renew("final");
      },
      resume: async () => {
        if (resumed) {
          return;
        }
        params.ownerSignal.removeEventListener("abort", abortRenewal);
        renewalAbort.abort();
        await renewalLoop;
        await run(["node", "-e", REMOTE_WORKSPACE_RESUME_JS, remoteWorkspaceDir, nonce]);
        resumed = true;
      },
    };
  };
}
