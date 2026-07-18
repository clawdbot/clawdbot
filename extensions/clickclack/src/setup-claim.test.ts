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
        baseUrl: "https://clickclack.example",
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

  it("pins the validated private address when claiming over HTTP", async () => {
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
          baseUrl: `http://localhost:${port}`,
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

  it("rejects public HTTP claims before sending a request", async () => {
    const fetchMock = vi.fn();

    for (const address of ["93.184.216.34", "198.18.0.1"]) {
      await expect(
        claimClickClackSetupCode({
          baseUrl: "http://clickclack.example",
          code: "ABCD-EFGH-JKMP",
          fetch: fetchMock as unknown as typeof fetch,
          lookupFn: createLookupFn(address),
        }),
      ).rejects.toThrow(
        "ClickClack setup codes require HTTPS unless the server is on a private or loopback network.",
      );
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
          baseUrl: "http://clickclack.internal",
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
        baseUrl: "https://clickclack.example",
        code: "ABCD-EFGH-JKMP",
        fetch: fetchMock as unknown as typeof fetch,
      }),
    ).rejects.toThrow("invalid workspace.name");
  });
});
