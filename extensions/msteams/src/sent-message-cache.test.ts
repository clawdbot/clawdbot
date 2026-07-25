// Msteams tests cover sent message cache plugin behavior.
import { resolveGlobalDedupeCache } from "openclaw/plugin-sdk/dedupe-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TTL_MS = 24 * 60 * 60 * 1000;
const sentMessageMemory = resolveGlobalDedupeCache(Symbol.for("openclaw.msteamsSentMessages"), {
  ttlMs: TTL_MS,
  maxSize: 20_000,
});

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
});
