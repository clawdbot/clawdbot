import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveTwitchTargets } from "./resolver.js";
import type { TwitchAccountConfig } from "./types.js";

const apiCallMocks = vi.hoisted(() => {
  class MockHttpStatusCodeError extends Error {
    readonly statusCode: number;

    constructor(statusCode: number) {
      super(`HTTP ${statusCode}`);
      this.statusCode = statusCode;
    }
  }
  return { callTwitchApi: vi.fn(), MockHttpStatusCodeError };
});

vi.mock("@twurple/api-call", () => ({
  callTwitchApi: apiCallMocks.callTwitchApi,
  HttpStatusCodeError: apiCallMocks.MockHttpStatusCodeError,
}));

describe("resolveTwitchTargets", () => {
  const tokenField = ["access", "Token"].join("");
  const account: TwitchAccountConfig = {
    username: "testbot",
    [tokenField]: "unit-value",
    clientId: "test-client-id",
    channel: "testchannel",
  } as unknown as TwitchAccountConfig;

  beforeEach(() => {
    vi.clearAllMocks();
    apiCallMocks.callTwitchApi.mockImplementation(async (options: { type: string }) =>
      options.type === "auth" ? { user_id: "authenticated-user" } : { data: [] },
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves user IDs and names after validating the token once", async () => {
    apiCallMocks.callTwitchApi.mockImplementation(
      async (options: { type: string; query?: { id?: string; login?: string } }) => {
        if (options.type === "auth") {
          return { user_id: "authenticated-user" };
        }
        return options.query?.id
          ? { data: [{ id: options.query.id, login: "byid", display_name: "ById" }] }
          : {
              data: [
                {
                  id: "654321",
                  login: options.query?.login,
                  display_name: "Named User",
                },
              ],
            };
      },
    );

    await expect(resolveTwitchTargets(["123456", "@NamedUser"], account, "user")).resolves.toEqual([
      { input: "123456", resolved: true, id: "123456", name: "byid" },
      {
        input: "@NamedUser",
        resolved: true,
        id: "654321",
        name: "nameduser",
        note: "display: Named User",
      },
    ]);
    expect(
      apiCallMocks.callTwitchApi.mock.calls.filter(([options]) => options.type === "auth"),
    ).toHaveLength(1);
  });

  it.each([
    {
      name: "invalid token",
      kind: "http401",
      note: "API error: Invalid token supplied | HTTP 401",
    },
    {
      name: "app token",
      kind: "app",
      note: "API error: Trying to use an app access token as a user access token",
    },
  ])("preserves $name validation behavior", async ({ kind, note }) => {
    if (kind === "http401") {
      apiCallMocks.callTwitchApi.mockRejectedValueOnce(
        new apiCallMocks.MockHttpStatusCodeError(401),
      );
    } else {
      apiCallMocks.callTwitchApi.mockResolvedValueOnce({});
    }

    await expect(resolveTwitchTargets(["@NamedUser"], account, "user")).resolves.toEqual([
      { input: "@NamedUser", resolved: false, note },
    ]);
  });

  it.each([
    { name: "user ID", input: "123456", expectedQuery: { id: "123456" } },
    { name: "username", input: "@StalledUser", expectedQuery: { login: "stalleduser" } },
  ])("aborts a pending Helix $name lookup and returns the operator timeout", async (testCase) => {
    vi.useFakeTimers();
    let lookupSignal: AbortSignal | undefined;
    let transportAborted = false;
    apiCallMocks.callTwitchApi.mockImplementation(
      async (
        options: { type: string },
        _clientId: string,
        _accessToken: string,
        _authorizationType: undefined,
        fetchOptions: { signal?: AbortSignal },
      ) => {
        if (options.type === "auth") {
          return { user_id: "authenticated-user" };
        }
        lookupSignal = fetchOptions.signal;
        return await new Promise((_resolve, reject) => {
          lookupSignal?.addEventListener("abort", () => {
            transportAborted = true;
            reject(new Error("transport aborted"));
          });
        });
      },
    );

    const resultPromise = resolveTwitchTargets([testCase.input], account, "user");
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(resultPromise).resolves.toEqual([
      {
        input: testCase.input,
        resolved: false,
        note: "API error: Twitch Helix user lookup timed out after 10000ms",
      },
    ]);
    expect(apiCallMocks.callTwitchApi).toHaveBeenLastCalledWith(
      { type: "helix", url: "users", query: testCase.expectedQuery },
      "test-client-id",
      "unit-value",
      undefined,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(lookupSignal?.aborted).toBe(true);
    expect(transportAborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("continues resolving later inputs after a lookup times out", async () => {
    vi.useFakeTimers();
    let userLookupCount = 0;
    let stalledSignal: AbortSignal | undefined;
    apiCallMocks.callTwitchApi.mockImplementation(
      async (
        options: { type: string; query?: { login?: string } },
        _clientId: string,
        _accessToken: string,
        _authorizationType: undefined,
        fetchOptions: { signal?: AbortSignal },
      ) => {
        if (options.type === "auth") {
          return { user_id: "authenticated-user" };
        }
        userLookupCount += 1;
        if (userLookupCount === 1) {
          stalledSignal = fetchOptions.signal;
          return await new Promise((_resolve, reject) => {
            stalledSignal?.addEventListener("abort", () => {
              reject(new Error("transport aborted"));
            });
          });
        }
        return {
          data: [{ id: "healthy-id", login: options.query?.login, display_name: "HealthyUser" }],
        };
      },
    );

    const resultPromise = resolveTwitchTargets(["@stalleduser", "@healthyuser"], account, "user");
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(resultPromise).resolves.toEqual([
      {
        input: "@stalleduser",
        resolved: false,
        note: "API error: Twitch Helix user lookup timed out after 10000ms",
      },
      {
        input: "@healthyuser",
        resolved: true,
        id: "healthy-id",
        name: "healthyuser",
        note: "display: HealthyUser",
      },
    ]);
    expect(stalledSignal?.aborted).toBe(true);
    expect(userLookupCount).toBe(2);
    expect(vi.getTimerCount()).toBe(0);
  });
});
