/**
 * Debounced steering queue for forwarding user text to an active Codex
 * app-server turn.
 */
import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { CodexAppServerClient } from "./client.js";
import type { CodexUserInput } from "./protocol.js";

const CODEX_STEER_ALL_DEBOUNCE_MS = 500;

/** Per-message options for Codex steering queue behavior. */
export type CodexSteeringQueueOptions = {
  debounceMs?: number;
};

/**
 * Creates a queue that batches steer text while still serializing app-server
 * `turn/steer` requests.
 */
export function createCodexSteeringQueue(params: {
  client: CodexAppServerClient;
  threadId: string;
  turnId: string;
  answerPendingUserInput: (text: string) => boolean;
  signal: AbortSignal;
}) {
  type PendingSteerText = {
    text: string;
    resolve: () => void;
    reject: (error: unknown) => void;
  };
  let batchedTexts: PendingSteerText[] = [];
  let batchTimer: NodeJS.Timeout | undefined;
  let sendChain: Promise<void> = Promise.resolve();

  const clearBatchTimer = () => {
    if (batchTimer) {
      clearTimeout(batchTimer);
      batchTimer = undefined;
    }
  };

  const sendTexts = async (texts: string[]) => {
    if (texts.length === 0) {
      return;
    }
    if (params.signal.aborted) {
      throw new Error("codex app-server steering queue aborted");
    }
    await params.client.request("turn/steer", {
      threadId: params.threadId,
      expectedTurnId: params.turnId,
      input: texts.map(toCodexTextInput),
    });
  };

  const enqueueSend = (texts: string[]) => {
    const send = sendChain.then(() => sendTexts(texts));
    sendChain = send.catch((error: unknown) => {
      embeddedAgentLog.debug("codex app-server queued steer failed", { error });
    });
    return send;
  };

  const flushBatch = () => {
    clearBatchTimer();
    const items = batchedTexts;
    batchedTexts = [];
    const send = enqueueSend(items.map((item) => item.text));
    void send.then(
      () => {
        for (const item of items) {
          item.resolve();
        }
      },
      (error: unknown) => {
        for (const item of items) {
          item.reject(error);
        }
      },
    );
    return send;
  };

  return {
    async queue(text: string, options?: CodexSteeringQueueOptions) {
      if (params.answerPendingUserInput(text)) {
        return;
      }
      return await new Promise<void>((resolve, reject) => {
        batchedTexts.push({ text, resolve, reject });
        clearBatchTimer();
        const debounceMs = normalizeCodexSteerDebounceMs(options?.debounceMs);
        if (debounceMs === 0) {
          void flushBatch().catch(() => undefined);
          return;
        }
        batchTimer = setTimeout(() => {
          batchTimer = undefined;
          void flushBatch().catch(() => undefined);
        }, debounceMs);
      });
    },
    async flushPending() {
      await flushBatch().catch(() => undefined);
    },
    cancel() {
      clearBatchTimer();
      const items = batchedTexts;
      batchedTexts = [];
      for (const item of items) {
        item.reject(new Error("codex app-server steering queue cancelled"));
      }
    },
  };
}

/** Normalizes steer debounce milliseconds, preserving explicit zero. */
function normalizeCodexSteerDebounceMs(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : CODEX_STEER_ALL_DEBOUNCE_MS;
}

/** Converts plain text into the Codex app-server user-input shape. */
function toCodexTextInput(text: string): CodexUserInput {
  return { type: "text", text, text_elements: [] };
}
