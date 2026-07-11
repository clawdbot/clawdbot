// Covers isolated heartbeat outbound session routing and base-session bookkeeping.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveMainSessionKey } from "../config/sessions.js";
import { runHeartbeatOnce } from "./heartbeat-runner.js";
import { installHeartbeatRunnerTestRuntime } from "./heartbeat-runner.test-harness.js";
import {
  readSessionStoreForTest,
  seedSessionStore,
  withTempHeartbeatSandbox,
} from "./heartbeat-runner.test-utils.js";

const deliverOutboundPayloadsInternal = vi.hoisted(() =>
  vi.fn().mockResolvedValue([{ channel: "whatsapp", messageId: "msg-1" }]),
);

vi.mock("./outbound/deliver.js", () => ({
  deliverOutboundPayloads: deliverOutboundPayloadsInternal,
  deliverOutboundPayloadsInternal,
}));

installHeartbeatRunnerTestRuntime();

afterEach(() => {
  deliverOutboundPayloadsInternal.mockClear();
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

describe("runHeartbeatOnce - isolated heartbeat outbound session mirror", () => {
  it("uses the isolated run key for outbound delivery while base session owns target and state", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const cfg = makeIsolatedLastTargetConfig(tmpDir, storePath);
      const baseSessionKey = resolveMainSessionKey(cfg);
      const isolatedSessionKey = `${baseSessionKey}:heartbeat`;
      const nowMs = Date.now();
      await fs.writeFile(
        path.join(tmpDir, "HEARTBEAT.md"),
        `tasks:
  - name: check-in
    interval: 5m
    prompt: "Check whether the user needs a status update."
`,
        "utf-8",
      );
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
        heartbeatTaskState?: Record<string, number>;
        lastHeartbeatText?: string;
        lastHeartbeatSentAt?: number;
        heartbeatIsolatedBaseSessionKey?: string;
      }>(storePath);
      expect(store[baseSessionKey]).toMatchObject({
        heartbeatTaskState: { "check-in": nowMs },
        lastHeartbeatText: "Status needs attention.",
        lastHeartbeatSentAt: nowMs,
      });
      expect(store[isolatedSessionKey]).toMatchObject({
        heartbeatIsolatedBaseSessionKey: baseSessionKey,
      });
      expect(store[isolatedSessionKey]?.heartbeatTaskState).toBeUndefined();
      expect(store[isolatedSessionKey]?.lastHeartbeatText).toBeUndefined();
    });
  });

  it("keeps the base policy key when wake re-entry starts from the isolated key", async () => {
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
      replySpy.mockResolvedValueOnce({ text: "Wake result needs attention." });

      const result = await runHeartbeatOnce({
        cfg,
        sessionKey: isolatedSessionKey,
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
});
