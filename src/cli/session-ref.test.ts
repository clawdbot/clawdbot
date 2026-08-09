import { beforeEach, describe, expect, it, vi } from "vitest";
import { GatewayStoredDeviceAuthUnavailableError } from "../gateway/call.js";
import { GatewayClientRequestError } from "../gateway/client.js";

const callGatewayMock = vi.hoisted(() => vi.fn());

vi.mock("../gateway/call.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../gateway/call.js")>();
  return { ...actual, callGateway: callGatewayMock };
});

import {
  isSessionUrlInputCandidate,
  parseBareSessionTuiOptions,
  parseSessionTargetInput,
  SessionTargetParseError,
} from "./session-ref.js";
import { resolveSessionTarget } from "./session-target.js";

describe("session target parsing", () => {
  beforeEach(() => {
    callGatewayMock.mockReset();
    delete process.env.OPENCLAW_ALLOW_INSECURE_PRIVATE_WS;
  });

  it.each([
    {
      input: "https://Gateway.Example/dashboard/Ops/",
      expected: {
        kind: "url",
        origin: "wss://gateway.example",
        basePath: "",
        agentId: "ops",
        ref: { kind: "main" },
      },
    },
    {
      input: "https://Gateway.Example/base/dashboard/Ops/movies-A1166B81/",
      expected: {
        kind: "url",
        origin: "wss://gateway.example",
        basePath: "/base",
        agentId: "ops",
        ref: { kind: "short", shortId: "a1166b81", slugHint: "movies" },
      },
    },
    {
      input: "wss://gateway.example/base/chat/ops/telegram/123?view=compact#messages",
      expected: {
        kind: "url",
        origin: "wss://gateway.example",
        basePath: "/base",
        agentId: "ops",
        ref: { kind: "literal", sessionKey: "agent:ops:telegram:123" },
      },
    },
    {
      input: "https://gateway.example/tenant/chat/dashboard/ops/movies-a1166b81",
      expected: {
        kind: "url",
        origin: "wss://gateway.example",
        basePath: "/tenant/chat",
        agentId: "ops",
        ref: { kind: "short", shortId: "a1166b81", slugHint: "movies" },
      },
    },
    {
      input: "wss://gateway.example/dashboard/ops/~key/release-deadbeef",
      expected: {
        kind: "url",
        origin: "wss://gateway.example",
        basePath: "",
        agentId: "ops",
        ref: { kind: "literal", sessionKey: "agent:ops:release-deadbeef" },
      },
    },
    {
      input: "Gateway.Example/Ops/movies-A1166B81/",
      expected: {
        kind: "url",
        origin: "wss://gateway.example",
        basePath: "",
        agentId: "ops",
        ref: { kind: "short", shortId: "a1166b81", slugHint: "movies" },
      },
    },
    {
      input: "MOVIES-A1166B81",
      expected: {
        kind: "ref",
        ref: { kind: "short", shortId: "a1166b81", slugHint: "MOVIES" },
      },
    },
    {
      input: "A1166B81",
      expected: { kind: "ref", ref: { kind: "short", shortId: "a1166b81" } },
    },
    {
      input: "AGENT:Ops:Telegram:123",
      expected: {
        kind: "ref",
        ref: { kind: "literal", sessionKey: "agent:ops:telegram:123" },
      },
    },
  ])("parses $input", ({ input, expected }) => {
    expect(parseSessionTargetInput(input)).toEqual(expected);
  });

  it.each([
    "",
    "not-a-session",
    "deadbee",
    "1234567890abcdef1234567890abcdef0",
    "main",
    "https://gateway.example/dashboard",
    "https://gateway.example/DASHBOARD/main/deadbeef",
    "https://gateway.example/dashboard/main/%zz",
    "ftp://gateway.example/dashboard/main/deadbeef",
    "gateway.example/main",
  ])("rejects %j with the typed accepted-forms error", (input) => {
    expect(() => parseSessionTargetInput(input)).toThrow(SessionTargetParseError);
    expect(() => parseSessionTargetInput(input)).toThrow("Accepted session targets:");
  });

  it("rejects credentials without echoing them", () => {
    const secret = "do-not-print-me";
    let error: unknown;
    try {
      parseSessionTargetInput(
        `https://user:${secret}@gateway.example/dashboard/main/movies-a1166b81`,
      );
    } catch (caught) {
      error = caught;
    }
    expect(String(error)).toContain("must not contain credentials");
    expect(String(error)).not.toContain(secret);
  });

  it("rejects credential query and fragment parameters without echoing them", () => {
    for (const suffix of ["?token=do-not-print-me", "#password=do-not-print-me"]) {
      let error: unknown;
      try {
        parseSessionTargetInput(`https://gateway.example/dashboard/main/movies-a1166b81${suffix}`);
      } catch (caught) {
        error = caught;
      }
      expect(String(error)).toContain("must not contain credentials");
      expect(String(error)).not.toContain("do-not-print-me");
    }
  });

  it("surfaces the canonical plaintext WebSocket security gate", () => {
    expect(() =>
      parseSessionTargetInput("ws://gateway.example/dashboard/main/movies-a1166b81"),
    ).toThrow("SECURITY ERROR: Gateway URL");
  });
});

