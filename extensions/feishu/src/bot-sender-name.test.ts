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

  it("evicts the oldest sender while retaining recent sender names", async () => {
    const get = vi.fn(async (params: { path: { user_id: string } }) => ({
      data: { user: { name: `name-${params.path.user_id}` } },
    }));
    createFeishuClientMock.mockReturnValue({ contact: { user: { get } } });

    for (let index = 0; index < 501; index += 1) {
      await resolveFeishuSenderName({
        account,
        senderId: `ou_sender_cap_${index}`,
        log: vi.fn(),
      });
    }
    await resolveFeishuSenderName({
      account,
      senderId: "ou_sender_cap_0",
      log: vi.fn(),
    });
    await resolveFeishuSenderName({
      account,
      senderId: "ou_sender_cap_500",
      log: vi.fn(),
    });

    expect(get).toHaveBeenCalledTimes(502);
    expect(
      get.mock.calls.filter(([params]) => params.path.user_id === "ou_sender_cap_0"),
    ).toHaveLength(2);
    expect(
      get.mock.calls.filter(([params]) => params.path.user_id === "ou_sender_cap_500"),
    ).toHaveLength(1);
  });
});
