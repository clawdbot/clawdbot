import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { LookupFn } from "openclaw/plugin-sdk/ssrf-runtime";
import { describe, expect, it, vi } from "vitest";
import { claimClickClackSetupCode } from "./setup-claim.js";

function createLookupFn(...addresses: string[]): LookupFn {
  let index = 0;
  return vi.fn(async (_hostname: string, options?: unknown) => {
    const address = addresses[Math.min(index, addresses.length - 1)];
    index += 1;
    if (!address) {
      throw new Error("missing mocked DNS address");
    }
    const result = { address, family: 4 as const };
    if (typeof options === "object" && options && (options as { all?: boolean }).all) {
      return [result];
    }
    return result;
  }) as unknown as LookupFn;
}

function requestBodyJson(init: RequestInit | undefined): unknown {
  const body = init?.body;
  if (typeof body !== "string") {
    throw new Error("expected string request body");
  }
  return JSON.parse(body);
}

function claimResponse(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    token: "test-token",
    bot: {
      id: "usr_bot",
      handle: "openclaw",
      display_name: "OpenClaw",
    },
    workspace: {
      id: "wsp_1",
      route_id: "clickclack",
      slug: "default",
      name: "ClickClack",
    },
    defaults: {
      defaultTo: "channel:general",
      allowFrom: ["*"],
      agentActivity: true,
    },
    ...extra,
  };
}

