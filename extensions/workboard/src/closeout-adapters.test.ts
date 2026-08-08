import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import { describe, expect, it, vi } from "vitest";
import { registerCloseoutGatewayMethod } from "./closeout-gateway.js";
import { createCloseoutTrackerStore } from "./closeout-store.js";
import {
  createCloseoutTrackerToolFactory,
  createRuntimeConversationSend,
} from "./closeout-tool.js";
import type {
  CloseoutRecord,
  CloseoutTracker,
  ConversationSendResult,
} from "./closeout-tracker.js";

const record: CloseoutRecord = {
  closeoutId: "NAC-78",
  operationId: "closeout:NAC-78",
  agentId: "main",
  sourceSessionKey: "agent:main:telegram:direct:operator",
  conversationRef: "conv_0123456789abcdef0123456789abcdef",
  message: "NAC-78 is complete.",
  status: "recorded",
  attemptCount: 0,
  createdAt: 1_000,
  updatedAt: 1_000,
};

describe("closeout tracker plugin adapters", () => {
  it("uses the existing plugin keyed store without creating a tracker database", async () => {
    const entries = new Map<string, CloseoutRecord>();
    const keyedStore = {
      register: vi.fn(async (key: string, value: CloseoutRecord) => {
        entries.set(key, value);
      }),
      registerIfAbsent: vi.fn(async (key: string, value: CloseoutRecord) => {
        if (entries.has(key)) {
          return false;
        }
        entries.set(key, value);
        return true;
      }),
      lookup: vi.fn(async (key: string) => entries.get(key)),
      entries: vi.fn(async () =>
        [...entries].map(([key, value]) => ({ key, value, createdAt: value.createdAt })),
      ),
    };
    const openKeyedStore = vi.fn(() => keyedStore);
    const store = createCloseoutTrackerStore({
      state: { openKeyedStore },
    } as unknown as PluginRuntime);

    expect(openKeyedStore).toHaveBeenCalledWith({
      namespace: "closeouts-v1",
      maxEntries: 1_000,
      overflowPolicy: "reject-new",
    });
    await expect(store.create(record)).resolves.toBe(true);
    await expect(store.get("main", "NAC-78")).resolves.toEqual(record);
    await store.put({ ...record, status: "completed" });
    expect(keyedStore.register).toHaveBeenCalledWith(
      expect.stringContaining("main"),
      expect.objectContaining({ status: "completed" }),
      { ttlMs: 7_776_000_000 },
    );
  });

  it("sends through the existing durable conversations.send gateway operation", async () => {
    const result: ConversationSendResult = {
      status: "sent",
      conversationRef: record.conversationRef,
      channel: "telegram",
      messageId: "telegram-123",
    };
    const request = vi.fn(async () => result);
    const send = createRuntimeConversationSend({
      gateway: { request },
    } as unknown as PluginRuntime);

    await expect(
      send({
        agentId: record.agentId,
        sourceSessionKey: record.sourceSessionKey,
        operationId: record.operationId,
        conversationRef: record.conversationRef,
        message: record.message,
      }),
    ).resolves.toEqual(result);
    expect(request).toHaveBeenCalledWith(
      "conversations.send",
      {
        agentId: record.agentId,
        sourceSessionKey: record.sourceSessionKey,
        operationId: record.operationId,
        conversationRef: record.conversationRef,
        message: record.message,
      },
      { scopes: ["operator.admin"] },
    );
  });

  it("binds tool send and completion actions to the current agent/session", async () => {
    const tracker: CloseoutTracker = {
      send: vi.fn(async () => ({ ...record, status: "confirmed" as const })),
      reconcile: vi.fn(async () => record),
      confirm: vi.fn(async () => ({ ...record, status: "manually_confirmed" as const })),
      complete: vi.fn(async () => ({ ...record, status: "completed" as const })),
      get: vi.fn(async () => record),
      list: vi.fn(async () => [record]),
    };
    const tool = createCloseoutTrackerToolFactory({ tracker })({
      agentId: "main",
      sessionKey: record.sourceSessionKey,
      senderIsOwner: true,
      sandboxed: false,
    });
    if (!tool || Array.isArray(tool)) {
      throw new Error("expected one owner closeout tool");
    }

    const sendResult = await tool.execute("tool-call-1", {
      action: "send",
      closeoutId: "NAC-78",
      conversationRef: record.conversationRef,
      message: record.message,
    });
    await tool.execute("tool-call-2", { action: "complete", closeoutId: "NAC-78" });
    const listResult = await tool.execute("tool-call-3", { action: "list", limit: 1_000 });
    await expect(
      tool.execute("tool-call-4", {
        action: "confirm",
        closeoutId: "NAC-78",
        evidence: "model supplied evidence",
      }),
    ).rejects.toThrow("unknown closeout tracker action: confirm");

    expect(JSON.stringify(sendResult)).not.toContain(record.message);
    expect(JSON.stringify(sendResult)).not.toContain(record.sourceSessionKey);
    expect(JSON.stringify(listResult)).not.toContain(record.message);

    expect(tracker.send).toHaveBeenCalledWith({
      closeoutId: "NAC-78",
      agentId: "main",
      sourceSessionKey: record.sourceSessionKey,
      conversationRef: record.conversationRef,
      message: record.message,
    });
    expect(tracker.complete).toHaveBeenCalledWith("main", "NAC-78");
    expect(tracker.list).toHaveBeenCalledWith("main", 100);
  });

  it("exposes the closeout tool only to an owner outside the sandbox", () => {
    const tracker = {} as CloseoutTracker;
    const factory = createCloseoutTrackerToolFactory({ tracker });
    const context = {
      agentId: "main",
      sessionKey: record.sourceSessionKey,
      senderIsOwner: true,
      sandboxed: false,
    };

    const ownerTool = factory(context);
    if (!ownerTool || Array.isArray(ownerTool)) {
      throw new Error("expected one owner closeout tool");
    }
    expect(ownerTool.name).toBe("workboard_closeout");
    expect(factory({ ...context, senderIsOwner: false })).toBeNull();
    expect(factory({ ...context, sandboxed: true })).toBeNull();
    expect(factory({ ...context, agentId: undefined })).toBeNull();
  });

  it("registers manual confirmation only as an operator-admin gateway method", async () => {
    const tracker: CloseoutTracker = {
      send: vi.fn(async () => record),
      reconcile: vi.fn(async () => record),
      confirm: vi.fn(async () => ({
        ...record,
        status: "manually_confirmed" as const,
        manualEvidence: "verified Telegram message 789",
      })),
      complete: vi.fn(async () => record),
      get: vi.fn(async () => record),
      list: vi.fn(async () => [record]),
    };
    const registerGatewayMethod = vi.fn();
    registerCloseoutGatewayMethod({
      api: { registerGatewayMethod } as never,
      tracker,
    });

    expect(registerGatewayMethod).toHaveBeenCalledWith(
      "workboard.closeouts.confirm",
      expect.any(Function),
      { scope: "operator.admin" },
    );
    const handler = registerGatewayMethod.mock.calls[0]?.[1];
    if (typeof handler !== "function") {
      throw new Error("expected closeout confirmation gateway handler");
    }
    const respond = vi.fn();
    await handler({
      params: {
        agentId: "main",
        closeoutId: "NAC-78",
        evidence: "verified Telegram message 789",
      },
      client: { authenticatedUserId: "kevin" },
      respond,
    });

    expect(tracker.confirm).toHaveBeenCalledWith(
      "main",
      "NAC-78",
      "verified Telegram message 789",
      "user:kevin",
    );
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        closeout: expect.objectContaining({ status: "manually_confirmed" }),
      }),
    );
    expect(JSON.stringify(respond.mock.calls)).not.toContain("verified Telegram message 789");
  });
});
