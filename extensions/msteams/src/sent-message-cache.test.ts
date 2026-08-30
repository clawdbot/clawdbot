// Msteams tests cover sent message cache plugin behavior.
import { createHash } from "node:crypto";
import { resolveGlobalDedupeCache } from "openclaw/plugin-sdk/dedupe-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TTL_MS = 24 * 60 * 60 * 1000;
const sentMessageMemory = resolveGlobalDedupeCache(Symbol.for("openclaw.msteamsSentMessages"), {
  ttlMs: TTL_MS,
  maxSize: 20_000,
});

function resolveNamedAccountMemory(accountId: string) {
  const digest = createHash("sha256").update(accountId).digest("hex");
  return resolveGlobalDedupeCache(Symbol.for(`openclaw.msteamsSentMessages.account.v1.${digest}`), {
    ttlMs: TTL_MS,
    maxSize: 20_000,
  });
}

let setMSTeamsRuntime: typeof import("./runtime.js").setMSTeamsRuntime;
let recordMSTeamsSentMessage: typeof import("./sent-message-cache.js").recordMSTeamsSentMessage;
let wasMSTeamsMessageSentWithPersistence: typeof import("./sent-message-cache.js").wasMSTeamsMessageSentWithPersistence;

describe("msteams sent message cache", () => {
  beforeEach(async () => {
    sentMessageMemory.clear();
    vi.resetModules();
    ({ setMSTeamsRuntime } = await import("./runtime.js"));
    ({ recordMSTeamsSentMessage, wasMSTeamsMessageSentWithPersistence } =
      await import("./sent-message-cache.js"));
  });

  afterEach(() => {
    sentMessageMemory.clear();
    vi.restoreAllMocks();
  });

  it("records and resolves sent message ids", async () => {
    recordMSTeamsSentMessage("conv-1", "msg-1");
    await expect(
      wasMSTeamsMessageSentWithPersistence({ conversationId: "conv-1", messageId: "msg-1" }),
    ).resolves.toBe(true);
    await expect(
      wasMSTeamsMessageSentWithPersistence({ conversationId: "conv-1", messageId: "msg-2" }),
    ).resolves.toBe(false);
  });

  it("persists sent message ids when runtime state is available", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_234_567);
    const register = vi.fn().mockResolvedValue(undefined);
    const lookup = vi.fn().mockResolvedValue({ sentAt: Date.now() });
    const openKeyedStore = vi.fn(() => ({
      register,
      lookup,
      consume: vi.fn(),
      delete: vi.fn(),
      entries: vi.fn(),
      clear: vi.fn(),
    }));
    setMSTeamsRuntime({
      state: { openKeyedStore },
      logging: { getChildLogger: () => ({ warn: vi.fn() }) },
    } as never);

    recordMSTeamsSentMessage("conv-1", "msg-2");

    await vi.waitFor(() => expect(register).toHaveBeenCalledTimes(1));
    expect(register).toHaveBeenCalledWith("conv-1:msg-2", { sentAt: 1_234_567 });

    sentMessageMemory.clear();
    await expect(
      wasMSTeamsMessageSentWithPersistence({ conversationId: "conv-1", messageId: "msg-2" }),
    ).resolves.toBe(true);
    expect(openKeyedStore).toHaveBeenCalledTimes(1);
    expect(lookup).toHaveBeenCalledWith("conv-1:msg-2");

    lookup.mockClear();
    await expect(
      wasMSTeamsMessageSentWithPersistence({ conversationId: "conv-1", messageId: "msg-2" }),
    ).resolves.toBe(true);
    await expect(
      wasMSTeamsMessageSentWithPersistence({ conversationId: "conv-1", messageId: "msg-2" }),
    ).resolves.toBe(true);
    expect(lookup).not.toHaveBeenCalled();
  });

  it("preserves the original TTL when recovering sent-message ids from persistent state", async () => {
    const sentAt = 1_000_000;
    const lookup = vi.fn(async () => (Date.now() - sentAt < TTL_MS ? { sentAt } : undefined));
    const openKeyedStore = vi.fn(() => ({
      register: vi.fn(),
      lookup,
      consume: vi.fn(),
      delete: vi.fn(),
      entries: vi.fn(),
      clear: vi.fn(),
    }));
    setMSTeamsRuntime({
      state: { openKeyedStore },
      logging: { getChildLogger: () => ({ warn: vi.fn() }) },
    } as never);

    vi.spyOn(Date, "now").mockReturnValue(sentAt + TTL_MS - 1);
    await expect(
      wasMSTeamsMessageSentWithPersistence({ conversationId: "conv-1", messageId: "msg-4" }),
    ).resolves.toBe(true);
    await expect(
      wasMSTeamsMessageSentWithPersistence({ conversationId: "conv-1", messageId: "msg-4" }),
    ).resolves.toBe(true);

    lookup.mockClear();
    vi.mocked(Date.now).mockReturnValue(sentAt + TTL_MS + 1);

    await expect(
      wasMSTeamsMessageSentWithPersistence({ conversationId: "conv-1", messageId: "msg-4" }),
    ).resolves.toBe(false);
    expect(lookup).toHaveBeenCalledWith("conv-1:msg-4");
  });

  it("falls back to in-memory sent-message markers when persistent state cannot open", async () => {
    const warn = vi.fn();
    setMSTeamsRuntime({
      state: {
        openKeyedStore: vi.fn(() => {
          throw new Error("sqlite unavailable");
        }),
      },
      logging: { getChildLogger: () => ({ warn }) },
    } as never);

    recordMSTeamsSentMessage("conv-1", "msg-3");

    await expect(
      wasMSTeamsMessageSentWithPersistence({ conversationId: "conv-1", messageId: "msg-3" }),
    ).resolves.toBe(true);
    expect(warn).toHaveBeenCalled();
  });

  it("scopes sent-message markers by account", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_234_567);
    const register = vi.fn().mockResolvedValue(undefined);
    const lookup = vi.fn().mockResolvedValue(undefined);
    const openedNamespaces: string[] = [];
    const openKeyedStore = vi.fn((options: { namespace: string }) => {
      openedNamespaces.push(options.namespace);
      return {
        register,
        lookup,
        consume: vi.fn(),
        delete: vi.fn(),
        entries: vi.fn(),
        clear: vi.fn(),
      };
    });
    setMSTeamsRuntime({
      state: { openKeyedStore },
      logging: { getChildLogger: () => ({ warn: vi.fn() }) },
    } as never);

    recordMSTeamsSentMessage("conv-1", "msg-1", { accountId: "support" });

    await expect(
      wasMSTeamsMessageSentWithPersistence({
        conversationId: "conv-1",
        messageId: "msg-1",
        accountId: "support",
      }),
    ).resolves.toBe(true);
    await expect(
      wasMSTeamsMessageSentWithPersistence({
        conversationId: "conv-1",
        messageId: "msg-1",
        accountId: "finance",
      }),
    ).resolves.toBe(false);
    await vi.waitFor(() => expect(register).toHaveBeenCalledTimes(1));
    const supportKey = register.mock.calls[0]?.[0];
    expect(supportKey).toBe("conv-1:msg-1");
    await expect(
      wasMSTeamsMessageSentWithPersistence({
        conversationId: "conv-1",
        messageId: "msg-1",
        accountId: "finance",
      }),
    ).resolves.toBe(false);
    const financeKey = lookup.mock.calls[0]?.[0];
    expect(financeKey).toBe("conv-1:msg-1");
    expect(openedNamespaces).toHaveLength(2);
    expect(openedNamespaces[0]).toMatch(/^msteams\.sent-messages\.account\.v1\.[a-f0-9]{64}$/);
    expect(openedNamespaces[1]).toMatch(/^msteams\.sent-messages\.account\.v1\.[a-f0-9]{64}$/);
    expect(openedNamespaces[1]).not.toBe(openedNamespaces[0]);
  });

  it("prevents named-account keys from colliding with legacy default keys", async () => {
    const register = vi.fn().mockResolvedValue(undefined);
    const openedNamespaces: string[] = [];
    const openKeyedStore = vi.fn((options: { namespace: string }) => {
      openedNamespaces.push(options.namespace);
      return {
        register,
        lookup: vi.fn().mockResolvedValue(undefined),
        consume: vi.fn(),
        delete: vi.fn(),
        entries: vi.fn(),
        clear: vi.fn(),
      };
    });
    setMSTeamsRuntime({
      state: { openKeyedStore },
      logging: { getChildLogger: () => ({ warn: vi.fn() }) },
    } as never);

    recordMSTeamsSentMessage("19:conversation", "message");
    await expect(
      wasMSTeamsMessageSentWithPersistence({
        conversationId: "conversation",
        messageId: "message",
        accountId: "19",
      }),
    ).resolves.toBe(false);
    recordMSTeamsSentMessage("conversation", "message", { accountId: "19" });

    await vi.waitFor(() => expect(register).toHaveBeenCalledTimes(2));
    const defaultKey = register.mock.calls[0]?.[0];
    const namedKey = register.mock.calls[1]?.[0];
    expect(defaultKey).toBe("19:conversation:message");
    expect(namedKey).toBe("conversation:message");
    expect(namedKey).not.toBe(defaultKey);
    expect(openedNamespaces[0]).toBe("msteams.sent-messages");
    expect(openedNamespaces[1]).toMatch(/^msteams\.sent-messages\.account\.v1\.[a-f0-9]{64}$/);
  });

  it("isolates named-account persistent retention across overflow and memory loss", async () => {
    const stores = new Map<string, Map<string, MSTeamsSentMessageRecordForTest>>();
    const openKeyedStore = vi.fn((options: { namespace: string; maxEntries?: number }) => {
      let values = stores.get(options.namespace);
      if (!values) {
        values = new Map();
        stores.set(options.namespace, values);
      }
      return {
        register: vi.fn(async (key: string, value: MSTeamsSentMessageRecordForTest) => {
          values?.delete(key);
          values?.set(key, value);
          if (values && values.size > (options.maxEntries ?? Number.POSITIVE_INFINITY)) {
            const oldestKey = values.keys().next().value;
            if (oldestKey !== undefined) {
              values.delete(oldestKey);
            }
          }
        }),
        lookup: vi.fn(async (key: string) => values?.get(key)),
        consume: vi.fn(),
        delete: vi.fn(),
        entries: vi.fn(),
        clear: vi.fn(),
      };
    });
    setMSTeamsRuntime({
      state: { openKeyedStore },
      logging: { getChildLogger: () => ({ warn: vi.fn() }) },
    } as never);

    recordMSTeamsSentMessage("finance-conv", "finance-msg", { accountId: "finance" });
    for (let index = 0; index <= 1000; index += 1) {
      recordMSTeamsSentMessage("support-conv", `support-${index}`, { accountId: "support" });
    }
    await vi.waitFor(() => {
      const registrations = [...stores.values()].reduce((sum, store) => sum + store.size, 0);
      expect(registrations).toBe(1001);
    });

    resolveNamedAccountMemory("finance").clear();
    await expect(
      wasMSTeamsMessageSentWithPersistence({
        conversationId: "finance-conv",
        messageId: "finance-msg",
        accountId: "finance",
      }),
    ).resolves.toBe(true);
    expect(stores.size).toBe(2);
    expect([...stores.values()].map((store) => store.size).toSorted((a, b) => a - b)).toEqual([
      1, 1000,
    ]);
  });
});

type MSTeamsSentMessageRecordForTest = { sentAt: number };
