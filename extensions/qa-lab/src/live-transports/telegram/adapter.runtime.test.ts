import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  acquireQaCredentialLease: vi.fn(),
  assertQaGatewayCredentialLeaseQuarantine: vi.fn(),
  createStateRoot: vi.fn(),
  heartbeatStop: vi.fn(),
  heartbeatThrowIfFailed: vi.fn(),
  leaseHeartbeat: vi.fn(),
  leaseRelease: vi.fn(),
  loadTelegramUserbotSkillRuntime: vi.fn(),
  proxyClose: vi.fn(),
  proxyDrainUpdates: vi.fn(),
  restoreCredential: vi.fn(),
  shouldRetainQaGatewayCredentialLease: vi.fn(),
  startApiProxy: vi.fn(),
  userbotAssertHealthy: vi.fn(),
  userbotClose: vi.fn(),
  userbotSend: vi.fn(),
  userbotStart: vi.fn(),
}));

vi.mock("../shared/credential-lease.runtime.js", () => ({
  acquireQaCredentialLease: mocks.acquireQaCredentialLease,
  startQaCredentialLeaseHeartbeat: () => ({
    stop: mocks.heartbeatStop,
    throwIfFailed: mocks.heartbeatThrowIfFailed,
    whenFailed: new Promise<Error>(() => {}),
  }),
}));

vi.mock("../../gateway-process-boundary.js", () => ({
  assertQaGatewayCredentialLeaseQuarantine: mocks.assertQaGatewayCredentialLeaseQuarantine,
  shouldRetainQaGatewayCredentialLease: mocks.shouldRetainQaGatewayCredentialLease,
}));

vi.mock("./userbot-driver.runtime.js", () => ({
  TelegramUserbotDriver: { start: mocks.userbotStart },
}));

vi.mock("./userbot-skill.runtime.js", () => ({
  loadTelegramUserbotSkillRuntime: mocks.loadTelegramUserbotSkillRuntime,
}));

import { createTelegramQaTransportAdapter } from "./adapter.runtime.js";

const credential = {
  schemaVersion: 1,
  environment: "test",
  groupId: "-100123",
  sutToken: "sut-token",
  sutUsername: "sut_bot",
  sutBotId: "200",
  testerUserId: "100",
  tdlibArchiveBase64: "YQ==",
  tdlibArchiveSha256: "a".repeat(64),
  tdlibVersion: "1.8.67",
} as const;