describe("bare-root session URL options", () => {
  const target = "https://gateway.example/dashboard/main/movies-a1166b81";

  it("recognizes trimmed URL candidates without claiming bare refs", () => {
    expect(isSessionUrlInputCandidate(`  ${target}  `)).toBe(true);
    expect(isSessionUrlInputCandidate("movies-a1166b81")).toBe(false);
  });

  it("parses the direct TUI option subset after the URL", () => {
    expect(
      parseBareSessionTuiOptions(
        [
          "node",
          "openclaw",
          "--no-color",
          target,
          "--token",
          "direct-token",
          "--password=direct-password",
          "--tls-fingerprint",
          "sha256:direct",
          "--deliver",
          "--message",
          "continue here",
        ],
        target,
      ),
    ).toEqual({
      token: "direct-token",
      password: "direct-password",
      tlsFingerprint: "sha256:direct",
      deliver: true,
      message: "continue here",
    });
  });

  it("rejects unsupported options without echoing their values", () => {
    const secret = "do-not-print-me";
    let error: unknown;
    try {
      parseBareSessionTuiOptions(["node", "openclaw", target, `--typo=${secret}`], target);
    } catch (caught) {
      error = caught;
    }
    expect(String(error)).toContain("Unsupported bare session URL option: --typo");
    expect(String(error)).not.toContain(secret);
  });

  it.each([
    ["option terminator", ["--", "ignored"], "Unsupported bare session URL option: --"],
    ["trailing positional", ["ignored"], "Unsupported bare session URL option: ignored"],
    ["conflicting session", ["--session", "agent:main:other"], "--session"],
  ])("rejects %s", (_label, suffix, expected) => {
    expect(() =>
      parseBareSessionTuiOptions(["node", "openclaw", target, ...suffix], target),
    ).toThrow(expected);
  });
});

