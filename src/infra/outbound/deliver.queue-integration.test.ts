import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { TrustedMessageAuditEvent } from "../../audit/message-audit-events.js";
import { onTrustedMessageAuditEventForTest as onTrustedMessageAuditEvent } from "../../audit/message-audit-events.test-support.js";
import type { ChannelOutboundAdapter } from "../../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../../config/config.js";
import { createEmptyPluginRegistry } from "../../plugins/registry.js";
import {
  releasePinnedPluginChannelRegistry,
  setActivePluginRegistry,
} from "../../plugins/runtime.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";
import { PlatformMessageNotDispatchedError } from "./deliver-types.js";
import { loadPendingDeliveries } from "./delivery-queue-storage.js";
import { drainPendingDeliveries, type DeliverFn } from "./delivery-queue.js";
import {
  createRecoveryLog,
  installDeliveryQueueTmpDirHooks,
} from "./delivery-queue.test-helpers.js";

let deliverOutboundPayloads: typeof import("./deliver.js").deliverOutboundPayloads;

type MatrixSendFn = (
  to: string,
  text: string,
  options?: Record<string, unknown>,
) => Promise<{ messageId: string } & Record<string, unknown>>;

function resolveMatrixSender(
  deps: Parameters<NonNullable<ChannelOutboundAdapter["sendText"]>>[0]["deps"],
): MatrixSendFn {
  const sender = deps?.matrix;
  if (typeof sender !== "function") {
    throw new Error("missing matrix sender");
  }
  return sender as MatrixSendFn;
}

function withMatrixChannel(result: Awaited<ReturnType<MatrixSendFn>>) {
  return {
    channel: "matrix" as const,
    ...result,
  };
}

const matrixOutboundForQueueTest: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  sendText: async ({ cfg, to, text, accountId, deps }) =>
    withMatrixChannel(
      await resolveMatrixSender(deps)(to, text, {
        cfg,
        accountId: accountId ?? undefined,
      }),
    ),
};

async function drainMatrixReconnect(opts: { deliver: DeliverFn; stateDir: string }): Promise<void> {
  await drainPendingDeliveries({
    drainKey: "matrix:reconnect-test",
    logLabel: "Matrix reconnect drain",
    cfg: {} as OpenClawConfig,
    log: createRecoveryLog(),
    stateDir: opts.stateDir,
    deliver: opts.deliver,
    selectEntry: (entry) => ({ match: entry.channel === "matrix", bypassBackoff: true }),
  });
}

function createPartialSendFailure() {
  return vi
    .fn()
    .mockResolvedValueOnce({ messageId: "m1" })
    .mockRejectedValueOnce(new Error("second payload send failed"));
}

async function deliverPartialMatrixBatch(sendMatrix: ReturnType<typeof vi.fn>, tmpDir: string) {
  process.env.OPENCLAW_STATE_DIR = tmpDir;
  await expect(
    deliverOutboundPayloads({
      cfg: {} as OpenClawConfig,
      channel: "matrix",
      to: "!room:example",
      payloads: [{ text: "first" }, { text: "second" }],
      deps: { matrix: sendMatrix },
      queuePolicy: "required",
    }),
  ).rejects.toThrow("second payload send failed");
}

