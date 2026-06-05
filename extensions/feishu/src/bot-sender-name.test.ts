// Feishu tests cover bot sender name plugin behavior.
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveFeishuSenderName } from "./bot-sender-name.js";
import { FeishuConfigSchema } from "./config-schema.js";
import type { ResolvedFeishuAccount } from "./types.js";

const createFeishuClientMock = vi.hoisted(() => vi.fn());

vi.mock("./client.js", () => ({
  createFeishuClient: createFeishuClientMock,
}));

const account = {
  accountId: "main",
  selectionSource: "explicit",
  enabled: true,
  configured: true,
  appId: "app-id",
  appSecret: "secret",
  domain: "feishu",
  config: FeishuConfigSchema.parse({}),
} satisfies ResolvedFeishuAccount;

function mockUserNames(...names: string[]): ReturnType<typeof vi.fn> {
  const get = vi.fn();
  for (const name of names) {
    get.mockResolvedValueOnce({ data: { user: { name } } });
  }
  createFeishuClientMock.mockReturnValue({
    contact: { user: { get } },
  });
  return get;
}

describe("resolveFeishuSenderName", () => {
  afterEach(() => {
    vi.useRealTimers();
    createFeishuClientMock.mockReset();
  });

  it("reuses a cached sender name within the TTL", async () => {
    const get = mockUserNames("Ada");

    await expect(
      resolveFeishuSenderName({ account, senderId: "ou_sender_cache", log: vi.fn() }),
    ).resolves.toEqual({ name: "Ada" });
    await expect(
      resolveFeishuSenderName({ account, senderId: "ou_sender_cache", log: vi.fn() }),
    ).resolves.toEqual({ name: "Ada" });

    expect(get).toHaveBeenCalledTimes(1);
  });

  it("does not cache sender names when the expiry would exceed Date range", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(8_640_000_000_000_000));
    const get = mockUserNames("Ada", "Grace");

    await expect(
      resolveFeishuSenderName({ account, senderId: "ou_sender_overflow", log: vi.fn() }),
    ).resolves.toEqual({ name: "Ada" });
    await expect(
      resolveFeishuSenderName({ account, senderId: "ou_sender_overflow", log: vi.fn() }),
    ).resolves.toEqual({ name: "Grace" });

    expect(get).toHaveBeenCalledTimes(2);
  });
});
