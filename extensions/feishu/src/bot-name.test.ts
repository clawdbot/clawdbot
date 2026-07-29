// Feishu tests cover bot sender name resolution.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedFeishuAccount } from "./types.js";

const requestMock = vi.hoisted(() => vi.fn());

vi.mock("./client.js", () => ({
  createFeishuClient: vi.fn(() => ({ request: requestMock })),
}));

type ResolveFeishuBotName = typeof import("./bot-name.js").resolveFeishuBotName;

let resolveFeishuBotName: ResolveFeishuBotName;

const account = {
  accountId: "main",
  configured: true,
  config: {},
} as ResolvedFeishuAccount;
const log = vi.fn();

describe("resolveFeishuBotName", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    ({ resolveFeishuBotName } = await import("./bot-name.js"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves and caches the bot display name", async () => {
    requestMock.mockResolvedValue({
      code: 0,
      data: { bots: { ou_peer: { name: "Peer Bot" } } },
    });

    await expect(resolveFeishuBotName({ account, openId: "ou_peer", log })).resolves.toBe(
      "Peer Bot",
    );
    await expect(resolveFeishuBotName({ account, openId: "ou_peer", log })).resolves.toBe(
      "Peer Bot",
    );

    expect(requestMock).toHaveBeenCalledTimes(1);
  });

  it("does not open the breaker for repeated missing-scope responses", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const scopeError = Object.assign(new Error("scope missing"), {
      response: { data: { code: 99991672 } },
    });
    requestMock.mockRejectedValue(scopeError);

    for (let index = 0; index < 10; index += 1) {
      await resolveFeishuBotName({ account, openId: `ou_missing_${index}`, log });
    }
    vi.advanceTimersByTime(60_001);
    requestMock.mockResolvedValueOnce({
      code: 0,
      data: { bots: { ou_available: { name: "Available" } } },
    });

    await expect(resolveFeishuBotName({ account, openId: "ou_available", log })).resolves.toBe(
      "Available",
    );
    expect(requestMock).toHaveBeenCalledTimes(2);
  });

  it("does not open the breaker for resolved missing-scope envelopes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    requestMock.mockResolvedValue({ code: 99991672, msg: "permission denied" });

    for (let index = 0; index < 10; index += 1) {
      await resolveFeishuBotName({ account, openId: `ou_missing_${index}`, log });
    }
    vi.advanceTimersByTime(60_001);
    requestMock.mockResolvedValueOnce({
      code: 0,
      data: { bots: { ou_available: { name: "Available" } } },
    });

    await expect(resolveFeishuBotName({ account, openId: "ou_available", log })).resolves.toBe(
      "Available",
    );
    expect(requestMock).toHaveBeenCalledTimes(2);
  });

  it("deduplicates concurrent lookups for one account and bot", async () => {
    let release: ((value: unknown) => void) | undefined;
    requestMock.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );

    const first = resolveFeishuBotName({ account, openId: "ou_peer", log });
    const second = resolveFeishuBotName({ account, openId: "ou_peer", log });
    release?.({ code: 0, data: { bots: { ou_peer: { name: "Peer Bot" } } } });

    await expect(Promise.all([first, second])).resolves.toEqual(["Peer Bot", "Peer Bot"]);
    expect(requestMock).toHaveBeenCalledTimes(1);
  });
});
