// Mattermost tests cover target resolution plugin behavior.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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
    normalizeMattermostBaseUrl.mockClear();
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

  it("falls back to channel targets on 404 lookups and caches the result", async () => {
    createMattermostClient.mockReturnValue({ client: true });
    fetchMattermostUser.mockRejectedValue(new Error("Mattermost API 404 Not Found"));
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
