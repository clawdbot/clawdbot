// Covers isolated heartbeat outbound session routing and base-session bookkeeping.
import { afterEach, describe, expect, it, vi } from "vitest";
import { heartbeatRunnerWhatsAppPlugin } from "../../test/helpers/infra/heartbeat-runner-channel-plugins.js";
import { createDeferred, withTestTimeout } from "../../test/helpers/promise.js";
import { clearSessionResetRuntimeState } from "../auto-reply/reply/session-reset-cleanup.js";
import { drainFormattedSystemEvents } from "../auto-reply/reply/session-system-events.js";
import type { ChannelPlugin } from "../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveMainSessionKey } from "../config/sessions.js";
import { buildChannelOutboundSessionRoute } from "../plugin-sdk/core.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createTestRegistry } from "../test-utils/channel-plugins.js";
import { resolveHeartbeatPreflight } from "./heartbeat-runner-prompt.js";
import { runHeartbeatOnce } from "./heartbeat-runner.js";
import { installHeartbeatRunnerTestRuntime } from "./heartbeat-runner.test-harness.js";
import {
  readSessionStoreForTest,
  seedHeartbeatScratchForTest,
  seedSessionStore,
  withTempHeartbeatSandbox,
} from "./heartbeat-runner.test-utils.js";
import { enqueueSystemEvent, resetSystemEventsForTest } from "./system-events.js";

type MockDeliveryRequest = {
  payloads?: Array<{ text?: string; mediaUrl?: string; mediaUrls?: string[] }>;
  onDeliveredPayload?: (payload: { text: string; mediaUrls: string[] }) => void;
};

const beforeMockDeliveryCompletion = vi.hoisted(() => vi.fn(async () => {}));
const beforeMockDeliveryConfirmation = vi.hoisted(() => vi.fn(async () => {}));
const deliverOutboundPayloadsInternal = vi.hoisted(() =>
  vi.fn(async (request: MockDeliveryRequest) => {
    const payload = request.payloads?.[0];
    await beforeMockDeliveryConfirmation();
    request.onDeliveredPayload?.({
      text: payload?.text ?? "",
      mediaUrls: [payload?.mediaUrl, ...(payload?.mediaUrls ?? [])].filter((url): url is string =>
        Boolean(url),
      ),
    });
    await beforeMockDeliveryCompletion();
    return [{ channel: "whatsapp", messageId: "msg-1" }];
  }),
);

vi.mock("./outbound/deliver.js", () => ({
  deliverOutboundPayloads: deliverOutboundPayloadsInternal,
  deliverOutboundPayloadsInternal,
}));

installHeartbeatRunnerTestRuntime();

afterEach(() => {
  beforeMockDeliveryConfirmation.mockReset();
  beforeMockDeliveryConfirmation.mockResolvedValue(undefined);
  beforeMockDeliveryCompletion.mockReset();
  beforeMockDeliveryCompletion.mockResolvedValue(undefined);
  deliverOutboundPayloadsInternal.mockClear();
  resetSystemEventsForTest();
});

type DeliveryRequest = {
  channel?: string;
  to?: string;
  session?: {
    key?: string;
    policyKey?: string;
  };
};

function latestDeliveryRequest(): DeliveryRequest {
  const [request] = deliverOutboundPayloadsInternal.mock.calls.at(-1) ?? [];
  if (!request || typeof request !== "object") {
    throw new Error("expected heartbeat delivery request");
  }
  return request as DeliveryRequest;
}

function makeIsolatedLastTargetConfig(tmpDir: string, storePath: string): OpenClawConfig {
  return {
    agents: {
      list: [{ id: "main", default: true }],
      defaults: {
        workspace: tmpDir,
        heartbeat: {
          every: "5m",
          target: "last",
          isolatedSession: true,
        },
      },
    },
    channels: { whatsapp: { allowFrom: ["*"] } },
    session: { store: storePath },
  };
}

function installWhatsAppRoute(options?: { exact?: boolean }) {
  const plugin: ChannelPlugin = {
    ...heartbeatRunnerWhatsAppPlugin,
    capabilities: {
      ...heartbeatRunnerWhatsAppPlugin.capabilities,
      chatTypes: ["direct"],
    },
    messaging: {
      ...heartbeatRunnerWhatsAppPlugin.messaging,
      targetResolver: { looksLikeId: () => true },
      ...(options?.exact === true
        ? {
            resolveOutboundSessionRoute: ({ cfg, agentId, accountId, target }) =>
              buildChannelOutboundSessionRoute({
                cfg,
                agentId,
                channel: "whatsapp",
                accountId,
                recipientSessionExact: true,
                peer: { kind: "direct", id: target },
                chatType: "direct",
                from: target,
                to: target,
              }),
          }
        : {}),
    },
  };
  setActivePluginRegistry(createTestRegistry([{ pluginId: "whatsapp", plugin, source: "test" }]));
}

