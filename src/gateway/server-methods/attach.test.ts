import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveAttachGrant } from "../mcp-grant-store.js";
import { closeMcpLoopbackServer } from "../mcp-http.js";
import { attachHandlers } from "./attach.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

const loadSessionEntryMock = vi.hoisted(() =>
  vi.fn((_sessionKey: string) => ({ entry: undefined as Record<string, unknown> | undefined })),
);

vi.mock("../../config/sessions/session-accessor.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config/sessions/session-accessor.js")>();
  return {
    ...actual,
    resolveSessionEntryAccessTarget: (params: { sessionKey: string }) =>
      loadSessionEntryMock(params.sessionKey),
  };
});

const grantOpts = (sessionKey: string, respond: ReturnType<typeof vi.fn>) =>
  ({
    params: { sessionKey },
    respond,
    context: { getRuntimeConfig: () => ({}) },
  }) as unknown as GatewayRequestHandlerOptions;

describe("attach gateway methods", () => {
  beforeEach(() => {
    loadSessionEntryMock.mockReset();
    loadSessionEntryMock.mockReturnValue({ entry: undefined });
  });
  afterEach(async () => {
    // attach.grant lazily starts the loopback singleton; close it so it doesn't leak across files.
    await closeMcpLoopbackServer();
  });

  it("attach.grant mints a session-bound grant and returns loopback config + token env", async () => {
    const respond = vi.fn();
    await expectDefined(
      attachHandlers["attach.grant"],
      'attachHandlers["attach.grant"] test invariant',
    )(grantOpts("agent:main:attach-method", respond));

    expect(respond).toHaveBeenCalledTimes(1);
    const [ok, payload] = expectDefined(
      respond.mock.calls[0],
      "respond.mock.calls[0] test invariant",
    );
    expect(ok).toBe(true);
    const body = payload as {
      token: string;
      sessionKey: string;
      mcpConfig: unknown;
      env: Record<string, string>;
    };
    expect(body.sessionKey).toBe("agent:main:attach-method");
    expect(body.token).toMatch(/^[0-9a-f]{64}$/);
    expect(body.mcpConfig).toBeTruthy();
    expect(body.env.OPENCLAW_MCP_TOKEN).toBe(body.token);
    expect(Object.keys(body.env)).toEqual(["OPENCLAW_MCP_TOKEN"]);
    expect(resolveAttachGrant(body.token)?.sessionKey).toBe("agent:main:attach-method");
  });

  it("rejects attach grants for reserved harness sessions", async () => {
    const respond = vi.fn();
    await expectDefined(
      attachHandlers["attach.grant"],
      'attachHandlers["attach.grant"] test invariant',
    )(grantOpts("agent:main:harness:codex:supervision:native-thread", respond));

    const [ok, , error] = expectDefined(
      respond.mock.calls[0],
      "respond.mock.calls[0] test invariant",
    );
    expect(ok).toBe(false);
    expect(error).toMatchObject({ code: "INVALID_REQUEST" });
    expect((error as { message: string }).message).toContain("reserved");
  });

  it("allows an existing unlocked legacy harness-prefixed session", async () => {
    loadSessionEntryMock.mockReturnValue({
      entry: { sessionId: "legacy-session", modelSelectionLocked: false },
    });
    const respond = vi.fn();
    const sessionKey = "agent:main:harness:legacy-notes";

    await expectDefined(
      attachHandlers["attach.grant"],
      'attachHandlers["attach.grant"] test invariant',
    )(grantOpts(sessionKey, respond));

    expect(respond.mock.calls[0]?.[0]).toBe(true);
    const response = respond.mock.calls[0]?.[1] as { token: string } | undefined;
    expect(response).toBeDefined();
    const token = response?.token ?? "";
    expect(resolveAttachGrant(token)?.sessionKey).toBe(sessionKey);
  });

  it("rejects attach grants for existing locked harness sessions", async () => {
    loadSessionEntryMock.mockReturnValue({
      entry: {
        sessionId: "locked-session",
        agentHarnessId: "codex",
        modelSelectionLocked: true,
      },
    });
    const respond = vi.fn();

    await expectDefined(
      attachHandlers["attach.grant"],
      'attachHandlers["attach.grant"] test invariant',
    )(grantOpts("agent:main:harness:codex:supervision:native-thread", respond));

    expect(respond.mock.calls[0]?.[0]).toBe(false);
    expect(respond.mock.calls[0]?.[2]).toMatchObject({
      code: "INVALID_REQUEST",
      message: expect.stringContaining("reserved"),
    });
  });

  it("returns an attach MCP config whose env placeholders are all supplied", async () => {
    const respond = vi.fn();
    await expectDefined(
      attachHandlers["attach.grant"],
      'attachHandlers["attach.grant"] test invariant',
    )(grantOpts("agent:main:attach-method", respond));

    const body = expectDefined(
      respond.mock.calls[0],
      "respond.mock.calls[0] test invariant",
    )[1] as {
      mcpConfig: unknown;
      env: Record<string, string>;
    };
    const configText = JSON.stringify(body.mcpConfig);
    const placeholders = [...configText.matchAll(/\$\{([A-Z0-9_]+)\}/gu)].map((match) => match[1]);
    expect(new Set(placeholders)).toEqual(new Set(Object.keys(body.env)));
  });

  it("attach.revoke removes a grant; missing token is an INVALID_REQUEST", async () => {
    const grantRespond = vi.fn();
    await expectDefined(
      attachHandlers["attach.grant"],
      'attachHandlers["attach.grant"] test invariant',
    )(grantOpts("agent:main:revoke-me", grantRespond));
    const token = (
      expectDefined(grantRespond.mock.calls[0], "grantRespond.mock.calls[0] test invariant")[1] as {
        token: string;
      }
    ).token;

    const revokeRespond = vi.fn();
    await expectDefined(
      attachHandlers["attach.revoke"],
      'attachHandlers["attach.revoke"] test invariant',
    )({
      params: { token },
      respond: revokeRespond,
    } as unknown as GatewayRequestHandlerOptions);
    expect(revokeRespond).toHaveBeenCalledWith(true, { revoked: true });
    expect(resolveAttachGrant(token)).toBeUndefined();

    const errRespond = vi.fn();
    await expectDefined(
      attachHandlers["attach.revoke"],
      'attachHandlers["attach.revoke"] test invariant',
    )({
      params: {},
      respond: errRespond,
    } as unknown as GatewayRequestHandlerOptions);
    const [errOk, , err] = expectDefined(
      errRespond.mock.calls[0],
      "errRespond.mock.calls[0] test invariant",
    );
    expect(errOk).toBe(false);
    expect((err as { code: string }).code).toBe("INVALID_REQUEST");
  });

  it("applies a positive ttlMs and falls back to the default for an invalid one", async () => {
    const r1 = vi.fn();
    await expectDefined(
      attachHandlers["attach.grant"],
      'attachHandlers["attach.grant"] test invariant',
    )({
      params: { sessionKey: "agent:main:ttl", ttlMs: 30_000 },
      respond: r1,
      context: { getRuntimeConfig: () => ({}) },
    } as unknown as GatewayRequestHandlerOptions);
    const now1 = Date.now();
    const b1 = expectDefined(r1.mock.calls[0], "r1.mock.calls[0] test invariant")[1] as {
      expiresAtMs: number;
    };
    expect(b1.expiresAtMs).toBeGreaterThan(now1 + 20_000);
    expect(b1.expiresAtMs).toBeLessThan(now1 + 40_000); // honored 30s ttl, not the 1h default

    const r2 = vi.fn();
    await expectDefined(
      attachHandlers["attach.grant"],
      'attachHandlers["attach.grant"] test invariant',
    )({
      params: { sessionKey: "agent:main:ttl2", ttlMs: -5 },
      respond: r2,
      context: { getRuntimeConfig: () => ({}) },
    } as unknown as GatewayRequestHandlerOptions);
    const b2 = expectDefined(r2.mock.calls[0], "r2.mock.calls[0] test invariant")[1] as {
      expiresAtMs: number;
    };
    expect(b2.expiresAtMs).toBeGreaterThan(Date.now() + 50 * 60_000);
  });

  it("attach.revoke treats non-object params as a missing token (INVALID_REQUEST)", async () => {
    const respond = vi.fn();
    await expectDefined(
      attachHandlers["attach.revoke"],
      'attachHandlers["attach.revoke"] test invariant',
    )({
      params: null,
      respond,
    } as unknown as GatewayRequestHandlerOptions);
    const [ok, , err] = expectDefined(
      respond.mock.calls[0],
      "respond.mock.calls[0] test invariant",
    );
    expect(ok).toBe(false);
    expect((err as { code: string }).code).toBe("INVALID_REQUEST");
  });
});