describe("deliverOutboundPayloads queue integration: mid-batch failure with send evidence", () => {
  const fixtures = installDeliveryQueueTmpDirHooks();
  let tmpDir: string;

  beforeAll(async () => {
    ({ deliverOutboundPayloads } = await import("./deliver.js"));
  });

  beforeEach(() => {
    tmpDir = fixtures.tmpDir();
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "matrix",
          source: "test",
          plugin: createOutboundTestPlugin({ id: "matrix", outbound: matrixOutboundForQueueTest }),
        },
      ]),
    );
  });

  afterEach(() => {
    releasePinnedPluginChannelRegistry();
    setActivePluginRegistry(createEmptyPluginRegistry());
  });

  it("advances queued entry to unknown_after_send when a later payload fails after an earlier one succeeded", async () => {
    let sendCount = 0;
    let stateBeforeSecondSend: string | undefined;
    const sendMatrix = vi.fn(async () => {
      sendCount += 1;
      if (sendCount === 1) {
        return { messageId: "m1" };
      }
      stateBeforeSecondSend = (await loadPendingDeliveries(tmpDir))[0]?.recoveryState;
      throw new Error("second payload send failed");
    });

    await deliverPartialMatrixBatch(sendMatrix, tmpDir);

    expect(stateBeforeSecondSend).toBe("unknown_after_send");
    const entries = await loadPendingDeliveries(tmpDir);
    expect(entries).toHaveLength(1);
    const entry = expectDefined(entries[0], "entries[0] test invariant");
    expect(entry.recoveryState).toBe("unknown_after_send");
    expect(entry.retryCount).toBe(1);
    expect(entry.lastError).toContain("second payload send failed");
    expect(sendMatrix).toHaveBeenCalledTimes(2);
  });

  it("drain reports every payload unknown when an interrupted mixed batch cannot be reconciled", async () => {
    const auditEvents: TrustedMessageAuditEvent[] = [];
    const unsubscribe = onTrustedMessageAuditEvent((event) => auditEvents.push(event));
    const sendMatrix = createPartialSendFailure();

    await deliverPartialMatrixBatch(sendMatrix, tmpDir);
    expect(auditEvents).toEqual([]);

    const beforeDrain = await loadPendingDeliveries(tmpDir);
    expect(beforeDrain[0]?.recoveryState).toBe("unknown_after_send");

    const deliver = vi.fn<DeliverFn>(async () => {});
    await drainMatrixReconnect({ deliver, stateDir: tmpDir });
    unsubscribe();

    expect(deliver).not.toHaveBeenCalled();
    expect(await loadPendingDeliveries(tmpDir)).toHaveLength(0);
    expect(auditEvents).toHaveLength(2);
    expect(auditEvents.map((event) => event.sourceId)).toEqual([
      `message:outbound:queue:${beforeDrain[0]?.id}:payload:0`,
      `message:outbound:queue:${beforeDrain[0]?.id}:payload:1`,
    ]);
    expect(auditEvents.map((event) => event.outcome)).toEqual(["unknown", "unknown"]);
    expect(auditEvents.map((event) => event.resultCount)).toEqual([0, 0]);
  });

  it("does not retain a pre-send suppression across an ambiguous crash boundary", async () => {
    const auditEvents: TrustedMessageAuditEvent[] = [];
    const unsubscribe = onTrustedMessageAuditEvent((event) => auditEvents.push(event));
    process.env.OPENCLAW_STATE_DIR = tmpDir;
    const sendMatrix = vi.fn().mockRejectedValueOnce(new Error("ambiguous provider failure"));

    await expect(
      deliverOutboundPayloads({
        cfg: {} as OpenClawConfig,
        channel: "matrix",
        to: "!room:example",
        payloads: [{ text: "NO_REPLY" }, { text: "visible" }],
        deps: { matrix: sendMatrix },
        queuePolicy: "required",
      }),
    ).rejects.toThrow("ambiguous provider failure");

    const beforeDrain = await loadPendingDeliveries(tmpDir);
    expect(beforeDrain).toHaveLength(1);
    expect(beforeDrain[0]?.recoveryState).toBe("send_attempt_started");

    const deliver = vi.fn<DeliverFn>(async () => {});
    await drainMatrixReconnect({ deliver, stateDir: tmpDir });
    unsubscribe();

    expect(deliver).not.toHaveBeenCalled();
    expect(auditEvents.map((event) => event.outcome)).toEqual(["unknown", "unknown"]);
    expect(auditEvents.map((event) => event.resultCount)).toEqual([0, 0]);
  });

  it("retains retryable send-attempt state when an adapter fails before returning a result", async () => {
    process.env.OPENCLAW_STATE_DIR = tmpDir;
    const sendMatrix = vi.fn().mockRejectedValueOnce(new Error("first payload send failed"));

    await expect(
      deliverOutboundPayloads({
        cfg: {} as OpenClawConfig,
        channel: "matrix",
        to: "!room:example",
        payloads: [{ text: "first" }],
        deps: { matrix: sendMatrix },
        queuePolicy: "required",
      }),
    ).rejects.toThrow("first payload send failed");

    const entries = await import("./delivery-queue-storage.js").then((m) =>
      m.loadPendingDeliveries(tmpDir),
    );
    expect(entries).toHaveLength(1);
    const entry = expectDefined(entries[0], "entries[0] test invariant");
    expect(entry.retryCount).toBe(1);
    expect(entry.recoveryState).toBe("send_attempt_started");
    expect(entry.lastError).toContain("first payload send failed");
  });

  it("replays an entry after a proven pre-connect failure clears send evidence", async () => {
    process.env.OPENCLAW_STATE_DIR = tmpDir;
    const connectError = Object.assign(new Error("connect ECONNREFUSED"), {
      code: "ECONNREFUSED",
      syscall: "connect",
    });
    const sendMatrix = vi.fn().mockRejectedValueOnce(connectError);

    await expect(
      deliverOutboundPayloads({
        cfg: {} as OpenClawConfig,
        channel: "matrix",
        to: "!room:example",
        payloads: [{ text: "first" }],
        deps: { matrix: sendMatrix },
        queuePolicy: "required",
      }),
    ).rejects.toThrow("ECONNREFUSED");

    const beforeDrain = await loadPendingDeliveries(tmpDir);
    expect(beforeDrain).toHaveLength(1);
    expect(beforeDrain[0]).toMatchObject({
      retryCount: 1,
      lastError: expect.stringContaining("ECONNREFUSED"),
    });
    expect(beforeDrain[0]?.recoveryState).toBeUndefined();
    expect(beforeDrain[0]?.platformSendStartedAt).toBeUndefined();

    const recoverySendMatrix = vi
      .fn()
      .mockRejectedValueOnce(connectError)
      .mockResolvedValueOnce({ messageId: "recovered" });
    const deliver = vi.fn<DeliverFn>(async (params) =>
      deliverOutboundPayloads({
        ...params,
        deps: { matrix: recoverySendMatrix },
      }),
    );
    await drainMatrixReconnect({ deliver, stateDir: tmpDir });

    expect(deliver).toHaveBeenCalledTimes(1);
    const afterRepeatedFailure = await loadPendingDeliveries(tmpDir);
    expect(afterRepeatedFailure).toHaveLength(1);
    expect(afterRepeatedFailure[0]?.retryCount).toBe(2);
    expect(afterRepeatedFailure[0]?.recoveryState).toBeUndefined();
    expect(afterRepeatedFailure[0]?.platformSendStartedAt).toBeUndefined();

    await drainMatrixReconnect({ deliver, stateDir: tmpDir });

    expect(deliver).toHaveBeenCalledTimes(2);
    expect(recoverySendMatrix).toHaveBeenCalledTimes(2);
    expect(await loadPendingDeliveries(tmpDir)).toHaveLength(0);
  });

  it("replays an entry after the provider proves no platform message was dispatched", async () => {
    process.env.OPENCLAW_STATE_DIR = tmpDir;
    const notDispatchedError = new PlatformMessageNotDispatchedError(
      "upload timed out before completion dispatch",
      { cause: new Error("request timed out") },
    );
    const sendMatrix = vi.fn().mockRejectedValueOnce(notDispatchedError);

    await expect(
      deliverOutboundPayloads({
        cfg: {} as OpenClawConfig,
        channel: "matrix",
        to: "!room:example",
        payloads: [{ text: "first" }],
        deps: { matrix: sendMatrix },
        queuePolicy: "required",
      }),
    ).rejects.toThrow("upload timed out before completion dispatch");

    const beforeDrain = await loadPendingDeliveries(tmpDir);
    expect(beforeDrain).toHaveLength(1);
    expect(beforeDrain[0]?.recoveryState).toBeUndefined();
    expect(beforeDrain[0]?.platformSendStartedAt).toBeUndefined();

    const recoverySendMatrix = vi.fn().mockResolvedValueOnce({ messageId: "recovered" });
    const deliver = vi.fn<DeliverFn>(async (params) =>
      deliverOutboundPayloads({
        ...params,
        deps: { matrix: recoverySendMatrix },
      }),
    );
    await drainMatrixReconnect({ deliver, stateDir: tmpDir });

    expect(deliver).toHaveBeenCalledOnce();
    expect(recoverySendMatrix).toHaveBeenCalledOnce();
    expect(await loadPendingDeliveries(tmpDir)).toHaveLength(0);
  });
});
