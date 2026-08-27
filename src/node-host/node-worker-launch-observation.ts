import {
  appendCapturedOutput,
  createCapturedOutputBuffers,
  finalizeCapturedOutput,
} from "../process/exec-output.js";
import type { NodeWorkerTerminalState } from "./node-worker-launch-store.js";
import type { NodeWorkerChildAdapter } from "./node-worker-launch-transport.js";
import {
  NODE_WORKER_STDERR_MAX_BYTES,
  NODE_WORKER_STDOUT_MAX_BYTES,
  parseNodeWorkerSuccessfulResult,
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

/** Decode one bounded, credential-scrubbed worker result after durable admission. */
export async function observeNodeWorkerChildOutput(
  active: NodeWorkerChildObservation,
): Promise<NodeWorkerTerminalOutcome> {
  const stdout = createCapturedOutputBuffers();
  const stderr = createCapturedOutputBuffers();
  active.adapter.onStdout((chunk) =>
    appendCapturedOutput(stdout, chunk, NODE_WORKER_STDOUT_MAX_BYTES, "head"),
  );
  active.adapter.onStderr((chunk) =>
    appendCapturedOutput(
      stderr,
      chunk,
      NODE_WORKER_STDERR_MAX_BYTES + active.scrubber.maxRepresentationBytes,
      "tail",
    ),
  );
  try {
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
    if (exit.code === 0 && exit.signal === null) {
      try {
        return Object.freeze({
          state: "completed",
          resultJson: parseNodeWorkerSuccessfulResult(stdout, active.scrubber.scrub),
        });
      } catch (error) {
        return Object.freeze({
          state: "failed",
          errorText: sanitizeNodeWorkerDiagnostic(
            error,
            "invalid worker result",
            active.scrubber.scrub,
          ),
        });
      }
    }
    const detail = finalizeCapturedOutput(stderr, "tail", true).toString("utf8");
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
