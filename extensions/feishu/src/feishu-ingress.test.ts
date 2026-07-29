// Feishu durable ingress tests cover ack gating, recovery, tombstones, and logical twins.
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type * as Lark from "@larksuiteoapi/node-sdk";
import {
  closeOpenClawStateDatabaseForTest,
  createChannelIngressQueueForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { createNonExitingRuntimeEnv } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { feishuDedupeState } from "./dedup-state.js";
import { claimUnprocessedFeishuMessage } from "./dedup.js";
import { resolveFeishuMessageDedupeKey } from "./dedupe-key.js";
import type { FeishuMessageEvent } from "./event-types.js";
import {
  buildFeishuFlushIngressLifecycle,
  createFeishuDurableIngress,
  type FeishuIngressLifecycle,
} from "./feishu-ingress.js";
import { monitorWebhook } from "./monitor.transport.js";
import { getFreePort, waitUntilServerReady } from "./monitor.webhook.test-helpers.js";
import type { ResolvedFeishuAccount } from "./types.js";

type FeishuIngressQueue = NonNullable<Parameters<typeof createFeishuDurableIngress>[0]["queue"]>;
type FeishuIngressPayload = Parameters<FeishuIngressQueue["enqueue"]>[1];

function messageEnvelope(params: {
  eventId: string;
  messageId?: string;
  chatId?: string;
  createTime?: string;
  text?: string;
}) {
  return {
    schema: "2.0",
    header: {
      event_id: params.eventId,
      event_type: "im.message.receive_v1",
      create_time: "1710000000000",
    },
    event: {
      sender: {
        sender_id: { open_id: "ou-user" },
        sender_type: "user",
      },
      message: {
        message_id: params.messageId ?? "om-message",
        chat_id: params.chatId ?? "oc-chat",
        chat_type: "p2p",
        message_type: "text",
        content: JSON.stringify({ text: params.text ?? "hello" }),
        create_time: params.createTime ?? "1710000000000",
      },
    },
  };
}

function flattenEnvelope(envelope: ReturnType<typeof messageEnvelope>) {
  return { ...envelope.header, ...envelope.event };
}

function createLifecycle() {
  const calls = {
    adopted: vi.fn(async () => {}),
    deferred: vi.fn(),
    finalizing: vi.fn(),
    abandoned: vi.fn(async () => {}),
  };
  const lifecycle: FeishuIngressLifecycle = {
    abortSignal: new AbortController().signal,
    onAdopted: calls.adopted,
    onDeferred: calls.deferred,
    onAdoptionFinalizing: calls.finalizing,
    onAbandoned: calls.abandoned,
  };
  return { calls, lifecycle };
}

function createDispatcher(
  run: (data: ReturnType<typeof messageEnvelope>) => unknown = async () => undefined,
): Pick<Lark.EventDispatcher, "invoke"> {
  return {
    invoke: async (data) => await run(data as ReturnType<typeof messageEnvelope>),
  };
}

function startIngress(params: {
  queue: FeishuIngressQueue;
  dispatcher: Pick<Lark.EventDispatcher, "invoke">;
}) {
  return createFeishuDurableIngress({
    accountId: "default",
    queue: params.queue,
    dispatcher: params.dispatcher,
    runtime: { error: vi.fn(), log: vi.fn() },
    pollIntervalMs: 60_000,
    adoptionStallTimeoutMs: 5_000,
  });
}

async function withQueue<T>(fn: (queue: FeishuIngressQueue, stateDir: string) => Promise<T>) {
  const created = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-feishu-ingress-"));
  const stateDir = await fs.realpath(created);
  const previousStateDir = process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_STATE_DIR = stateDir;
  const queue = createChannelIngressQueueForTests<FeishuIngressPayload>({
    channelId: "feishu",
    accountId: "default",
    stateDir,
  });
  try {
    return await fn(queue, stateDir);
  } finally {
    feishuDedupeState.reset();
    closeOpenClawStateDatabaseForTest();
    if (previousStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
    await fs.rm(stateDir, { recursive: true, force: true });
  }
}

function signWebhookBody(rawBody: string, encryptKey: string): Record<string, string> {
  const timestamp = "1711111111";
  const nonce = "feishu-ingress-test";
  return {
    "content-type": "application/json",
    "x-lark-request-timestamp": timestamp,
    "x-lark-request-nonce": nonce,
    "x-lark-signature": crypto
      .createHash("sha256")
      .update(timestamp + nonce + encryptKey + rawBody)
      .digest("hex"),
  };
}

async function withWebhook(
  eventDispatcher: Pick<Lark.EventDispatcher, "invoke">,
  run: (url: string) => Promise<void>,
) {
  const port = await getFreePort();
  const webhookPath = "/feishu-ingress-test";
  const encryptKey = "feishu-ingress-test-key";
  const account = {
    accountId: "default",
    encryptKey,
    config: { webhookHost: "127.0.0.1", webhookPort: port, webhookPath },
  } as ResolvedFeishuAccount;
  const abortController = new AbortController();
  const monitor = monitorWebhook({
    account,
    accountId: account.accountId,
    eventDispatcher: eventDispatcher as Lark.EventDispatcher,
    abortSignal: abortController.signal,
    runtime: createNonExitingRuntimeEnv(),
  });
  const url = `http://127.0.0.1:${port}${webhookPath}`;
  await waitUntilServerReady(url);
  try {
    await run(url);
  } finally {
    abortController.abort();
    await monitor;
  }
}

async function postWebhook(url: string, envelope: ReturnType<typeof messageEnvelope>) {
  const rawBody = JSON.stringify(envelope);
  return await fetch(url, {
    method: "POST",
    headers: signWebhookBody(rawBody, "feishu-ingress-test-key"),
    body: rawBody,
  });
}

afterEach(() => {
  feishuDedupeState.reset();
  closeOpenClawStateDatabaseForTest();
  vi.restoreAllMocks();
});

describe("Feishu durable ingress", () => {
  it("waits for durable append before acknowledging the webhook", async () => {
    await withQueue(async (queue) => {
      let releaseAppend!: () => void;
      const appendGate = new Promise<void>((resolve) => {
        releaseAppend = resolve;
      });
      const enqueue = vi.fn(async (...args: Parameters<FeishuIngressQueue["enqueue"]>) => {
        await appendGate;
        return await queue.enqueue(...args);
      });
      const gatedQueue = { ...queue, enqueue } as FeishuIngressQueue;
      const ingress = startIngress({ queue: gatedQueue, dispatcher: createDispatcher() });

      await withWebhook({ invoke: ingress.invoke }, async (url) => {
        let responseSettled = false;
        const responsePromise = postWebhook(
          url,
          messageEnvelope({ eventId: "evt-append-gate" }),
        ).then((response) => {
          responseSettled = true;
          return response;
        });
        await vi.waitFor(() => expect(enqueue).toHaveBeenCalledTimes(1));
        expect(responseSettled).toBe(false);

        releaseAppend();
        await expect(responsePromise.then((response) => response.status)).resolves.toBe(200);
      });
      await ingress.stop();
    });
  });

  it("returns non-2xx when durable append fails", async () => {
    await withQueue(async (queue) => {
      const enqueue = vi.fn(async () => {
        throw new Error("sqlite unavailable");
      });
      const failingQueue = { ...queue, enqueue } as FeishuIngressQueue;
      const dispatch = vi.fn(async () => undefined);
      const ingress = startIngress({ queue: failingQueue, dispatcher: createDispatcher(dispatch) });

      await withWebhook({ invoke: ingress.invoke }, async (url) => {
        const response = await postWebhook(url, messageEnvelope({ eventId: "evt-append-fail" }));
        expect(response.status).toBe(500);
      });

      expect(enqueue).toHaveBeenCalledTimes(3);
      expect(dispatch).not.toHaveBeenCalled();
      await ingress.stop();
    });
  });

  it("recovers an uncompleted envelope with a fresh drain and dispatches exactly once", async () => {
    await withQueue(async (queue) => {
      const interrupted = startIngress({ queue, dispatcher: createDispatcher() });
      await interrupted.invoke(messageEnvelope({ eventId: "evt-restart" }), { needCheck: false });
      await interrupted.stop();

      const dispatch = vi.fn(async (data: ReturnType<typeof messageEnvelope>) => {
        await recovered.resolveLifecycle(flattenEnvelope(data))?.onAdopted();
      });
      const recovered = startIngress({ queue, dispatcher: createDispatcher(dispatch) });
      recovered.start();
      await recovered.waitForIdle();

      expect(dispatch).toHaveBeenCalledTimes(1);
      expect((await queue.enqueue("evt-restart", {} as FeishuIngressPayload)).kind).toBe(
        "completed",
      );
      await recovered.stop();
    });
  });

  it("retains completion so one event_id dispatches only once", async () => {
    await withQueue(async (queue) => {
      const dispatch = vi.fn(async (data: ReturnType<typeof messageEnvelope>) => {
        await ingress.resolveLifecycle(flattenEnvelope(data))?.onAdopted();
      });
      const ingress = startIngress({ queue, dispatcher: createDispatcher(dispatch) });
      ingress.start();
      const envelope = messageEnvelope({ eventId: "evt-completed" });

      await ingress.invoke(envelope, { needCheck: false });
      await ingress.waitForIdle();
      await ingress.invoke(envelope, { needCheck: false });
      await ingress.waitForIdle();

      expect(dispatch).toHaveBeenCalledTimes(1);
      await ingress.stop();
    });
  });

  it("dead-letters authentication failures without retrying", async () => {
    await withQueue(async (queue) => {
      const dispatch = vi.fn(async () => {
        throw Object.assign(new Error("unauthorized"), { status: 401 });
      });
      const ingress = startIngress({ queue, dispatcher: createDispatcher(dispatch) });
      ingress.start();
      const envelope = messageEnvelope({ eventId: "evt-auth-failure" });

      await ingress.invoke(envelope, { needCheck: false });
      await ingress.waitForIdle();

      expect(dispatch).toHaveBeenCalledTimes(1);
      const duplicate = await queue.enqueue("evt-auth-failure", {} as FeishuIngressPayload);
      expect(duplicate.kind).toBe("failed");
      if (duplicate.kind === "failed") {
        expect(duplicate.record.reason).toBe("authentication-failed");
      }
      await ingress.stop();
    });
  });

  it("durably dead-letters recognized envelopes without conversation identity", async () => {
    await withQueue(async (queue) => {
      const dispatch = vi.fn(async () => undefined);
      const ingress = startIngress({ queue, dispatcher: createDispatcher(dispatch) });
      ingress.start();
      const envelope = messageEnvelope({ eventId: "evt-missing-chat" });
      delete (envelope.event.message as { chat_id?: string }).chat_id;

      await expect(ingress.invoke(envelope, { needCheck: false })).resolves.toBeUndefined();
      await ingress.waitForIdle();

      expect(dispatch).not.toHaveBeenCalled();
      const duplicate = await queue.enqueue("evt-missing-chat", {} as FeishuIngressPayload);
      expect(duplicate.kind).toBe("failed");
      if (duplicate.kind === "failed") {
        expect(duplicate.record.reason).toBe("invalid-event");
      }
      await ingress.stop();
    });
  });

  it("keeps transient dispatch failures retryable", async () => {
    await withQueue(async (queue) => {
      const dispatch = vi.fn(async () => {
        throw new Error("temporary network failure");
      });
      const ingress = startIngress({ queue, dispatcher: createDispatcher(dispatch) });
      ingress.start();
      const envelope = messageEnvelope({ eventId: "evt-transient-failure" });

      await ingress.invoke(envelope, { needCheck: false });
      await ingress.waitForIdle();

      expect(dispatch).toHaveBeenCalledTimes(1);
      await expect(
        queue.enqueue("evt-transient-failure", {} as FeishuIngressPayload),
      ).resolves.toMatchObject({ kind: "pending", duplicate: true });
      await ingress.stop();
    });
  });

  it("keeps unrelated downstream syntax failures retryable", async () => {
    await withQueue(async (queue) => {
      const dispatch = vi.fn(async () => {
        throw new SyntaxError("temporary API response parse failure");
      });
      const ingress = startIngress({ queue, dispatcher: createDispatcher(dispatch) });
      ingress.start();
      const envelope = messageEnvelope({ eventId: "evt-downstream-syntax" });

      await ingress.invoke(envelope, { needCheck: false });
      await ingress.waitForIdle();

      expect(dispatch).toHaveBeenCalledTimes(1);
      await expect(
        queue.enqueue("evt-downstream-syntax", {} as FeishuIngressPayload),
      ).resolves.toMatchObject({ kind: "pending", duplicate: true });
      await ingress.stop();
    });
  });

  it("keeps the permanent logical guard for different event_id and message_id twins", async () => {
    await withQueue(async () => {
      const firstEnvelope = messageEnvelope({
        eventId: "evt-twin-a",
        messageId: "om-twin-a",
      });
      const secondEnvelope = messageEnvelope({
        eventId: "evt-twin-b",
        messageId: "om-twin-b",
      });
      const first = firstEnvelope.event as FeishuMessageEvent;
      const second = secondEnvelope.event as FeishuMessageEvent;
      const firstKey = resolveFeishuMessageDedupeKey(first);
      const secondKey = resolveFeishuMessageDedupeKey(second);
      expect(firstEnvelope.header.event_id).not.toBe(secondEnvelope.header.event_id);
      expect(firstKey).toBe(secondKey);

      const claim = await claimUnprocessedFeishuMessage({
        messageId: firstKey,
        namespace: "default",
      });
      expect(claim.kind).toBe("claimed");
      if (claim.kind !== "claimed") {
        throw new Error(`expected claimed logical twin, received ${claim.kind}`);
      }
      const transport = createLifecycle();
      const { lifecycle } = buildFeishuFlushIngressLifecycle([
        { lifecycle: transport.lifecycle, replayClaim: claim.handle },
      ]);
      lifecycle?.onAdoptionFinalizing();
      await lifecycle?.onAdopted();

      await expect(
        claimUnprocessedFeishuMessage({ messageId: secondKey, namespace: "default" }),
      ).resolves.toEqual({ kind: "duplicate" });
      expect(transport.calls.finalizing).toHaveBeenCalledTimes(1);
      expect(transport.calls.adopted).toHaveBeenCalledTimes(1);
    });
  });

  it("does not reopen adopted transport claims when a logical guard commit fails", async () => {
    const transport = createLifecycle();
    const onReplayCommitError = vi.fn();
    const replayClaim = {
      keys: ["failing-adoption"] as const,
      commit: vi.fn(async () => {
        throw new Error("dedupe persistence failed");
      }),
      release: vi.fn(),
    };
    const { lifecycle } = buildFeishuFlushIngressLifecycle(
      [{ lifecycle: transport.lifecycle, replayClaim }],
      { onReplayCommitError },
    );

    await expect(lifecycle?.onAdopted()).resolves.toBeUndefined();

    expect(transport.calls.adopted).toHaveBeenCalledTimes(1);
    expect(transport.calls.abandoned).not.toHaveBeenCalled();
    expect(onReplayCommitError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "dedupe persistence failed" }),
    );
  });

  it("abandons logical claims when transport adoption persistence fails", async () => {
    const transport = createLifecycle();
    transport.lifecycle.onAdopted = vi.fn(async () => {
      throw new Error("queue completion failed");
    });
    const replayClaim = {
      keys: ["transport-adoption-failure"] as const,
      commit: vi.fn(async () => true),
      release: vi.fn(),
    };
    const { lifecycle } = buildFeishuFlushIngressLifecycle([
      { lifecycle: transport.lifecycle, replayClaim },
    ]);

    await expect(lifecycle?.onAdopted()).rejects.toThrow("queue completion failed");

    expect(replayClaim.commit).not.toHaveBeenCalled();
    expect(replayClaim.release).toHaveBeenCalledTimes(1);
    expect(transport.calls.abandoned).toHaveBeenCalledTimes(1);
  });

  it("does not adopt while constituent abandonment is in progress", async () => {
    const transport = createLifecycle();
    let finishAbandonment!: () => void;
    const abandonmentGate = new Promise<void>((resolve) => {
      finishAbandonment = resolve;
    });
    transport.lifecycle.onAbandoned = vi.fn(async () => await abandonmentGate);
    const replayClaim = {
      keys: ["concurrent-terminal-state"] as const,
      commit: vi.fn(async () => true),
      release: vi.fn(),
    };
    const { lifecycle } = buildFeishuFlushIngressLifecycle([
      { lifecycle: transport.lifecycle, replayClaim },
    ]);

    const abandonment = lifecycle?.onAbandoned();
    await vi.waitFor(() => {
      expect(transport.lifecycle.onAbandoned).toHaveBeenCalledTimes(1);
    });
    const adoption = lifecycle?.onAdopted();
    expect(transport.calls.adopted).not.toHaveBeenCalled();

    finishAbandonment();
    await Promise.all([abandonment, adoption]);

    expect(transport.calls.adopted).not.toHaveBeenCalled();
    expect(replayClaim.commit).not.toHaveBeenCalled();
    expect(replayClaim.release).toHaveBeenCalledTimes(1);
  });

  it("abandons a gated claim when terminal completion persistence fails", async () => {
    const transport = createLifecycle();
    transport.lifecycle.onAdopted = vi.fn(async () => {
      throw new Error("queue completion failed");
    });
    const { settle } = buildFeishuFlushIngressLifecycle([{ lifecycle: transport.lifecycle }]);

    await expect(settle()).rejects.toThrow("queue completion failed");

    expect(transport.calls.finalizing).toHaveBeenCalledTimes(1);
    expect(transport.calls.abandoned).toHaveBeenCalledTimes(1);
  });

  it("finalizes gated claims before persisting terminal completion", async () => {
    const transport = createLifecycle();
    const { settle } = buildFeishuFlushIngressLifecycle([{ lifecycle: transport.lifecycle }]);

    await settle();

    expect(transport.calls.finalizing).toHaveBeenCalledTimes(1);
    expect(transport.calls.adopted).toHaveBeenCalledTimes(1);
    expect(transport.calls.finalizing.mock.invocationCallOrder[0]).toBeLessThan(
      transport.calls.adopted.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
  });

  it("does not settle an observer fallback after an active reply lane defers", async () => {
    const transport = createLifecycle();
    const { lifecycle, settle } = buildFeishuFlushIngressLifecycle([
      { lifecycle: transport.lifecycle },
    ]);

    lifecycle?.onDeferred();
    await settle();

    expect(transport.calls.deferred).toHaveBeenCalledTimes(1);
    expect(transport.calls.adopted).not.toHaveBeenCalled();

    await lifecycle?.onAdopted();
    expect(transport.calls.adopted).toHaveBeenCalledTimes(1);
  });
});
