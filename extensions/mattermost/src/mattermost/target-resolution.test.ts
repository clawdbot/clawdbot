import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const resolveMattermostAccount = vi.fn();
const createMattermostClient = vi.fn();
const fetchMattermostUser = vi.fn();
const normalizeMattermostBaseUrl = vi.fn((value: string | undefined) => value?.trim());

vi.mock("./accounts.js", () => ({
  resolveMattermostAccount,
}));

vi.mock("./client.js", () => ({
  createMattermostClient,
  fetchMattermostUser,
  normalizeMattermostBaseUrl,
}));

describe("mattermost target resolution", () => {
  let isExplicitMattermostTarget: typeof import("./target-resolution.js").isExplicitMattermostTarget;
  let isMattermostId: typeof import("./target-resolution.js").isMattermostId;
  let parseMattermostApiStatus: typeof import("./target-resolution.js").parseMattermostApiStatus;
  let resolveMattermostOpaqueTarget: typeof import("./target-resolution.js").resolveMattermostOpaqueTarget;
  let resetMattermostOpaqueTargetCacheForTests: typeof import("./target-resolution.js").resetMattermostOpaqueTargetCacheForTests;

  beforeAll(async () => {
    ({
      isExplicitMattermostTarget,
      isMattermostId,
      parseMattermostApiStatus,
      resolveMattermostOpaqueTarget,
      resetMattermostOpaqueTargetCacheForTests,
    } = await import("./target-resolution.js"));
  });

  beforeEach(() => {
    resolveMattermostAccount.mockReset();
    createMattermostClient.mockReset();
    fetchMattermostUser.mockReset();
    normalizeMattermostBaseUrl.mockClear();
  });

  afterEach(() => {
    resetMattermostOpaqueTargetCacheForTests();
  });

  it("recognizes explicit targets and ID-shaped values", () => {
    expect(isExplicitMattermostTarget("@alice")).toBe(true);
    expect(isExplicitMattermostTarget("#town-square")).toBe(true);
    expect(isExplicitMattermostTarget("mattermost:chan")).toBe(true);
    expect(isExplicitMattermostTarget(" plain ")).toBe(false);
    expect(isMattermostId("abcd1234abcd1234abcd1234ab")).toBe(true);
    expect(isMattermostId("short")).toBe(false);
    expect(parseMattermostApiStatus(new Error("Mattermost API 404 Not Found"))).toBe(404);
    expect(parseMattermostApiStatus(new Error("other error"))).toBeUndefined();
  });

  it("resolves opaque ids as users and caches the result", async () => {
    createMattermostClient.mockReturnValue({ client: true });
    fetchMattermostUser.mockResolvedValue({ id: "abcd1234abcd1234abcd1234ab" });
    const input = "abcd1234abcd1234abcd1234ab";

    await expect(
      resolveMattermostOpaqueTarget({
        input,
        token: "token",
        baseUrl: "https://mm.example.com",
      }),
    ).resolves.toEqual({
      kind: "user",
      id: input,
      to: `user:${input}`,
    });

    await expect(
      resolveMattermostOpaqueTarget({
        input,
        token: "token",
        baseUrl: "https://mm.example.com",
      }),
    ).resolves.toEqual({
      kind: "user",
      id: input,
      to: `user:${input}`,
    });

    expect(createMattermostClient).toHaveBeenCalledTimes(1);
    expect(fetchMattermostUser).toHaveBeenCalledTimes(1);
  });

  it("falls back to channel targets on 404 lookups", async () => {
    createMattermostClient.mockReturnValue({ client: true });
    fetchMattermostUser.mockRejectedValue(new Error("Mattermost API 404 Not Found"));
    const input = "bcde1234abcd1234abcd1234ab";

    await expect(
      resolveMattermostOpaqueTarget({
        input,
        token: "token",
        baseUrl: "https://mm.example.com",
      }),
    ).resolves.toEqual({
      kind: "channel",
      id: input,
      to: `channel:${input}`,
    });
  });

  it("uses account resolution when token/base url are not passed", async () => {
    resolveMattermostAccount.mockReturnValue({
      baseUrl: "https://mm.example.com",
      botToken: "token",
    });
    createMattermostClient.mockReturnValue({ client: true });
    fetchMattermostUser.mockResolvedValue({ id: "cdef1234abcd1234abcd1234ab" });
    const input = "cdef1234abcd1234abcd1234ab";

    await resolveMattermostOpaqueTarget({
      input,
      cfg: { channels: { mattermost: {} } },
      accountId: "acct-1",
    });

    expect(resolveMattermostAccount).toHaveBeenCalledWith({
      cfg: { channels: { mattermost: {} } },
      accountId: "acct-1",
    });
  });
});