async function seedExistingHeartbeatTarget(params: {
  tmpDir: string;
  storePath: string;
  exactRoute?: boolean;
}) {
  installWhatsAppRoute({ exact: params.exactRoute ?? true });
  const cfg = makeIsolatedLastTargetConfig(params.tmpDir, params.storePath);
  cfg.session = { ...cfg.session, dmScope: "per-channel-peer" };
  const baseSessionKey = resolveMainSessionKey(cfg);
  const target = "+15551234567";
  const targetSessionKey = `agent:main:whatsapp:direct:${target}`;
  const nowMs = Date.now();
  const delivery = {
    updatedAt: nowMs - 1_000,
    lastChannel: "whatsapp",
    lastProvider: "whatsapp",
    lastTo: target,
  };
  await seedSessionStore(params.storePath, baseSessionKey, {
    ...delivery,
    sessionId: "base-session",
  });
  const replaceTargetLifecycle = (lifecycleRevision: string) =>
    seedSessionStore(params.storePath, targetSessionKey, {
      ...delivery,
      sessionId: "target-session",
      lifecycleRevision,
    });
  await replaceTargetLifecycle("target-lifecycle-1");
  return { cfg, nowMs, target, targetSessionKey, replaceTargetLifecycle };
}

describe("runHeartbeatOnce - isolated heartbeat outbound session mirror", () => {
  it("uses the isolated run key for outbound delivery while the base session owns delivery state", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const cfg = makeIsolatedLastTargetConfig(tmpDir, storePath);
      const baseSessionKey = resolveMainSessionKey(cfg);
      const isolatedSessionKey = `${baseSessionKey}:heartbeat`;
      const nowMs = Date.now();
      await seedHeartbeatScratchForTest({
        content: "Check whether the user needs a status update.",
      });
      await seedSessionStore(storePath, baseSessionKey, {
        sessionId: "base-session",
        updatedAt: nowMs - 1_000,
        lastChannel: "whatsapp",
        lastProvider: "whatsapp",
        lastTo: "+15551234567",
      });
      replySpy.mockResolvedValueOnce({ text: "Status needs attention." });

      const result = await runHeartbeatOnce({
        cfg,
        deps: {
          getReplyFromConfig: replySpy,
          getQueueSize: () => 0,
          nowMs: () => nowMs,
        },
      });

      expect(result.status).toBe("ran");
      expect(replySpy.mock.calls[0]?.[0]).toMatchObject({
        SessionKey: isolatedSessionKey,
      });
      const deliveryRequest = latestDeliveryRequest();
      expect(deliveryRequest).toMatchObject({
        channel: "whatsapp",
        to: "+15551234567",
        session: {
          key: isolatedSessionKey,
          policyKey: baseSessionKey,
        },
      });

      const store = readSessionStoreForTest<{
        lastHeartbeatText?: string;
        lastHeartbeatSentAt?: number;
        heartbeatIsolatedBaseSessionKey?: string;
      }>(storePath);
      expect(store[baseSessionKey]).toMatchObject({
        lastHeartbeatText: "Status needs attention.",
        lastHeartbeatSentAt: nowMs,
      });
      expect(store[isolatedSessionKey]).toMatchObject({
        heartbeatIsolatedBaseSessionKey: baseSessionKey,
      });
      expect(store[isolatedSessionKey]?.lastHeartbeatText).toBeUndefined();
    });
  });

  it("keeps the base policy key when wake re-entry starts from the isolated key", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const cfg = makeIsolatedLastTargetConfig(tmpDir, storePath);
      const baseSessionKey = resolveMainSessionKey(cfg);
      const isolatedSessionKey = `${baseSessionKey}:heartbeat`;
      const nowMs = Date.now();

      await seedSessionStore(storePath, baseSessionKey, {
        sessionId: "base-session",
        updatedAt: nowMs - 1_000,
        lastChannel: "whatsapp",
        lastProvider: "whatsapp",
        lastTo: "+15551234567",
      });
      await seedSessionStore(storePath, isolatedSessionKey, {
        sessionId: "isolated-session",
        updatedAt: nowMs - 1_000,
        heartbeatIsolatedBaseSessionKey: baseSessionKey,
      });
      enqueueSystemEvent("Exec completed (mirror-reentry, code 0) :: result needs attention", {
        sessionKey: isolatedSessionKey,
      });
      replySpy.mockResolvedValueOnce({ text: "Wake result needs attention." });

      const result = await runHeartbeatOnce({
        cfg,
        sessionKey: isolatedSessionKey,
        source: "exec-event",
        intent: "event",
        reason: "exec-event",
        deps: {
          getReplyFromConfig: replySpy,
          getQueueSize: () => 0,
          nowMs: () => nowMs,
        },
      });

      expect(result.status).toBe("ran");
      expect(replySpy.mock.calls[0]?.[0]).toMatchObject({
        SessionKey: isolatedSessionKey,
      });
      expect(latestDeliveryRequest()).toMatchObject({
        channel: "whatsapp",
        to: "+15551234567",
        session: {
          key: isolatedSessionKey,
          policyKey: baseSessionKey,
        },
      });
    });
  });

  it("skips an ambient isolated poll when its base conversation is missing", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const cfg = makeIsolatedLastTargetConfig(tmpDir, storePath);
      const baseSessionKey = resolveMainSessionKey(cfg);
      const isolatedSessionKey = `${baseSessionKey}:heartbeat`;
      const nowMs = Date.now();
      await seedSessionStore(storePath, isolatedSessionKey, {
        sessionId: "isolated-session",
        updatedAt: nowMs - 1_000,
        lastChannel: "whatsapp",
        lastProvider: "whatsapp",
        lastTo: "+15551234567",
        heartbeatIsolatedBaseSessionKey: baseSessionKey,
      });

      const result = await runHeartbeatOnce({
        cfg,
        sessionKey: isolatedSessionKey,
        deps: {
          getReplyFromConfig: replySpy,
          getQueueSize: () => 0,
          nowMs: () => nowMs,
        },
      });

      expect(result).toEqual({ status: "skipped", reason: "no-route" });
      expect(replySpy).not.toHaveBeenCalled();
      expect(deliverOutboundPayloadsInternal).not.toHaveBeenCalled();
    });
  });

  it("queues a successful direct alert for the next ordinary target turn", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const { cfg, nowMs, target, targetSessionKey } = await seedExistingHeartbeatTarget({
        tmpDir,
        storePath,
      });
      const completionEntered = createDeferred();
      const releaseCompletion = createDeferred();
      beforeMockDeliveryCompletion.mockImplementationOnce(async () => {
        completionEntered.resolve();
        await releaseCompletion.promise;
      });
      replySpy.mockResolvedValueOnce({ text: "Status needs attention." });

      const heartbeat = runHeartbeatOnce({
        cfg,
        deps: {
          getReplyFromConfig: replySpy,
          getQueueSize: () => 0,
          nowMs: () => nowMs,
        },
      });
      let result!: Awaited<ReturnType<typeof runHeartbeatOnce>>;
      let pendingEventCount: number | undefined;
      let heartbeatModeAwareness: string | undefined;
      let awareness: string | undefined;
      try {
        await withTestTimeout(
          completionEntered.promise,
          5_000,
          "heartbeat delivery confirmation was not observed",
        );
        const nextHeartbeatPreflight = await resolveHeartbeatPreflight({
          cfg,
          agentId: "main",
          sessionKey: targetSessionKey,
          heartbeat: { isolatedSession: true },
        });
        pendingEventCount = nextHeartbeatPreflight.pendingEventEntries.length;
        heartbeatModeAwareness = await drainFormattedSystemEvents({
          cfg,
          agentId: "main",
          sessionKey: targetSessionKey,
          isMainSession: false,
          isNewSession: false,
          events: nextHeartbeatPreflight.pendingEventEntries,
        });
        awareness = await drainFormattedSystemEvents({
          cfg,
          agentId: "main",
          sessionKey: targetSessionKey,
          isMainSession: false,
          isNewSession: false,
        });
      } finally {
        releaseCompletion.resolve();
        result = await withTestTimeout(heartbeat, 5_000, "heartbeat did not finish delivery");
      }

      expect(result.status).toBe("ran");
      expect(latestDeliveryRequest()).toMatchObject({ channel: "whatsapp", to: target });
      expect(pendingEventCount).toBe(0);
      expect(heartbeatModeAwareness).toBeUndefined();
      expect(awareness).toContain("A heartbeat delivered this message to this channel:");
      expect(awareness).toContain("Status needs attention.");
      await expect(
        drainFormattedSystemEvents({
          cfg,
          agentId: "main",
          sessionKey: targetSessionKey,
          isMainSession: false,
          isNewSession: false,
        }),
      ).resolves.toBeUndefined();
    });
  });

  it("does not project an alert from an inexact fallback route", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const { cfg, nowMs, target, targetSessionKey } = await seedExistingHeartbeatTarget({
        tmpDir,
        storePath,
        exactRoute: false,
      });
      replySpy.mockResolvedValueOnce({ text: "Status needs attention." });

      const result = await runHeartbeatOnce({
        cfg,
        deps: {
          getReplyFromConfig: replySpy,
          getQueueSize: () => 0,
          nowMs: () => nowMs,
        },
      });

      expect(result.status).toBe("ran");
      expect(latestDeliveryRequest()).toMatchObject({ channel: "whatsapp", to: target });
      await expect(
        drainFormattedSystemEvents({
          cfg,
          agentId: "main",
          sessionKey: targetSessionKey,
          isMainSession: false,
          isNewSession: false,
        }),
      ).resolves.toBeUndefined();
    });
  });

  it("does not project a direct alert when platform delivery fails", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const { cfg, nowMs, targetSessionKey } = await seedExistingHeartbeatTarget({
        tmpDir,
        storePath,
      });
      replySpy.mockResolvedValueOnce({ text: "Status needs attention." });
      deliverOutboundPayloadsInternal.mockRejectedValueOnce(new Error("channel unavailable"));

      const result = await runHeartbeatOnce({
        cfg,
        deps: {
          getReplyFromConfig: replySpy,
          getQueueSize: () => 0,
          nowMs: () => nowMs,
        },
      });

      expect(result.status).toBe("failed");
      await expect(
        drainFormattedSystemEvents({
          cfg,
          agentId: "main",
          sessionKey: targetSessionKey,
          isMainSession: false,
          isNewSession: false,
        }),
      ).resolves.toBeUndefined();
    });
  });

  it("lets a reset clear awareness after delivery is identified", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const { cfg, nowMs, targetSessionKey } = await seedExistingHeartbeatTarget({
        tmpDir,
        storePath,
      });
      const completionEntered = createDeferred();
      const releaseCompletion = createDeferred();
      beforeMockDeliveryCompletion.mockImplementationOnce(async () => {
        completionEntered.resolve();
        await releaseCompletion.promise;
      });
      replySpy.mockResolvedValueOnce({ text: "Status needs attention." });

      const heartbeat = runHeartbeatOnce({
        cfg,
        deps: {
          getReplyFromConfig: replySpy,
          getQueueSize: () => 0,
          nowMs: () => nowMs,
        },
      });
      let result!: Awaited<ReturnType<typeof runHeartbeatOnce>>;
      let systemEventsCleared: number | undefined;
      try {
        await withTestTimeout(
          completionEntered.promise,
          5_000,
          "heartbeat delivery confirmation was not observed",
        );
        systemEventsCleared = clearSessionResetRuntimeState([targetSessionKey], {
          agentId: "main",
        }).systemEventsCleared;
      } finally {
        releaseCompletion.resolve();
        result = await withTestTimeout(heartbeat, 5_000, "heartbeat did not finish delivery");
      }

      expect(result.status).toBe("ran");
      expect(systemEventsCleared).toBe(1);
      await expect(
        drainFormattedSystemEvents({
          cfg,
          agentId: "main",
          sessionKey: targetSessionKey,
          isMainSession: false,
          isNewSession: false,
        }),
      ).resolves.toBeUndefined();
    });
  });

  it("does not attach an alert after the target lifecycle resets during delivery", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const { cfg, nowMs, targetSessionKey, replaceTargetLifecycle } =
        await seedExistingHeartbeatTarget({ tmpDir, storePath });
      replySpy.mockResolvedValueOnce({ text: "Status needs attention." });
      beforeMockDeliveryConfirmation.mockImplementationOnce(() =>
        replaceTargetLifecycle("target-lifecycle-2"),
      );

      const result = await runHeartbeatOnce({
        cfg,
        deps: {
          getReplyFromConfig: replySpy,
          getQueueSize: () => 0,
          nowMs: () => nowMs,
        },
      });

      expect(result.status).toBe("ran");
      await expect(
        drainFormattedSystemEvents({
          cfg,
          agentId: "main",
          sessionKey: targetSessionKey,
          isMainSession: false,
          isNewSession: false,
        }),
      ).resolves.toBeUndefined();
    });
  });
});
