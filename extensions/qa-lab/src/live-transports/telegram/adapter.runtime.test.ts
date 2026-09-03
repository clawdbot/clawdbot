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

async function prepareMessageReader(
  adapter: Awaited<ReturnType<typeof createTelegramQaTransportAdapter>>,
) {
  const stateRoot = mocks.createStateRoot.mock.results.at(-1)?.value;
  const prepared = await adapter.prepareFlow?.({
    config: {},
    scenarioId: "telegram-entities",
    scenarioTitle: "Telegram native entities",
    gateway: {
      baseUrl: "http://127.0.0.1:1234",
      tempRoot: stateRoot,
      workspaceDir: stateRoot,
      runtimeEnv: {},
      call: vi.fn(),
    },
    waitForConfigRestartSettle: vi.fn(),
    outputDir: stateRoot,
    timeoutMs: 30_000,
  });
  const read = prepared?.readTelegramMessages;
  if (typeof read !== "function") {
    throw new Error("Telegram flow did not expose native message observations");
  }
  return read;
}

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
      chatId: -100123,
      close: mocks.userbotClose,
      send: mocks.userbotSend,
    });
    mocks.proxyDrainUpdates.mockResolvedValue(undefined);
    mocks.shouldRetainQaGatewayCredentialLease.mockResolvedValue(false);
  });

  it("targets the SUT DM for direct-message-only scenarios", async () => {
    mocks.userbotStart.mockResolvedValueOnce({
      assertHealthy: mocks.userbotAssertHealthy,
      chatId: 200,
      close: mocks.userbotClose,
      send: mocks.userbotSend,
    });
    const adapter = await createTelegramQaTransportAdapter({
      adapterOptions: { transportPolicy: { directMessageOnly: true } },
      messages: {},
    } as never);

    expect(mocks.userbotStart).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: "@sut_bot" }),
    );
    expect(adapter.createGatewayConfig?.({ baseUrl: "http://127.0.0.1:1234" })).toMatchObject({
      channels: {
        telegram: {
          accounts: {
            sut: { allowFrom: ["100"], dmPolicy: "allowlist" },
          },
        },
      },
    });
    expect(adapter.buildAgentDelivery({ target: "dm:qa-operator" })).toEqual({
      channel: "telegram",
      to: "100",
      replyChannel: "telegram",
      replyTo: "100",
    });

    await adapter.cleanup?.();
    await adapter.cleanupAfterGatewayStop?.();
  });

  it("leases a Test Server userbot and isolates its shared group by default", async () => {
    const adapter = await createTelegramQaTransportAdapter({
      adapterOptions: {
        credentialSource: "convex",
        credentialRole: "ci",
        repoRoot: "/checkout",
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
    expect(adapter.buildAgentDelivery({ target: "group:qa-channel" })).toEqual({
      channel: "telegram",
      to: "-100123",
      replyChannel: "telegram",
      replyTo: "-100123",
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

  it("maps sends, replies, messages, and formatting edits through one userbot process", async () => {
    let onUpdate: ((update: unknown) => Promise<void>) | undefined;
    mocks.userbotStart.mockImplementation(async (params) => {
      onUpdate = params.onUpdate;
      return {
        assertHealthy: mocks.userbotAssertHealthy,
        chatId: -100123,
        close: mocks.userbotClose,
        send: mocks.userbotSend,
      };
    });
    const preview = {
      kind: "message",
      chatId: -100123,
      messageId: 11,
      botApiMessageId: 11,
      senderId: 200,
      senderUsername: "sut_bot",
      replyToMessageId: 10,
      timestamp: 100_000,
      text: "😀 a   b",
      entities: [{ offset: 3, length: 5, type: { "@type": "textEntityTypeCode" } }],
    };
    mocks.userbotSend
      .mockImplementationOnce(async () => {
        await onUpdate?.(preview);
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
    try {
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
          text: preview.text,
          replyToId: "in-1",
        }),
      );
      const readMessages = await prepareMessageReader(adapter);
      const firstSnapshot = readMessages();
      expect(firstSnapshot).toEqual([preview]);
      firstSnapshot[0].entities[0].type["@type"] = "textEntityTypeBold";
      expect(readMessages()).toEqual([preview]);

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
      const edited = {
        ...preview,
        kind: "edit",
        timestamp: 101_000,
        entities: [{ offset: 3, length: 5, type: { "@type": "textEntityTypeBold" } }],
      };
      await onUpdate?.(edited);
      expect(editMessage).toHaveBeenCalledWith(
        expect.objectContaining({ messageId: "out-1", text: preview.text, timestamp: 101_000 }),
      );
      expect(readMessages()).toEqual([edited]);
      await onUpdate?.({ ...edited, text: "final", entities: [] });
      expect(readMessages()).toEqual([{ ...edited, text: "final", entities: [] }]);

      mocks.heartbeatThrowIfFailed.mockImplementationOnce(() => {
        throw new Error("lease revoked");
      });
      expect(() => readMessages()).toThrow("lease revoked");
      mocks.userbotAssertHealthy.mockImplementationOnce(() => {
        throw new Error("Telegram userbot is closed.");
      });
      expect(() => readMessages()).toThrow("Telegram userbot is closed.");
    } finally {
      await adapter.cleanup?.();
      await adapter.cleanupAfterGatewayStop?.();
    }
  });

  it("filters other updates and resets diagnostics and native observations", async () => {
    let onUpdate: ((update: unknown) => Promise<void>) | undefined;
    mocks.userbotStart.mockImplementation(async (params) => {
      onUpdate = params.onUpdate;
      return {
        assertHealthy: mocks.userbotAssertHealthy,
        chatId: -100123,
        close: mocks.userbotClose,
        send: mocks.userbotSend,
      };
    });
    const addOutboundMessage = vi.fn().mockResolvedValue({ id: "out-1" });
    const adapter = await createTelegramQaTransportAdapter({
      adapterOptions: {},
      messages: { addOutboundMessage },
    } as never);
    try {
      const matched = {
        kind: "edit",
        chatId: -100123,
        messageId: 78,
        senderId: 200,
        timestamp: 101_000,
        text: "matched",
        entities: [{ offset: 0, length: 7, type: { "@type": "textEntityTypeBold" } }],
      };
      await onUpdate?.({ ...matched, kind: "message", chatId: -100999, messageId: 77 });
      await onUpdate?.({ ...matched, kind: "message", senderId: 201, messageId: 79 });
      await onUpdate?.(matched);

      const diagnostics = adapter.describeTransportState?.() ?? "";
      expect(diagnostics).toContain("updates=3");
      expect(diagnostics).toContain("filtered=2");
      expect(diagnostics).toContain("matched=1");
      expect(diagnostics).toContain("update kinds=[message,edit]");
      expect(diagnostics).not.toMatch(/-100123|77|78|79/u);
      const readMessages = await prepareMessageReader(adapter);
      expect(readMessages()).toEqual([matched]);

      await adapter.resetTransport?.();
      expect(adapter.describeTransportState?.()).toContain("updates=0");
      expect(readMessages()).toEqual([]);
    } finally {
      await adapter.cleanup?.();
      await adapter.cleanupAfterGatewayStop?.();
    }
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
