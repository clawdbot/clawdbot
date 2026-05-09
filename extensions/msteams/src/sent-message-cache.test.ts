import { afterEach, describe, expect, it, vi } from "vitest";
import { setMSTeamsRuntime } from "./runtime.js";
import {
  clearMSTeamsSentMessageCache,
  recordMSTeamsSentMessage,
  wasMSTeamsMessageSent,
  wasMSTeamsMessageSentWithPersistence,
} from "./sent-message-cache.js";

const TTL_MS = 24 * 60 * 60 * 1000;

describe("msteams sent message cache", () => {
  afterEach(() => {
    clearMSTeamsSentMessageCache();
    vi.restoreAllMocks();
  });

  it("records and resolves sent message ids", () => {
    recordMSTeamsSentMessage("conv-1", "msg-1");
    expect(wasMSTeamsMessageSent("conv-1", "msg-1")).toBe(true);
    expect(wasMSTeamsMessageSent("conv-1", "msg-2")).toBe(false);
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

    clearMSTeamsSentMessageCache();
    await expect(
      wasMSTeamsMessageSentWithPersistence({ conversationId: "conv-1", messageId: "msg-2" }),
    ).resolves.toBe(true);
    expect(openKeyedStore).toHaveBeenCalledTimes(2);
    expect(lookup).toHaveBeenCalledWith("conv-1:msg-2");

    lookup.mockClear();
    await expect(
      wasMSTeamsMessageSentWithPersistence({ conversationId: "conv-1", messageId: "msg-2" }),
    ).resolves.toBe(true);
    expect(wasMSTeamsMessageSent("conv-1", "msg-2")).toBe(true);
    expect(lookup).not.toHaveBeenCalled();
  });

  it("preserves the original TTL when recovering sent-message ids from persistent state", async () => {
    const sentAt = 1_000_000;
    const lookup = vi.fn().mockResolvedValue({ sentAt });
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
    expect(wasMSTeamsMessageSent("conv-1", "msg-4")).toBe(true);

    lookup.mockClear();
    vi.mocked(Date.now).mockReturnValue(sentAt + TTL_MS + 1);

    expect(wasMSTeamsMessageSent("conv-1", "msg-4")).toBe(false);
    expect(lookup).not.toHaveBeenCalled();
  });

  it("falls back to in-memory sent-message markers when persistent state cannot open", () => {
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

    expect(wasMSTeamsMessageSent("conv-1", "msg-3")).toBe(true);
    expect(warn).toHaveBeenCalled();
  });
});
