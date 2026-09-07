import { createBoundedLineFramer } from "../process/bounded-line-framer.js";
import {
  appendCapturedOutput,
  createCapturedOutputBuffers,
  finalizeCapturedOutput,
} from "../process/exec-output.js";
import {
  parseWorkerProcessResult,
  type WorkerProcessResult,
} from "../worker/worker-process-protocol.js";
import type { NodeWorkerTerminalState } from "./node-worker-launch-store.js";
import type { NodeWorkerChildAdapter } from "./node-worker-launch-transport.js";
import {
  NODE_WORKER_STDERR_MAX_BYTES,
  NODE_WORKER_STDOUT_MAX_BYTES,
  parseNodeWorkerOutputJson,
  sanitizeNodeWorkerDiagnostic,
  type NodeWorkerCredentialScrubber,
} from "./node-worker-output.js";

export type NodeWorkerTerminalOutcome = Readonly<{
  state: NodeWorkerTerminalState;
  resultJson?: string;
  errorText?: string;
}>;

type NodeWorkerChildObservation = {
  adapter: NodeWorkerChildAdapter;
  journalReady: Promise<void>;
  scrubber: NodeWorkerCredentialScrubber;
  connectionFailure: { errorText?: string };
  stopState?: Extract<NodeWorkerTerminalState, "cancelled" | "interrupted">;
};

/** Turn results settle independently; process exit alone releases the physical owner. */
export async function observeNodeWorkerChildOutput(
  active: NodeWorkerChildObservation,
  onResult: (frame: WorkerProcessResult) => void,
  currentTurnId: () => string | undefined,
): Promise<NodeWorkerTerminalOutcome> {
  let stdout = "";
  const framer = createBoundedLineFramer(
    NODE_WORKER_STDOUT_MAX_BYTES,
    `worker stdout exceeded ${NODE_WORKER_STDOUT_MAX_BYTES} bytes`,
  );
  let lastResult: string | undefined;
  let outputError: unknown;
  let journaled = false;
  const drain = () => {
    if (!journaled || outputError) {
      return;
    }
    try {
      const chunk = Buffer.from(stdout, "utf8");
      stdout = "";
      for (const line of framer.push(chunk)) {
        const frame = parseWorkerProcessResult(
          JSON.parse(parseNodeWorkerOutputJson(line.toString("utf8"), active.scrubber.scrub)),
        );
        if (!frame) {
          throw new Error("worker returned an invalid turn result");
        }
        onResult(frame);
        lastResult = JSON.stringify(frame.result);
      }
    } catch (error) {
      outputError = error;
      stdout = "";
      framer.clear();
      active.adapter.kill("SIGKILL");
    }
  };
  let stderr = createCapturedOutputBuffers();
  let diagnosticTurnId = currentTurnId();
  const currentStderr = () => {
    if (diagnosticTurnId !== currentTurnId()) {
      // Old raw diagnostics must not outlive the credential scrubber that owns them.
      stderr = createCapturedOutputBuffers();
      diagnosticTurnId = currentTurnId();
    }
    return stderr;
  };
  active.adapter.onStdout((chunk) => {
    if (outputError) {
      return;
    }
    stdout += chunk;
    if (!journaled && Buffer.byteLength(stdout, "utf8") > NODE_WORKER_STDOUT_MAX_BYTES) {
      outputError = new Error(`worker stdout exceeded ${NODE_WORKER_STDOUT_MAX_BYTES} bytes`);
      stdout = "";
      active.adapter.kill("SIGKILL");
    }
    drain();
  });
  active.adapter.onStderr((chunk) =>
    appendCapturedOutput(
      currentStderr(),
      chunk,
      NODE_WORKER_STDERR_MAX_BYTES + active.scrubber.maxRepresentationBytes,
      "tail",
    ),
  );
  try {
    void active.journalReady.then(() => {
      journaled = true;
      drain();
    });
    const exit = await active.adapter.wait();
    await active.journalReady;
    if (active.stopState) {
      return Object.freeze({
        state: active.stopState,
        errorText:
          active.connectionFailure.errorText ??
          (active.stopState === "cancelled"
            ? "node worker launch cancelled"
            : "node worker launch interrupted during node-host shutdown"),
      });
    }
    if (outputError || framer.pendingByteLength > 0 || (exit.code === 0 && !lastResult)) {
      return Object.freeze({
        state: "failed",
        errorText: sanitizeNodeWorkerDiagnostic(
          outputError ?? new Error("worker exited without a complete turn result"),
          "invalid worker result",
          active.scrubber.scrub,
        ),
      });
    }
    if (exit.code === 0 && exit.signal === null && lastResult) {
      return Object.freeze({ state: "completed", resultJson: lastResult });
    }
    const detail = finalizeCapturedOutput(currentStderr(), "tail", true).toString("utf8");
    const exitLabel = exit.signal ? `signal ${exit.signal}` : `exit code ${String(exit.code)}`;
    return Object.freeze({
      state: "failed",
      errorText:
        active.connectionFailure.errorText ??
        sanitizeNodeWorkerDiagnostic(
          `node worker failed with ${exitLabel}${detail ? `: ${detail}` : ""}`,
          "node worker failed",
          active.scrubber.scrub,
        ),
    });
  } catch (error) {
    await active.journalReady;
    return Object.freeze({
      state: active.stopState ?? "failed",
      errorText:
        active.connectionFailure.errorText ??
        sanitizeNodeWorkerDiagnostic(error, "node worker wait failed", active.scrubber.scrub),
    });
  } finally {
    active.adapter.dispose();
  }
}
