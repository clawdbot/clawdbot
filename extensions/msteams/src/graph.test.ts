import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  loadMSTeamsSdkWithAuthMock,
  createMSTeamsTokenProviderMock,
  readAccessTokenMock,
  resolveMSTeamsCredentialsMock,
} = vi.hoisted(() => {
  return {
    loadMSTeamsSdkWithAuthMock: vi.fn(),
    createMSTeamsTokenProviderMock: vi.fn(),
    readAccessTokenMock: vi.fn(),
    resolveMSTeamsCredentialsMock: vi.fn(),
  };
});

vi.mock("./sdk.js", () => ({
  loadMSTeamsSdkWithAuth: loadMSTeamsSdkWithAuthMock,
  createMSTeamsTokenProvider: createMSTeamsTokenProviderMock,
}));

vi.mock("./token-response.js", () => ({
  readAccessToken: readAccessTokenMock,
}));

vi.mock("./token.js", () => ({
  resolveMSTeamsCredentials: resolveMSTeamsCredentialsMock,
}));

import { searchGraphUsers } from "./graph-users.js";
import {
  deleteGraphRequest,
  escapeOData,
  fetchAllGraphPages,
  fetchGraphJson,
  listChannelsForTeam,
  listTeamsByName,
  normalizeQuery,
  postGraphBetaJson,
  postGraphJson,
  resolveGraphToken,
} from "./graph.js";

const originalFetch = globalThis.fetch;
const graphToken = "graph-token";
const mockCredentials = {
  appId: "app-id",
  appPassword: "app-password",
  tenantId: "tenant-id",
};
const mockApp = { id: "mock-app" };
const groupOne = { id: "group-1" };
const opsTeam = { id: "team-1", displayName: "Ops" };
const deploymentsChannel = { id: "chan-1", displayName: "Deployments" };
const userOne = { id: "user-1", displayName: "User One" };
const bobUser = { id: "user-2", displayName: "Bob" };

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

function textResponse(body: string, init?: ResponseInit): Response {
  return new Response(body, init);
}

function mockFetch(handler: Parameters<typeof vi.fn>[0]) {
  globalThis.fetch = vi.fn(handler) as unknown as typeof fetch;
}

function mockJsonFetchResponse(body: unknown, init?: ResponseInit) {
  mockFetch(async () => jsonResponse(body, init));
}

function mockTextFetchResponse(body: string, init?: ResponseInit) {
  mockFetch(async () => textResponse(body, init));
}

function graphCollection<T>(...items: T[]) {
  return { value: items };
}

function mockGraphCollection(...items: unknown[]) {
  mockJsonFetchResponse(graphCollection(...items));
}

function requestUrl(input: string | URL | Request) {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  return input.url;
}

function fetchCallUrl(index: number) {
  const input = vi.mocked(globalThis.fetch).mock.calls[index]?.[0];
  if (!input) {
    return "";
  }
  return requestUrl(input);
}

function expectFetchPathContains(index: number, expectedPath: string) {
  expect(fetchCallUrl(index)).toContain(expectedPath);
}

async function expectSearchGraphUsers(
  query: string,
  expected: Array<Record<string, unknown>>,
  options?: { token?: string; top?: number },
) {
  await expect(
    searchGraphUsers({
      token: options?.token ?? graphToken,
      query,
      top: options?.top,
    }),
  ).resolves.toEqual(expected);
}

async function expectRejectsToThrow(promise: Promise<unknown>, message: string) {
  await expect(promise).rejects.toThrow(message);
}

function mockGraphTokenResolution(options?: {
  rawToken?: string | null;
  resolvedToken?: string | null;
}) {
  const rawToken = options && "rawToken" in options ? options.rawToken : "raw-graph-token";
  const resolvedToken =
    options && "resolvedToken" in options ? options.resolvedToken : "resolved-token";
  const getAccessToken = vi.fn(async () => rawToken);
  loadMSTeamsSdkWithAuthMock.mockResolvedValue({ app: mockApp });
  createMSTeamsTokenProviderMock.mockReturnValue({ getAccessToken });
  resolveMSTeamsCredentialsMock.mockReturnValue(mockCredentials);
  readAccessTokenMock.mockReturnValue(resolvedToken);
  return { getAccessToken };
}