describe("ClickClack setup-code claim", () => {
  it("claims over guarded HTTPS without bearer authentication", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      Response.json({
        token: "test-token",
        bot: {
          id: "usr_bot",
          handle: "openclaw",
          display_name: "OpenClaw",
        },
        workspace: {
          id: "wsp_1",
          route_id: "clickclack",
          slug: "default",
          name: "ClickClack",
        },
        defaults: {
          defaultTo: "channel:general",
          allowFrom: ["*"],
          agentActivity: true,
        },
      }),
    );

    await expect(
      claimClickClackSetupCode({
        claimUrl: "https://clickclack.example/api/bot-setup-codes/claim",
        code: "ABCD-EFGH-JKMP",
        fetch: fetchMock as unknown as typeof fetch,
      }),
    ).resolves.toEqual({
      token: "test-token",
      bot: {
        id: "usr_bot",
        handle: "openclaw",
        display_name: "OpenClaw",
      },
      workspace: {
        id: "wsp_1",
        route_id: "clickclack",
        slug: "default",
        name: "ClickClack",
      },
      defaults: {
        defaultTo: "channel:general",
        allowFrom: ["*"],
        agentActivity: true,
      },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://clickclack.example/api/bot-setup-codes/claim",
    );
    const init = fetchMock.mock.calls[0]?.[1];
    expect(init).toMatchObject({ method: "POST", redirect: "manual" });
    expect(requestBodyJson(init)).toEqual({ code: "ABCD-EFGH-JKMP" });
    const headers = new Headers(init?.headers);
    expect(headers.get("Authorization")).toBeNull();
    expect(headers.get("Content-Type")).toBe("application/json");
  });

  it("accepts a matching v1 contract with a path-mounted API base", async () => {
    const apiBaseUrl = "https://api.clickclack.example/services/clickclack";
    const claimUrl = `${apiBaseUrl}/api/bot-setup-codes/claim`;
    const fetchMock = vi.fn(async () =>
      Response.json(
        claimResponse({
          contract_version: 1,
          api_base_url: apiBaseUrl,
        }),
      ),
    );

    await expect(
      claimClickClackSetupCode({
        claimUrl,
        expectedClaimUrl: claimUrl,
        code: "ABCD-EFGH-JKMP",
        fetch: fetchMock as unknown as typeof fetch,
      }),
    ).resolves.toMatchObject({
      contract_version: 1,
      api_base_url: apiBaseUrl,
      token: "test-token",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      claimUrl,
      expect.objectContaining({ method: "POST", redirect: "manual" }),
    );
  });

  it("rejects incomplete, unsupported, and mismatched v1 metadata", async () => {
    const claimUrl = "https://api.clickclack.example/services/clickclack/api/bot-setup-codes/claim";
    const fetchMock = vi.fn();
    for (const [response, message] of [
      [claimResponse(), "legacy response"],
      [
        claimResponse({
          contract_version: 2,
          api_base_url: "https://api.clickclack.example/services/clickclack",
        }),
        "invalid v1 contract metadata",
      ],
      [
        claimResponse({
          contract_version: 1,
          api_base_url: "https://other.example/services/clickclack",
        }),
        "does not match the claim URL",
      ],
      [
        claimResponse({
          contract_version: 1,
          api_base_url: "https://api.clickclack.example/services/clickclack?invalid=1",
        }),
        "response.api_base_url is invalid",
      ],
      [
        claimResponse({
          contract_version: 1,
          api_base_url: "http://10.0.0.5/services/clickclack",
        }),
        "must use HTTPS unless it is on loopback",
      ],
    ] as const) {
      fetchMock.mockResolvedValueOnce(Response.json(response));
      await expect(
        claimClickClackSetupCode({
          claimUrl,
          expectedClaimUrl: claimUrl,
          code: "ABCD-EFGH-JKMP",
          fetch: fetchMock as unknown as typeof fetch,
        }),
      ).rejects.toThrow(message);
    }
  });

  it("pins the validated loopback address when claiming over HTTP", async () => {
    const server = createServer((_request, response) => {
      response.setHeader("Content-Type", "application/json");
      response.end(
        JSON.stringify({
          token: "test-token",
          bot: { id: "usr_bot", handle: "openclaw", display_name: "OpenClaw" },
          workspace: {
            id: "wsp_1",
            route_id: "clickclack",
            slug: "default",
            name: "ClickClack",
          },
          defaults: {},
        }),
      );
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const port = (server.address() as AddressInfo).port;
    const lookupFn = createLookupFn("127.0.0.1", "93.184.216.34");

    try {
      await expect(
        claimClickClackSetupCode({
          claimUrl: `http://localhost:${port}/api/bot-setup-codes/claim`,
          code: "ABCD-EFGH-JKMP",
          lookupFn,
        }),
      ).resolves.toMatchObject({
        token: "test-token",
        workspace: { id: "wsp_1" },
      });
      expect(lookupFn).toHaveBeenCalledTimes(2);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("rejects non-loopback HTTP claims before sending a request", async () => {
    const fetchMock = vi.fn();

    for (const address of ["10.0.0.5", "93.184.216.34", "198.18.0.1"]) {
      await expect(
        claimClickClackSetupCode({
          claimUrl: "http://clickclack.example/api/bot-setup-codes/claim",
          code: "ABCD-EFGH-JKMP",
          fetch: fetchMock as unknown as typeof fetch,
          lookupFn: createLookupFn(address),
        }),
      ).rejects.toThrow("ClickClack setup codes require HTTPS unless the server is on loopback.");
    }

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("bounds private-host DNS resolution with the claim timeout", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn();
    const lookupFn = vi.fn(() => new Promise<never>(() => {})) as unknown as LookupFn;

    try {
      const claim = expect(
        claimClickClackSetupCode({
          claimUrl: "http://clickclack.internal/api/bot-setup-codes/claim",
          code: "ABCD-EFGH-JKMP",
          fetch: fetchMock as unknown as typeof fetch,
          lookupFn,
        }),
      ).rejects.toThrow("ClickClack setup code claim timed out after 30000ms");

      await vi.advanceTimersByTimeAsync(30_000);
      await claim;
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects malformed claim responses", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        token: "test-token",
        bot: { id: "usr_bot", handle: "openclaw", display_name: "OpenClaw" },
        workspace: { id: "wsp_1", route_id: "clickclack", slug: "default" },
        defaults: {},
      }),
    );

    await expect(
      claimClickClackSetupCode({
        claimUrl: "https://clickclack.example/api/bot-setup-codes/claim",
        code: "ABCD-EFGH-JKMP",
        fetch: fetchMock as unknown as typeof fetch,
      }),
    ).rejects.toThrow("invalid workspace.name");
  });
});
