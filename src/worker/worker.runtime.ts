import { chmod, mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { WorkerBrowserRuntime } from "./browser-runtime.js";
import { buildWorkerConnectParams, type WorkerLaunchDescriptor } from "./launch-descriptor.js";
import { createWorkerConnection, type WorkerConnectionState } from "./worker-connection.js";
import {
  WorkerInferenceProxyClient,
  WorkerLiveEventClient,
  WorkerTranscriptCommitClient,
} from "./worker-rpc-clients.js";

// Cross-process contract: serialized to stdout by runWorkerCommand and parsed by the
// gateway worker turn launcher.
export type WorkerRuntimeResult =
  | { status: "completed"; transcriptLeafId: string | null; transcriptNextSeq: number }
  | {
      status: "failed";
      reason: "turn-failed";
      transcriptLeafId: string | null;
      transcriptNextSeq: number;
    }
  | { status: "fenced"; reason: "credential-replaced" | "owner-epoch-mismatch" };

const WORKER_REMOTE_CANCEL_GRACE_MS = 1_000;

function toWorkerRuntimeError(value: unknown, fallback: string): Error {
  return value instanceof Error ? value : new Error(fallback, { cause: value });
}

function fencedResult(state: WorkerConnectionState): WorkerRuntimeResult | undefined {
  if (
    state.kind === "fenced" &&
    (state.reason === "credential-replaced" || state.reason === "owner-epoch-mismatch")
  ) {
    return { status: "fenced", reason: state.reason };
  }
  return undefined;
}

async function assertWorkspaceDirectory(workspaceDir: string): Promise<string> {
  const resolved = await realpath(workspaceDir);
  const workspaceStat = await stat(resolved);
  if (!workspaceStat.isDirectory()) {
    throw new Error("worker workspace path must be a directory");
  }
  return resolved;
}

export async function runWorkerDescriptor(
  descriptor: WorkerLaunchDescriptor,
  options: {
    signal?: AbortSignal;
    onConnectionFailure?: (cause: string | undefined) => void;
    browserRuntime?: WorkerBrowserRuntime;
  } = {},
): Promise<WorkerRuntimeResult> {
  const workspaceDir = await assertWorkspaceDirectory(descriptor.assignment.workspaceDir);
  const stateDir = await mkdtemp(path.join(tmpdir(), "openclaw-worker-"));
  await chmod(stateDir, 0o700);
  const previousStateDir = process.env.OPENCLAW_STATE_DIR;
  const previousConfigPath = process.env.OPENCLAW_CONFIG_PATH;
  process.env.OPENCLAW_STATE_DIR = stateDir;
  process.env.OPENCLAW_CONFIG_PATH = path.join(stateDir, "openclaw.json");

  const abortController = new AbortController();
  let turnStarted = false;
  let resultFenceAcked = false;
  let forcedStopTimer: NodeJS.Timeout | undefined;
  const connection = createWorkerConnection({
    endpoint: descriptor.connectionEndpoint,
    connectParams: buildWorkerConnectParams(descriptor),
    onConnectionFailure: (error) => options.onConnectionFailure?.(error?.message),
  });
  const abortFromCaller = () => {
    abortController.abort(options.signal?.reason);
    if (!turnStarted) {
      void connection.stop();
      return;
    }
    forcedStopTimer = setTimeout(() => {
      void connection.stop();
    }, WORKER_REMOTE_CANCEL_GRACE_MS);
    forcedStopTimer.unref();
  };
  options.signal?.addEventListener("abort", abortFromCaller, { once: true });
  if (options.signal?.aborted) {
    abortFromCaller();
  }
  const transcript = new WorkerTranscriptCommitClient(connection, {
    runEpoch: descriptor.admission.ownerEpoch,
    baseLeafId: descriptor.assignment.transcript.baseLeafId,
    initialSeq: descriptor.assignment.transcript.nextSeq,
  });
  const live = new WorkerLiveEventClient(connection, {
    runEpoch: descriptor.admission.ownerEpoch,
    initialAckedSeq: descriptor.assignment.liveEvents.ackedSeq,
  });
  const inference = new WorkerInferenceProxyClient(connection);
  const unsubscribeState = connection.onStateChange((state) => {
    if (state.kind === "fenced") {
      abortController.abort(new Error(`worker fenced: ${state.reason}`));
    } else if (state.kind === "failed") {
      abortController.abort(state.error);
    }
  });

  try {
    try {
      await connection.start();
    } catch (error) {
      const fenced = fencedResult(connection.state);
      if (fenced) {
        return fenced;
      }
      throw error;
    }
    const [{ runWorkerEmbeddedTurn }, { createWorkerInferenceStreamAdapter }] = await Promise.all([
      import("./embedded-agent.runtime.js"),
      import("./inference-stream.runtime.js"),
    ]);
    const stream = createWorkerInferenceStreamAdapter({
      client: inference,
      sessionId: descriptor.admission.sessionId,
      runEpoch: descriptor.admission.ownerEpoch,
      runId: descriptor.assignment.runId,
      turnId: descriptor.assignment.turnId,
      modelRef: descriptor.assignment.modelRef,
    });
    try {
      turnStarted = true;
      await runWorkerEmbeddedTurn({
        agentId: descriptor.assignment.agentId,
        operationalRunInstance: descriptor.assignment.operationalRunInstance,
        agentRuntimeIdentityToken: descriptor.assignment.agentRuntimeIdentityToken,
        cwd: workspaceDir,
        stateDir,
        sessionId: descriptor.admission.sessionId,
        sessionKey: `worker:${descriptor.admission.sessionId}`,
        runId: descriptor.assignment.runId,
        prompt: descriptor.assignment.prompt,
        suppressPromptTranscript: descriptor.assignment.suppressPromptTranscript,
        modelRef: descriptor.assignment.modelRef,
        initialMessages: descriptor.assignment.initialMessages,
        ...(descriptor.assignment.systemPrompt === undefined
          ? {}
          : { systemPrompt: descriptor.assignment.systemPrompt }),
        inferenceOptions: descriptor.assignment.inferenceOptions,
        allowedToolNames: descriptor.assignment.toolAuthority.allowedToolNames,
        ...(descriptor.assignment.browser ? { browser: descriptor.assignment.browser } : {}),
        ...(options.browserRuntime ? { browserRuntime: options.browserRuntime } : {}),
        inference: { stream },
        transcript: {
          commit: async (messages) => {
            await transcript.commit(messages);
          },
        },
        live: {
          enqueuePreview: (event) => live.enqueuePreview(descriptor.assignment.runId, event),
          emitTerminal: async (event) => {
            await live.emitTerminal(descriptor.assignment.runId, event);
            resultFenceAcked = true;
          },
        },
        sessions: connection,
        signal: abortController.signal,
      });
      if (options.signal?.aborted) {
        throw toWorkerRuntimeError(options.signal.reason, "worker interrupted");
      }
    } catch (error) {
      const fenced = fencedResult(connection.state);
      if (fenced) {
        return fenced;
      }
      if (options.signal?.aborted) {
        throw toWorkerRuntimeError(options.signal.reason, "worker interrupted");
      }
      if (resultFenceAcked && connection.state.kind === "ready") {
        return {
          status: "failed",
          reason: "turn-failed",
          transcriptLeafId: transcript.baseLeafId,
          transcriptNextSeq: transcript.nextSeq,
        };
      }
      throw toWorkerRuntimeError(error, "worker session failed");
    }
    const fenced = fencedResult(connection.state);
    if (fenced) {
      return fenced;
    }
    if (connection.state.kind === "failed") {
      throw connection.state.error;
    }
    return {
      status: "completed",
      transcriptLeafId: transcript.baseLeafId,
      transcriptNextSeq: transcript.nextSeq,
    };
  } finally {
    if (forcedStopTimer) {
      clearTimeout(forcedStopTimer);
    }
    unsubscribeState();
    options.signal?.removeEventListener("abort", abortFromCaller);
    inference.dispose();
    live.dispose();
    await connection.stop();
    if (previousStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
    if (previousConfigPath === undefined) {
      delete process.env.OPENCLAW_CONFIG_PATH;
    } else {
      process.env.OPENCLAW_CONFIG_PATH = previousConfigPath;
    }
    await rm(stateDir, { recursive: true, force: true });
  }
}