describe("session target resolution", () => {
  beforeEach(() => {
    callGatewayMock.mockReset();
  });

  it("resolves a URL short reference on its exact gateway and agent", async () => {
    callGatewayMock.mockResolvedValue({ ok: true, key: "agent:ops:thread:full-key" });

    const result = await resolveSessionTarget({
      raw: "https://gateway.example/base/dashboard/ops/movies-a1166b81",
      gateway: { token: "explicit-token" },
    });

    expect(result.sessionKey).toBe("agent:ops:thread:full-key");
    expect(callGatewayMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "wss://gateway.example/base",
        token: "explicit-token",
        method: "sessions.resolve",
        params: { shortId: "a1166b81", slugHint: "movies", agentId: "ops" },
        useStoredDeviceAuth: true,
        requiredStoredDeviceAuthScopes: ["operator.read"],
      }),
    );
  });

  it("resolves a bare literal key without forcing an explicit gateway", async () => {
    callGatewayMock.mockResolvedValue({ ok: true, key: "agent:ops:telegram:123" });

    await resolveSessionTarget({ raw: "agent:ops:telegram:123" });

    expect(callGatewayMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: undefined,
        method: "sessions.resolve",
        params: { key: "agent:ops:telegram:123" },
      }),
    );
    expect(callGatewayMock.mock.calls[0]?.[0]).not.toHaveProperty("useStoredDeviceAuth");
  });

  it("probes URL main sessions once without requiring an existing row", async () => {
    callGatewayMock.mockResolvedValue({ ok: true });

    const result = await resolveSessionTarget({
      raw: "https://gateway.example/dashboard/ops",
    });

    expect(result.sessionKey).toBe("agent:ops:main");
    expect(callGatewayMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "wss://gateway.example",
        method: "status",
        params: {},
        requiredStoredDeviceAuthScopes: ["operator.read"],
      }),
    );
  });

  it("rejects a second explicit URL", async () => {
    await expect(
      resolveSessionTarget({
        raw: "https://gateway.example/dashboard/main/movies-a1166b81",
        gateway: { url: "wss://other.example" },
      }),
    ).rejects.toThrow("pass one target");
    expect(callGatewayMock).not.toHaveBeenCalled();
  });

  it("prints bounded ambiguity candidates without listing or describing", async () => {
    callGatewayMock.mockResolvedValue({
      ok: false,
      candidates: [
        {
          key: "agent:main:thread:12345678-0aaa-4000-8000-000000000001",
          displayName: "Alpha",
        },
        {
          key: "agent:main:thread:12345678-0bbb-4000-8000-000000000002",
          displayName: "Beta",
        },
      ],
    });

    await expect(resolveSessionTarget({ raw: "12345678" })).rejects.toThrow(
      /Alpha\s+123456780aaa4000[\s\S]*Beta\s+123456780bbb4000/u,
    );
    expect(callGatewayMock).toHaveBeenCalledTimes(1);
  });

  it("reports old gateways without falling back to sessions.list", async () => {
    callGatewayMock.mockRejectedValue(
      new GatewayClientRequestError({
        code: "INVALID_REQUEST",
        message: "invalid sessions.resolve params: at root: unexpected property 'shortId'",
      }),
    );

    await expect(
      resolveSessionTarget({
        raw: "movies-a1166b81",
        gateway: { url: "wss://gateway.example" },
      }),
    ).rejects.toThrow(
      "This gateway predates short-link resolution; pass the full session key. Choose a full session key from that gateway's Control UI (https://gateway.example).",
    );
    expect(callGatewayMock).toHaveBeenCalledTimes(1);
  });

  it("preserves not-found text and adds the sessions list recovery", async () => {
    callGatewayMock.mockRejectedValue(
      new GatewayClientRequestError({
        code: "INVALID_REQUEST",
        message: "No session found: a1166b81",
      }),
    );

    await expect(resolveSessionTarget({ raw: "a1166b81" })).rejects.toThrow(
      /No session found: a1166b81[\s\S]*openclaw sessions list/u,
    );
  });

  it("sends remote not-found recovery to the target Control UI, not the local session store", async () => {
    callGatewayMock.mockRejectedValue(
      new GatewayClientRequestError({
        code: "INVALID_REQUEST",
        message: "No session found: a1166b81",
      }),
    );

    let error: unknown;
    try {
      await resolveSessionTarget({ raw: "gateway.example/main/a1166b81" });
    } catch (caught) {
      error = caught;
    }
    expect(String(error)).toContain("that gateway's Control UI (https://gateway.example)");
    expect(String(error)).not.toContain("sessions list --url");
  });

  it("turns structured pairing and revoked-token failures into actions", async () => {
    callGatewayMock.mockRejectedValueOnce(
      new GatewayClientRequestError({
        code: "INVALID_REQUEST",
        message: "connect failed",
        details: { code: "PAIRING_REQUIRED" },
      }),
    );
    await expect(resolveSessionTarget({ raw: "gateway.example/main/a1166b81" })).rejects.toThrow(
      "Approve the request",
    );

    callGatewayMock.mockRejectedValueOnce(
      new GatewayClientRequestError({
        code: "INVALID_REQUEST",
        message: "connect failed",
        details: { code: "AUTH_DEVICE_TOKEN_MISMATCH" },
      }),
    );
    await expect(resolveSessionTarget({ raw: "gateway.example/main/a1166b81" })).rejects.toThrow(
      "revoked or rotated. Re-pair",
    );
  });

  it("explains how to bootstrap auth when no origin token exists", async () => {
    callGatewayMock.mockRejectedValue(
      new GatewayStoredDeviceAuthUnavailableError("No stored device auth"),
    );

    await expect(resolveSessionTarget({ raw: "gateway.example/main/a1166b81" })).rejects.toThrow(
      "Pass --token or --password once",
    );
  });

  it.each([
    {
      code: "ECONNREFUSED",
      target: "claw.example.ts.net/main/a1166b81",
      expected: /Could not reach gateway wss:\/\/claw\.example\.ts\.net[\s\S]*Tailscale/u,
    },
    {
      code: "ENOTFOUND",
      target: "gateway.example/main/a1166b81",
      expected: /Could not reach gateway wss:\/\/gateway\.example[\s\S]*tailnet or SSH tunnel/u,
    },
  ])("names unreachable origins for $code", async ({ code, target, expected }) => {
    callGatewayMock.mockRejectedValue(Object.assign(new Error(`connect ${code}`), { code }));

    await expect(resolveSessionTarget({ raw: target })).rejects.toThrow(expected);
  });

  it("does not mask TLS fingerprint mismatch errors", async () => {
    const mismatch = new Error("gateway tls fingerprint mismatch");
    callGatewayMock.mockRejectedValue(mismatch);

    await expect(resolveSessionTarget({ raw: "gateway.example/main/a1166b81" })).rejects.toBe(
      mismatch,
    );
  });
});
