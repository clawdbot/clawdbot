import { boundCodeModeError, toCodeModeJsonSafe } from "./code-mode-json.js";
import type { CodeModeConfig, SettledBridgeRequest } from "./code-mode-worker-types.js";

// A fixed control diagnostic is always available, even when payload admission is
// full. It retains no tool data; its fan-out is bounded by maxPendingToolCalls.
const INBOX_FULL_JSON = JSON.stringify(
  "Code Mode program-data budget exceeded. Paginate or narrow the tool request, or consume pending replies before requesting more data.",
);

const CANCELED_JSON = JSON.stringify("Code Mode tool canceled.");

export type CodeModeReplyLease = {
  settle: (ok: boolean, value: unknown) => void;
  take: () => SettledBridgeRequest;
  release: () => void;
  cancel: () => void;
};

/** Logical encoded-JSON allowance, not a bound on host RSS or guest memory. */
export class CodeModeProgramDataInbox {
  private readonly maxBytes: number;
  private readonly errorBytes: number;
  private bytes = 0;
  private closed = false;
  private readonly closers = new Set<() => void>();

  constructor(
    config: Pick<CodeModeConfig, "memoryLimitBytes" | "maxSnapshotBytes" | "maxOutputBytes">,
  ) {
    this.maxBytes = Math.min(config.memoryLimitBytes, config.maxSnapshotBytes);
    this.errorBytes = Math.min(config.maxOutputBytes, this.maxBytes);
  }

  createReply(id: string): CodeModeReplyLease {
    let state: "pending" | "ready" | "canceled" | "delivering" | "released" = "pending";
    let reply: SettledBridgeRequest | undefined;
    let bytes = 0;
    const clearPayload = () => {
      // Mutate the envelope before dropping it: caller frames may still alias
      // it, and clearing a pending array alone does not release those strings.
      if (reply) {
        reply.json = "";
      }
      reply = undefined;
      this.bytes -= bytes;
      bytes = 0;
    };
    const release = () => {
      if (state === "released") {
        return;
      }
      clearPayload();
      state = "released";
      this.closers.delete(close);
    };
    const close = () => {
      // Transport clones remain owned until consumption or termination.
      if (state !== "delivering") {
        release();
      }
    };
    const lease: CodeModeReplyLease = {
      settle: (ok, value) => {
        if (this.closed || state !== "pending") {
          return;
        }
        const json =
          JSON.stringify(
            ok ? toCodeModeJsonSafe(value) : normalizeReplyError(value, this.errorBytes),
          ) ?? "null";
        // Normalization may invoke tool-owned toJSON code, including cancellation.
        if (this.closed || state !== "pending") {
          return;
        }
        const required = Buffer.byteLength(json, "utf8");
        if (required > this.maxBytes - this.bytes) {
          reply = { id, ok: false, json: INBOX_FULL_JSON };
        } else {
          bytes = required;
          this.bytes += bytes;
          reply = { id, ok, json };
        }
        state = "ready";
      },
      take: () => {
        if ((state !== "ready" && state !== "canceled") || !reply) {
          throw new Error("Code Mode reply is unavailable.");
        }
        state = "delivering";
        return reply;
      },
      release,
      cancel: () => {
        if (this.closed) {
          close();
          return;
        }
        if (state !== "pending" && state !== "ready") {
          return;
        }
        clearPayload();
        // A live guest can catch request cancellation. This fixed control reply
        // retains neither arbitrary abort reasons nor a late tool result.
        reply = { id, ok: false, json: CANCELED_JSON };
        state = "canceled";
      },
    };
    if (this.closed) {
      release();
    } else {
      this.closers.add(close);
    }
    return lease;
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    for (const close of this.closers) {
      close();
    }
  }
}

function normalizeReplyError(value: unknown, maxBytes: number): unknown {
  if (value !== null && typeof value === "object" && "message" in value && "code" in value) {
    return {
      message: boundCodeModeError(String(value.message), maxBytes),
      code: String(value.code),
      effectStatus: "unknown",
    };
  }
  return boundCodeModeError(String(value), maxBytes);
}