describe("Telegram QA transport adapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "telegram-adapter-test-"));
    mocks.createStateRoot.mockReturnValue(stateRoot);
    mocks.acquireQaCredentialLease.mockResolvedValue({
      payload: credential,
      source: "convex",
      heartbeat: mocks.leaseHeartbeat,
      release: mocks.leaseRelease,
    });
    mocks.loadTelegramUserbotSkillRuntime.mockResolvedValue({
      userDriverPath: "/skill/user-driver.py",
      createStateRoot: mocks.createStateRoot,
      parseCredential: vi.fn(),
      restoreCredential: mocks.restoreCredential,
      startApiProxy: mocks.startApiProxy,
    });
    mocks.restoreCredential.mockReturnValue({
      ...credential,
      stateRoot,
      userDriverDir: path.join(stateRoot, "user-driver"),
      driverEnv: { TELEGRAM_USER_DRIVER_STATE_DIR: path.join(stateRoot, "user-driver") },
    });
    mocks.startApiProxy.mockResolvedValue({
      apiRoot: "http://127.0.0.1:3210",
      close: mocks.proxyClose,
      drainUpdates: mocks.proxyDrainUpdates,
    });
    mocks.userbotStart.mockResolvedValue({
      assertHealthy: mocks.userbotAssertHealthy,
      close: mocks.userbotClose,
      send: mocks.userbotSend,
    });
    mocks.proxyDrainUpdates.mockResolvedValue(undefined);
    mocks.shouldRetainQaGatewayCredentialLease.mockResolvedValue(false);
  });

  it("leases a Test Server userbot and configures the SUT proxy", async () => {
    const adapter = await createTelegramQaTransportAdapter({
      adapterOptions: {
        credentialSource: "convex",
        credentialRole: "ci",
        repoRoot: "/checkout",
        transportPolicy: { requireGroupMention: true },
      },
      messages: {},
    } as never);

    expect(mocks.acquireQaCredentialLease).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "telegram-test-userbot", source: "convex", role: "ci" }),
    );
    expect(mocks.loadTelegramUserbotSkillRuntime).toHaveBeenCalledWith({
      repoRoot: "/checkout",
    });
    expect(mocks.proxyDrainUpdates).toHaveBeenCalledWith("sut-token");
    expect(mocks.startApiProxy).toHaveBeenCalledWith({
      assertHealthy: expect.any(Function),
      whenUnhealthy: expect.any(Promise),
    });
    expect(adapter.createGatewayConfig?.({ baseUrl: "http://127.0.0.1:1234" })).toMatchObject({
      channels: {
        telegram: {
          accounts: {
            sut: {
              apiRoot: "http://127.0.0.1:3210",
              groups: {
                "-100123": {
                  allowFrom: ["100"],
                  requireMention: true,
                },
              },
            },
          },
        },
      },
    });

    await adapter.cleanup?.();
    await adapter.cleanupAfterGatewayStop?.();
  });

  it("passes terminal heartbeat state to the Bot API proxy", async () => {
    const adapter = await createTelegramQaTransportAdapter({
      adapterOptions: {},
      messages: {},
    } as never);
    const leaseHealth = mocks.startApiProxy.mock.calls[0]?.[0];
    mocks.heartbeatThrowIfFailed.mockImplementationOnce(() => {
      throw new Error("lease revoked");
    });

    expect(() => leaseHealth.assertHealthy()).toThrow("lease revoked");
    expect(mocks.proxyDrainUpdates).toHaveBeenCalledTimes(1);

    await adapter.cleanup?.();
    await adapter.cleanupAfterGatewayStop?.();
  });

  it("maps sends, replies, messages, and edits through one userbot process", async () => {
    let onUpdate: ((update: unknown) => Promise<void>) | undefined;
    mocks.userbotStart.mockImplementation(async (params) => {
      onUpdate = params.onUpdate;
      return {
        assertHealthy: mocks.userbotAssertHealthy,
        close: mocks.userbotClose,
        send: mocks.userbotSend,
      };
    });
    mocks.userbotSend
      .mockImplementationOnce(async () => {
        await onUpdate?.({
          kind: "message",
          chatId: -100123,
          messageId: 11,
          senderId: 200,
          senderUsername: "sut_bot",
          replyToMessageId: 10,
          timestamp: 100_000,
          text: "preview",
        });
        return { messageId: 10 };
      })
      .mockResolvedValueOnce({ messageId: 12 });
    const addInboundMessage = vi.fn().mockResolvedValue({ id: "in-1" });
    const addOutboundMessage = vi.fn().mockResolvedValue({ id: "out-1" });
    const editMessage = vi.fn();
    const adapter = await createTelegramQaTransportAdapter({
      adapterOptions: {},
      messages: { addInboundMessage, addOutboundMessage, editMessage },
    } as never);

    await adapter.sendInbound?.({
      conversation: { id: "logical-room", kind: "group" },
      senderId: "driver",
      text: "@openclaw reply exactly: QA-MARKER",
    });
    expect(mocks.userbotSend).toHaveBeenCalledWith({
      text: "@sut_bot reply exactly: QA-MARKER",
      replyToMessageId: undefined,
    });
    expect(addInboundMessage).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: "sut", senderId: "100" }),
    );

    expect(addOutboundMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "group:logical-room",
        text: "preview",
        replyToId: "in-1",
      }),
    );

    await adapter.sendInbound?.({
      conversation: { id: "logical-room", kind: "group" },
      senderId: "driver",
      text: "follow-up",
      replyToId: "out-1",
    });
    expect(mocks.userbotSend).toHaveBeenLastCalledWith({
      text: "follow-up",
      replyToMessageId: 11,
    });

    await onUpdate?.({
      kind: "edit",
      chatId: -100123,
      messageId: 11,
      senderId: 200,
      timestamp: 101_000,
      text: "final",
    });
    expect(editMessage).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: "out-1", text: "final", timestamp: 101_000 }),
    );

    await adapter.cleanup?.();
    await adapter.cleanupAfterGatewayStop?.();
  });

  it("filters other updates and resets diagnostics without native values", async () => {
    let onUpdate: ((update: unknown) => Promise<void>) | undefined;
    mocks.userbotStart.mockImplementation(async (params) => {
      onUpdate = params.onUpdate;
      return {
        assertHealthy: mocks.userbotAssertHealthy,
        close: mocks.userbotClose,
        send: mocks.userbotSend,
      };
    });
    const addOutboundMessage = vi.fn().mockResolvedValue({ id: "out-1" });
    const adapter = await createTelegramQaTransportAdapter({
      adapterOptions: {},
      messages: { addOutboundMessage },
    } as never);

    await onUpdate?.({
      kind: "message",
      chatId: -100999,
      messageId: 77,
      senderId: 200,
      timestamp: 100_000,
      text: "wrong chat",
    });
    await onUpdate?.({
      kind: "edit",
      chatId: -100123,
      messageId: 78,
      senderId: 200,
      timestamp: 101_000,
      text: "matched",
    });

    const diagnostics = adapter.describeTransportState?.() ?? "";
    expect(diagnostics).toContain("updates=2");
    expect(diagnostics).toContain("filtered=1");
    expect(diagnostics).toContain("matched=1");
    expect(diagnostics).toContain("update kinds=[message,edit]");
    expect(diagnostics).not.toMatch(/-100123|77|78|wrong chat/u);

    await adapter.resetTransport?.();
    expect(adapter.describeTransportState?.()).toContain("updates=0");
    await adapter.cleanup?.();
    await adapter.cleanupAfterGatewayStop?.();
  });

  it("releases the lease when userbot startup fails", async () => {
    const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "telegram-adapter-failure-test-"));
    mocks.createStateRoot.mockReturnValueOnce(stateRoot);
    mocks.userbotStart.mockRejectedValueOnce(new Error("authorization failed"));

    await expect(
      createTelegramQaTransportAdapter({ adapterOptions: {}, messages: {} } as never),
    ).rejects.toThrow("authorization failed");

    expect(mocks.proxyClose).toHaveBeenCalledOnce();
    expect(mocks.heartbeatStop).toHaveBeenCalledOnce();
    expect(mocks.leaseRelease).toHaveBeenCalledOnce();
    expect(fs.existsSync(stateRoot)).toBe(false);
  });

  it("releases the lease when scratch creation fails", async () => {
    mocks.createStateRoot.mockImplementationOnce(() => {
      throw new Error("scratch failed");
    });

    await expect(
      createTelegramQaTransportAdapter({ adapterOptions: {}, messages: {} } as never),
    ).rejects.toThrow("scratch failed");

    expect(mocks.heartbeatStop).toHaveBeenCalledOnce();
    expect(mocks.leaseRelease).toHaveBeenCalledOnce();
  });

  it("releases the lease when proxy cleanup fails", async () => {
    mocks.proxyClose.mockRejectedValueOnce(new Error("proxy close failed"));
    const adapter = await createTelegramQaTransportAdapter({
      adapterOptions: {},
      messages: {},
    } as never);

    await adapter.cleanup?.();
    await expect(adapter.cleanupAfterGatewayStop?.()).rejects.toThrow("proxy close failed");

    expect(mocks.heartbeatStop).toHaveBeenCalledOnce();
    expect(mocks.leaseRelease).toHaveBeenCalledOnce();
  });

  it("retains a quarantined lease after stopping the userbot and proxy", async () => {
    mocks.shouldRetainQaGatewayCredentialLease.mockResolvedValueOnce(true);
    const adapter = await createTelegramQaTransportAdapter({
      adapterOptions: {},
      messages: {},
    } as never);

    await adapter.cleanup?.();
    await expect(adapter.cleanupAfterGatewayStop?.()).rejects.toThrow(
      "retained Telegram credential",
    );

    expect(mocks.userbotClose).toHaveBeenCalledOnce();
    expect(mocks.proxyClose).toHaveBeenCalledOnce();
    expect(mocks.leaseHeartbeat).toHaveBeenCalledOnce();
    expect(mocks.heartbeatStop).toHaveBeenCalledOnce();
    expect(mocks.leaseRelease).not.toHaveBeenCalled();
  });
});
