import { afterAll, describe, it, expect, vi, beforeEach } from "vitest";
import { resolveGroupName, clearGroupNameCache } from "./bot.js";
import type { ResolvedFeishuAccount } from "./types.js";

const mockGetChatInfo = vi.hoisted(() => vi.fn());
const mockCreateFeishuClient = vi.hoisted(() => vi.fn());

vi.mock("./chat.js", () => ({ getChatInfo: mockGetChatInfo }));
vi.mock("./client.js", () => ({ createFeishuClient: mockCreateFeishuClient }));

function makeAccount(id = "test-account"): ResolvedFeishuAccount {
  return {
    accountId: id,
    selectionSource: "explicit",
    enabled: true,
    configured: true,
    appId: "cli_test",
    appSecret: "secret",
    domain: "feishu",
    config: {
      domain: "feishu",
      connectionMode: "websocket",
      webhookPath: "/feishu/events",
      dmPolicy: "pairing",
      reactionNotifications: "own",
      groupPolicy: "allowlist",
      typingIndicator: true,
      resolveSenderNames: true,
    },
  };
}

/**
 * Unit tests for resolveGroupName.
 *
 * Covers: successful lookup, API failure, empty name, positive cache,
 *         negative cache, undefined response, and cross-account isolation.
 */
describe("resolveGroupName", () => {
  const account = makeAccount();
  const log = vi.fn();

  afterAll(() => {
    vi.doUnmock("./chat.js");
    vi.doUnmock("./client.js");
    vi.resetModules();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetChatInfo.mockReset();
    mockCreateFeishuClient.mockReset();
    mockCreateFeishuClient.mockReturnValue({});
    clearGroupNameCache();
  });

  it("returns the trimmed group name on successful API call", async () => {
    mockGetChatInfo.mockResolvedValue({ name: "  Engineering Team  " });
    const result = await resolveGroupName({ account, chatId: "oc_test1", log });
    expect(result).toBe("Engineering Team");
    expect(mockGetChatInfo).toHaveBeenCalledOnce();
  });

  it("returns undefined and logs on API failure", async () => {
    mockGetChatInfo.mockRejectedValue(new Error("network timeout"));
    const result = await resolveGroupName({ account, chatId: "oc_test2", log });
    expect(result).toBeUndefined();
    expect(log).toHaveBeenCalledWith(
      "feishu[test-account]: getChatInfo failed for oc_test2: Error: network timeout",
    );
  });

  it("returns undefined for whitespace-only name", async () => {
    mockGetChatInfo.mockResolvedValue({ name: "   " });
    const result = await resolveGroupName({ account, chatId: "oc_test3", log });
    expect(result).toBeUndefined();
  });

  it("serves subsequent calls from cache (positive hit)", async () => {
    mockGetChatInfo.mockResolvedValue({ name: "Cached Group" });
    await resolveGroupName({ account, chatId: "oc_test4", log });
    const result = await resolveGroupName({ account, chatId: "oc_test4", log });
    expect(result).toBe("Cached Group");
    expect(mockGetChatInfo).toHaveBeenCalledOnce(); // only 1 API call
  });

  it("caches negative result (API failure) and skips retry", async () => {
    mockGetChatInfo.mockRejectedValue(new Error("fail"));
    await resolveGroupName({ account, chatId: "oc_test5", log });
    mockGetChatInfo.mockResolvedValue({ name: "Recovered" });
    const result = await resolveGroupName({ account, chatId: "oc_test5", log });
    expect(result).toBeUndefined(); // still cached negative
    expect(mockGetChatInfo).toHaveBeenCalledOnce();
  });

  it("returns undefined when API returns object with missing name field", async () => {
    mockGetChatInfo.mockResolvedValue({ name: undefined });
    const result = await resolveGroupName({ account, chatId: "oc_test6", log });
    expect(result).toBeUndefined();
  });

  it("isolates cache entries across different accounts", async () => {
    const accountA = makeAccount("account-A");
    const accountB = makeAccount("account-B");
    mockGetChatInfo
      .mockResolvedValueOnce({ name: "Team Alpha" })
      .mockResolvedValueOnce({ name: "Team Beta" });

    const nameA = await resolveGroupName({ account: accountA, chatId: "oc_shared", log });
    const nameB = await resolveGroupName({ account: accountB, chatId: "oc_shared", log });

    expect(nameA).toBe("Team Alpha");
    expect(nameB).toBe("Team Beta");
    expect(mockGetChatInfo).toHaveBeenCalledTimes(2); // separate API calls
  });
});