describe("msteams graph helpers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("normalizes queries and escapes OData apostrophes", () => {
    expect(normalizeQuery("  Team Alpha  ")).toBe("Team Alpha");
    expect(normalizeQuery("   ")).toBe("");
    expect(escapeOData("alice.o'hara")).toBe("alice.o''hara");
  });

  it("fetches Graph JSON and surfaces Graph errors with response text", async () => {
    mockGraphCollection(groupOne);

    await expect(
      fetchGraphJson<{ value: Array<{ id: string }> }>({
        token: graphToken,
        path: "/groups?$select=id",
        headers: { ConsistencyLevel: "eventual" },
      }),
    ).resolves.toEqual(graphCollection(groupOne));

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://graph.microsoft.com/v1.0/groups?$select=id",
      {
        headers: expect.objectContaining({
          Authorization: `Bearer ${graphToken}`,
          ConsistencyLevel: "eventual",
        }),
      },
    );

    mockTextFetchResponse("forbidden", { status: 403 });

    await expectRejectsToThrow(
      fetchGraphJson({
        token: graphToken,
        path: "/teams/team-1/channels",
      }),
      "Graph /teams/team-1/channels failed (403): forbidden",
    );
  });

  it("posts Graph JSON to v1 and beta roots and treats empty mutation responses as undefined", async () => {
    mockFetch(async (input) => {
      if (requestUrl(input).startsWith("https://graph.microsoft.com/beta")) {
        return new Response(null, { status: 204 });
      }
      return jsonResponse({ id: "created-1" });
    });

    await expect(
      postGraphJson<{ id: string }>({
        token: graphToken,
        path: "/chats/chat-1/pinnedMessages",
        body: { messageId: "msg-1" },
      }),
    ).resolves.toEqual({ id: "created-1" });

    await expect(
      postGraphBetaJson<undefined>({
        token: graphToken,
        path: "/chats/chat-1/messages/msg-1/setReaction",
        body: { reactionType: "like" },
      }),
    ).resolves.toBeUndefined();

    expect(globalThis.fetch).toHaveBeenNthCalledWith(
      1,
      "https://graph.microsoft.com/v1.0/chats/chat-1/pinnedMessages",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ messageId: "msg-1" }),
        headers: expect.objectContaining({
          Authorization: `Bearer ${graphToken}`,
          "Content-Type": "application/json",
        }),
      }),
    );
    expect(globalThis.fetch).toHaveBeenNthCalledWith(
      2,
      "https://graph.microsoft.com/beta/chats/chat-1/messages/msg-1/setReaction",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ reactionType: "like" }),
      }),
    );
  });

  it("surfaces POST and DELETE graph failures with method-specific labels", async () => {
    mockFetch(async (_input, init) => {
      const method = init?.method ?? "GET";
      if (method === "DELETE") {
        return textResponse("not found", { status: 404 });
      }
      return textResponse("denied", { status: 403 });
    });

    await expectRejectsToThrow(
      postGraphJson({
        token: graphToken,
        path: "/teams/team-1/channels",
        body: { displayName: "Deployments" },
      }),
      "Graph POST /teams/team-1/channels failed (403): denied",
    );

    await expectRejectsToThrow(
      deleteGraphRequest({
        token: graphToken,
        path: "/teams/team-1/channels/channel-1",
      }),
      "Graph DELETE /teams/team-1/channels/channel-1 failed (404): not found",
    );
  });

  it("resolves Graph tokens through the SDK auth provider", async () => {
    const { getAccessToken } = mockGraphTokenResolution();

    await expect(resolveGraphToken({ channels: { msteams: {} } })).resolves.toBe("resolved-token");

    expect(createMSTeamsTokenProviderMock).toHaveBeenCalledWith(mockApp);
    expect(getAccessToken).toHaveBeenCalledWith("https://graph.microsoft.com");
  });

  it("fails when credentials or access tokens are unavailable", async () => {
    resolveMSTeamsCredentialsMock.mockReturnValue(undefined);
    await expectRejectsToThrow(resolveGraphToken({ channels: {} }), "MS Teams credentials missing");

    mockGraphTokenResolution({ rawToken: null, resolvedToken: null });

    await expectRejectsToThrow(
      resolveGraphToken({ channels: { msteams: {} } }),
      "MS Teams graph token unavailable",
    );
  });

  it("builds encoded Graph paths for teams and channels", async () => {
    mockFetch(async (input) => {
      if (requestUrl(input).includes("/groups?")) {
        return jsonResponse(graphCollection(opsTeam));
      }
      return jsonResponse(graphCollection(deploymentsChannel));
    });

    await expect(listTeamsByName(graphToken, "Bob's Team")).resolves.toEqual([opsTeam]);
    await expect(listChannelsForTeam(graphToken, "team/ops")).resolves.toEqual([
      deploymentsChannel,
    ]);

    expectFetchPathContains(
      0,
      "/groups?$filter=resourceProvisioningOptions%2FAny(x%3Ax%20eq%20'Team')%20and%20startsWith(displayName%2C'Bob''s%20Team')&$select=id,displayName",
    );
    expectFetchPathContains(1, "/teams/team%2Fops/channels?$select=id,displayName");
  });

  it("returns no graph users for blank queries", async () => {
    mockJsonFetchResponse({});
    await expectSearchGraphUsers("   ", [], { token: "token-1" });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("uses exact mail or UPN lookup for email-like graph user queries", async () => {
    mockGraphCollection(userOne);

    await expectSearchGraphUsers("alice.o'hara@example.com", [userOne], {
      token: "token-2",
    });
    expectFetchPathContains(
      0,
      "/users?$filter=(mail%20eq%20'alice.o''hara%40example.com'%20or%20userPrincipalName%20eq%20'alice.o''hara%40example.com')&$select=id,displayName,mail,userPrincipalName",
    );
  });

  it("uses displayName search with eventual consistency and default top handling", async () => {
    mockFetch(async (input) => {
      if (requestUrl(input).includes("displayName%3Abob")) {
        return jsonResponse(graphCollection(bobUser));
      }
      return jsonResponse({});
    });

    await expectSearchGraphUsers("bob", [bobUser], {
      token: "token-3",
      top: 25,
    });
    await expectSearchGraphUsers("carol", [], { token: "token-4" });

    const calls = vi.mocked(globalThis.fetch).mock.calls;
    expectFetchPathContains(
      0,
      "/users?$search=%22displayName%3Abob%22&$select=id,displayName,mail,userPrincipalName&$top=25",
    );
    expect(calls[0]?.[1]).toEqual(
      expect.objectContaining({
        headers: expect.objectContaining({ ConsistencyLevel: "eventual" }),
      }),
    );
    expectFetchPathContains(
      1,
      "/users?$search=%22displayName%3Acarol%22&$select=id,displayName,mail,userPrincipalName&$top=10",
    );
  });

  describe("fetchAllGraphPages", () => {
    type Item = { id: string; name: string };

    /** Build a paged Graph response with optional nextLink. */
    function pagedResponse(items: Item[], nextLink?: string) {
      const body: Record<string, unknown> = { value: items };
      if (nextLink) {
        body["@odata.nextLink"] = nextLink;
      }
      return body;
    }

    it("single page, no nextLink", async () => {
      const items = [{ id: "1", name: "a" }];
      mockJsonFetchResponse(pagedResponse(items));

      const result = await fetchAllGraphPages<Item>({
        token: graphToken,
        path: "/items",
      });

      expect(result).toEqual({ items, truncated: false });
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    });

    it("multiple pages with nextLink chain", async () => {
      const page1Items = [{ id: "1", name: "a" }];
      const page2Items = [{ id: "2", name: "b" }];
      const page3Items = [{ id: "3", name: "c" }];
      let callCount = 0;

      mockFetch(async () => {
        callCount++;
        if (callCount === 1) {
          return jsonResponse(
            pagedResponse(page1Items, "https://graph.microsoft.com/v1.0/items?$skiptoken=page2"),
          );
        }
        if (callCount === 2) {
          return jsonResponse(
            pagedResponse(page2Items, "https://graph.microsoft.com/v1.0/items?$skiptoken=page3"),
          );
        }
        return jsonResponse(pagedResponse(page3Items));
      });

      const result = await fetchAllGraphPages<Item>({
        token: graphToken,
        path: "/items",
      });

      expect(result.items).toEqual([...page1Items, ...page2Items, ...page3Items]);
      expect(result.truncated).toBe(false);
      expect(globalThis.fetch).toHaveBeenCalledTimes(3);
    });

    it("truncation at maxPages", async () => {
      mockFetch(async () =>
        jsonResponse(
          pagedResponse(
            [{ id: "x", name: "x" }],
            "https://graph.microsoft.com/v1.0/items?$skiptoken=more",
          ),
        ),
      );

      const result = await fetchAllGraphPages<Item>({
        token: graphToken,
        path: "/items",
        maxPages: 2,
      });

      expect(result.items).toHaveLength(2);
      expect(result.truncated).toBe(true);
      expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    });

    it("findOne early exit", async () => {
      const target = { id: "target", name: "found-it" };
      let callCount = 0;

      mockFetch(async () => {
        callCount++;
        if (callCount === 1) {
          return jsonResponse(
            pagedResponse(
              [{ id: "1", name: "a" }],
              "https://graph.microsoft.com/v1.0/items?$skiptoken=p2",
            ),
          );
        }
        // Page 2 contains the target; page 3 should never be fetched
        return jsonResponse(
          pagedResponse(
            [{ id: "2", name: "b" }, target],
            "https://graph.microsoft.com/v1.0/items?$skiptoken=p3",
          ),
        );
      });

      const result = await fetchAllGraphPages<Item>({
        token: graphToken,
        path: "/items",
        findOne: (item) => item.id === "target",
      });

      expect(result.found).toEqual(target);
      expect(result.truncated).toBe(false);
      // Page 1 items + page 2 items (where match was found)
      expect(result.items).toEqual([{ id: "1", name: "a" }, { id: "2", name: "b" }, target]);
      // Only 2 fetches; page 3 was never requested
      expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    });

    it("findOne with no match (exhausted)", async () => {
      mockJsonFetchResponse(pagedResponse([{ id: "1", name: "a" }]));

      const result = await fetchAllGraphPages<Item>({
        token: graphToken,
        path: "/items",
        findOne: (item) => item.id === "missing",
      });

      expect(result.found).toBeUndefined();
      expect(result.truncated).toBe(false);
      expect(result.items).toEqual([{ id: "1", name: "a" }]);
    });

    it("findOne with no match (truncated)", async () => {
      mockFetch(async () =>
        jsonResponse(
          pagedResponse(
            [{ id: "x", name: "x" }],
            "https://graph.microsoft.com/v1.0/items?$skiptoken=more",
          ),
        ),
      );

      const result = await fetchAllGraphPages<Item>({
        token: graphToken,
        path: "/items",
        maxPages: 2,
        findOne: (item) => item.id === "missing",
      });

      expect(result.found).toBeUndefined();
      expect(result.truncated).toBe(true);
      expect(result.items).toHaveLength(2);
    });

    it("empty first page", async () => {
      mockJsonFetchResponse(pagedResponse([]));

      const result = await fetchAllGraphPages<Item>({
        token: graphToken,
        path: "/items",
      });

      expect(result).toEqual({ items: [], truncated: false });
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    });
  });
});
