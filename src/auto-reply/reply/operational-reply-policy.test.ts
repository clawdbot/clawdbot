import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import { markReplyPayloadForSourceSuppressionDelivery } from "../reply-payload.js";
import {
  applyOperationalReplyPolicy,
  isOperationalReplyPayload,
  markOperationalReplyPolicyDelivered,
} from "./operational-reply-policy.js";
import { clearOperationalReplyPolicyStateForTest } from "./operational-reply-policy.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function createSessionStoreFixture(params?: {
  operationalReplyOnceKeys?: string[];
  operationalReplyPendingOnceKeys?: string[];
}) {
  const root = tempDirs.make("openclaw-operational-reply-policy-");
  const storePath = path.join(root, "sessions.json");
  const sessionKey = "agent:main:visiblechat:direct:user";
  const entry: SessionEntry = {
    sessionId: "s1",
    updatedAt: Date.now(),
    ...(params?.operationalReplyOnceKeys
      ? { operationalReplyOnceKeys: params.operationalReplyOnceKeys }
      : {}),
    ...(params?.operationalReplyPendingOnceKeys
      ? { operationalReplyPendingOnceKeys: params.operationalReplyPendingOnceKeys }
      : {}),
  };
  await replaceSessionEntry({ sessionKey, storePath }, entry);
  return { sessionKey, storePath };
}

async function readSessionStoreEntry(storePath: string, sessionKey: string): Promise<SessionEntry> {
  const entry = loadSessionEntry({ sessionKey, storePath, readConsistency: "latest" });
  if (!entry) {
    throw new Error(`missing session fixture entry: ${sessionKey}`);
  }
  return entry;
}

function onceConfig(storePath?: string): OpenClawConfig {
  return {
    ...(storePath ? { session: { store: storePath } } : {}),
    messages: { operationalReplies: { policy: "once" } },
  } as OpenClawConfig;
}

function applyOncePolicy(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  storePath?: string;
  text: string;
}) {
  return applyOperationalReplyPolicy({
    cfg: params.cfg,
    payload: markReplyPayloadForSourceSuppressionDelivery({
      text: params.text,
      isError: true,
    }),
    explicitCommandTurn: false,
    sendPolicyDenied: false,
    sourceSessionKey: params.sessionKey,
    sourceStorePath: params.storePath,
    sourceEventKey: "event-1",
    sourceChannel: "visiblechat",
  });
}

function applyMemoryOncePolicy(text: string) {
  return applyOperationalReplyPolicy({
    cfg: onceConfig(),
    payload: markReplyPayloadForSourceSuppressionDelivery({
      text,
      isError: true,
    }),
    explicitCommandTurn: false,
    sendPolicyDenied: false,
    sourceChannel: "visiblechat",
    sourceEventKey: "event-1",
  });
}

