// Mattermost tests cover target resolution plugin behavior.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const resolveMattermostAccount = vi.fn();
const createMattermostClient = vi.fn();
const fetchMattermostUser = vi.fn();
const fetchMattermostChannel = vi.fn();
const normalizeMattermostBaseUrl = vi.fn((value: string | undefined) => value?.trim());

vi.mock("./accounts.js", () => ({
  resolveMattermostAccount,
}));

vi.mock("./client.js", () => ({
  createMattermostClient,
  fetchMattermostUser,
  fetchMattermostChannel,
  normalizeMattermostBaseUrl,
}));

describe("mattermost target resolution", () => {
  let parseMattermostTarget: typeof import("./target-resolution.js").parseMattermostTarget;
  let resolveMattermostOpaqueTarget: typeof import("./target-resolution.js").resolveMattermostOpaqueTarget;

  beforeAll(async () => {
    ({ parseMattermostTarget, resolveMattermostOpaqueTarget } =
      await import("./target-resolution.js"));
  });

  beforeEach(() => {
    resolveMattermostAccount.mockReset();
    createMattermostClient.mockReset();
    fetchMattermostUser.mockReset();
    fetchMattermostChannel.mockReset();
    normalizeMattermostBaseUrl.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("recognizes ID-shaped values", () => {
    expect(parseMattermostTarget("abcd1234abcd1234abcd1234ab")).toEqual({
      kind: "channel",
      id: "abcd1234abcd1234abcd1234ab",
    });
    expect(parseMattermostTarget("short")).toEqual({ kind: "channel-name", name: "short" });
  });

  it.each(["@alice", "#town-square", "mattermost:chan"])(
    "skips explicit target %s before account resolution",
    async (input) => {
      await expect(resolveMattermostOpaqueTarget({ input })).resolves.toBeNull();
      expect(resolveMattermostAccount).not.toHaveBeenCalled();
      expect(createMattermostClient).not.toHaveBeenCalled();
    },
  );

  it("does not cache non-404 lookup failures", async () => {
    createMattermostClient.mockReturnValue({ client: true });
    fetchMattermostUser.mockRejectedValue(new Error("other error"));
    const params = {
      input: "defg1234abcd1234abcd1234ab",
      token: "token",
      baseUrl: "https://mm.example.com",
    };

    await expect(resolveMattermostOpaqueTarget(params)).resolves.toMatchObject({ kind: "channel" });
    await expect(resolveMattermostOpaqueTarget(params)).resolves.toMatchObject({ kind: "channel" });
    expect(fetchMattermostUser).toHaveBeenCalledTimes(2);
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

  it("resolves public channels (type O) as channel and caches the result", async () => {
    createMattermostClient.mockReturnValue({ client: true });
    fetchMattermostUser.mockRejectedValue(new Error("Mattermost API 404 Not Found"));
    fetchMattermostChannel.mockResolvedValue({ id: "bcde1234abcd1234abcd1234ab", type: "O" });
    const input = "bcde1234abcd1234abcd1234ab";
    const params = {
      input,
      token: "token",
      baseUrl: "https://mm.example.com",
    };

    await expect(resolveMattermostOpaqueTarget(params)).resolves.toEqual({
      kind: "channel",
      id: input,
      to: `channel:${input}`,
    });
    await expect(resolveMattermostOpaqueTarget(params)).resolves.toEqual({
      kind: "channel",
      id: input,
      to: `channel:${input}`,
    });

    expect(createMattermostClient).toHaveBeenCalledTimes(1);
    expect(fetchMattermostUser).toHaveBeenCalledTimes(1);
  });

  it("evicts in insertion order after the opaque cache reaches its cap", async () => {
    createMattermostClient.mockReturnValue({ client: true });
    fetchMattermostUser.mockResolvedValue({ id: "user" });
    const baseUrl = "https://mm.example.com";
    const token = "opaque-cache-token";
    const idFor = (index: number) => index.toString(36).padStart(26, "0");
    const resolve = (index: number) =>
      resolveMattermostOpaqueTarget({ input: idFor(index), token, baseUrl });

    for (let index = 0; index < 1024; index += 1) {
      await resolve(index);
    }
    expect(fetchMattermostUser).toHaveBeenCalledTimes(1024);

    await resolve(0);
    expect(fetchMattermostUser).toHaveBeenCalledTimes(1024);

    await resolve(1024);
    await resolve(0);
    await resolve(1024);
    expect(fetchMattermostUser).toHaveBeenCalledTimes(1026);
  });

  it("refreshes an authoritative classification after its cache TTL expires", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    createMattermostClient.mockReturnValue({ client: true });
    fetchMattermostUser.mockResolvedValue({ id: "ttl-user" });
    const params = {
      input: "ttll1234abcd1234abcd1234ab",
      token: "ttl-token",
      baseUrl: "https://mm.example.com",
    };

    await resolveMattermostOpaqueTarget(params);
    await resolveMattermostOpaqueTarget(params);
    expect(fetchMattermostUser).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(5 * 60 * 1000 + 1);
    await resolveMattermostOpaqueTarget(params);
    expect(fetchMattermostUser).toHaveBeenCalledTimes(2);
  });

  it("resolves private channels (type P) as group, keeping a channel:<id> wire target", async () => {
    createMattermostClient.mockReturnValue({ client: true });
    fetchMattermostUser.mockRejectedValue(new Error("Mattermost API 404 Not Found"));
    fetchMattermostChannel.mockResolvedValue({ id: "priv1234abcd1234abcd1234ab", type: "P" });
    const input = "priv1234abcd1234abcd1234ab";

    await expect(
      resolveMattermostOpaqueTarget({
        input,
        token: "token",
        baseUrl: "https://mm.example.com",
      }),
    ).resolves.toEqual({
      kind: "group",
      id: input,
      to: `channel:${input}`,
    });

    // Second call is served from cache (no extra channel lookup).
    await expect(
      resolveMattermostOpaqueTarget({
        input,
        token: "token",
        baseUrl: "https://mm.example.com",
      }),
    ).resolves.toEqual({ kind: "group", id: input, to: `channel:${input}` });
    expect(fetchMattermostChannel).toHaveBeenCalledTimes(1);
  });

  it("falls back to channel when the channel lookup fails", async () => {
    createMattermostClient.mockReturnValue({ client: true });
    fetchMattermostUser.mockRejectedValue(new Error("Mattermost API 404 Not Found"));
    fetchMattermostChannel.mockRejectedValue(new Error("Mattermost API 500"));
    const input = "fail1234abcd1234abcd1234ab";

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
    expect(fetchMattermostUser).toHaveBeenCalledTimes(2);
    expect(fetchMattermostChannel).toHaveBeenCalledTimes(2);
  });

  it("uses account resolution when token/base url are not passed", async () => {
    resolveMattermostAccount.mockReturnValue({
      accountId: "acct-1",
      enabled: true,
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

  it("rejects disabled accounts before cache or provider access", async () => {
    resolveMattermostAccount.mockReturnValue({
      accountId: "disabled",
      enabled: false,
      baseUrl: "https://mm.example.com",
      botToken: "token",
    });

    await expect(
      resolveMattermostOpaqueTarget({
        input: "disabled12abcd1234abcd1234",
        cfg: { channels: { mattermost: {} } },
        accountId: "disabled",
      }),
    ).rejects.toThrow('Mattermost account "disabled" is disabled');

    expect(normalizeMattermostBaseUrl).not.toHaveBeenCalled();
    expect(createMattermostClient).not.toHaveBeenCalled();
    expect(fetchMattermostUser).not.toHaveBeenCalled();
  });
});