describe("operational reply policy", () => {
  beforeEach(() => {
    clearOperationalReplyPolicyStateForTest();
  });

  afterEach(() => {
    clearOperationalReplyPolicyStateForTest();
  });

  it("classifies plain error payloads without delivery metadata as operational", async () => {
    const payload = { text: "provider failed", isError: true };

    expect(isOperationalReplyPayload({ payload, explicitCommandTurn: false })).toBe(true);
    await expect(
      applyOperationalReplyPolicy({
        cfg: { messages: { operationalReplies: { policy: "silent" } } } as OpenClawConfig,
        payload,
        explicitCommandTurn: false,
        sendPolicyDenied: false,
        sourceEventKey: "event-1",
      }),
    ).resolves.toMatchObject({ intentionalSilence: true, shouldDeliver: false });
  });

  it("fails redirect before source suppression when no target is available", async () => {
    await expect(
      applyOperationalReplyPolicy({
        cfg: { messages: { operationalReplies: { policy: "redirect" } } } as OpenClawConfig,
        payload: { text: "provider failed", isError: true },
        explicitCommandTurn: false,
        sendPolicyDenied: false,
        sourceEventKey: "event-1",
      }),
    ).rejects.toThrow("redirectSessionKey is required");
  });

  it("reserves once keys before delivery and releases failed deliveries", async () => {
    const { sessionKey, storePath } = await createSessionStoreFixture();
    const cfg = onceConfig(storePath);

    const first = await applyOncePolicy({
      cfg,
      sessionKey,
      storePath,
      text: "backend failed",
    });
    const duplicateWhilePending = await applyOncePolicy({
      cfg,
      sessionKey,
      storePath,
      text: "backend failed",
    });

    expect(first.shouldDeliver).toBe(true);
    expect(duplicateWhilePending.shouldDeliver).toBe(false);

    await markOperationalReplyPolicyDelivered(first, false);

    const retryAfterFailure = await applyOncePolicy({
      cfg,
      sessionKey,
      storePath,
      text: "backend failed",
    });

    expect(retryAfterFailure.shouldDeliver).toBe(true);

    await markOperationalReplyPolicyDelivered(retryAfterFailure, true);

    const duplicateAfterSuccess = await applyOncePolicy({
      cfg,
      sessionKey,
      storePath,
      text: "backend failed",
    });

    expect(duplicateAfterSuccess.shouldDeliver).toBe(false);
  });

  it("allows only one concurrent once reservation", async () => {
    const { sessionKey, storePath } = await createSessionStoreFixture();
    const cfg = onceConfig(storePath);

    const results = await Promise.all([
      applyOncePolicy({ cfg, sessionKey, storePath, text: "concurrent notice" }),
      applyOncePolicy({ cfg, sessionKey, storePath, text: "concurrent notice" }),
    ]);

    expect(results.filter((result) => result.shouldDeliver)).toHaveLength(1);
    const reserved = results.find((result) => result.shouldDeliver);
    if (!reserved) {
      throw new Error("expected one concurrent reservation");
    }
    await markOperationalReplyPolicyDelivered(reserved, true);
  });

  it("retries stale durable pending once reservations after restart", async () => {
    const { sessionKey, storePath } = await createSessionStoreFixture();
    const cfg = onceConfig(storePath);

    const first = await applyOncePolicy({
      cfg,
      sessionKey,
      storePath,
      text: "backend failed after reservation",
    });

    expect(first.shouldDeliver).toBe(true);

    const pendingEntry = await readSessionStoreEntry(storePath, sessionKey);
    expect(pendingEntry.operationalReplyOnceKeys).toBeUndefined();
    expect(pendingEntry.operationalReplyPendingOnceKeys).toEqual([expect.any(String)]);

    clearOperationalReplyPolicyStateForTest();

    const retryAfterRestart = await applyOncePolicy({
      cfg,
      sessionKey,
      storePath,
      text: "backend failed after reservation",
    });

    expect(retryAfterRestart.shouldDeliver).toBe(true);

    await markOperationalReplyPolicyDelivered(retryAfterRestart, true);

    const deliveredEntry = await readSessionStoreEntry(storePath, sessionKey);
    expect(deliveredEntry.operationalReplyPendingOnceKeys).toBeUndefined();
    expect(deliveredEntry.operationalReplyOnceKeys).toEqual([expect.any(String)]);

    clearOperationalReplyPolicyStateForTest();

    const duplicateAfterDelivery = await applyOncePolicy({
      cfg,
      sessionKey,
      storePath,
      text: "backend failed after reservation",
    });

    expect(duplicateAfterDelivery.shouldDeliver).toBe(false);
  });

  it("bounds in-memory once keys to the same recent delivered window", async () => {
    for (let index = 0; index < 1025; index += 1) {
      const result = await applyMemoryOncePolicy(`memory bounded notice ${index}`);
      expect(result.shouldDeliver).toBe(true);
      await markOperationalReplyPolicyDelivered(result, true);
    }

    const firstAgain = await applyMemoryOncePolicy("memory bounded notice 0");

    expect(firstAgain.shouldDeliver).toBe(true);
  });
});
