// OAuth TLS preflight tests cover timeout handling, TLS diagnostics, and suggested fixes.
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  formatOpenAIOAuthTlsPreflightFix,
  runOpenAIOAuthTlsPreflight,
  shouldRunOpenAIOAuthTlsPrerequisites,
} from "../plugins/provider-openai-chatgpt-oauth-tls.js";
import { withEnv } from "../test-utils/env.js";

describe("runOpenAIOAuthTlsPreflight", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns ok when OpenAI auth endpoint is reachable", async () => {
    const response = new Response("reachable", { status: 400 });
    const cancel = vi.spyOn(response.body!, "cancel").mockResolvedValue(undefined);
    const fetchImpl = vi.fn(async () => response) as unknown as typeof fetch;
    const result = await runOpenAIOAuthTlsPreflight({ fetchImpl, timeoutMs: 20 });
    expect(result).toEqual({ ok: true });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("caps oversized probe timeouts before creating abort signals", async () => {
    const timeoutController = new AbortController();
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeoutController.signal);
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.signal).toBe(timeoutController.signal);
      return new Response("", { status: 400 });
    }) as unknown as typeof fetch;

    const result = await runOpenAIOAuthTlsPreflight({
      fetchImpl,
      timeoutMs: Number.MAX_SAFE_INTEGER,
    });

    expect(result).toEqual({ ok: true });
    expect(timeoutSpy).toHaveBeenCalledWith(MAX_TIMER_TIMEOUT_MS);
  });

  it("classifies TLS trust failures from fetch cause code", async () => {
    const tlsFetchImpl = vi.fn(async () => {
      const cause = new Error("unable to get local issuer certificate") as Error & {
        code?: string;
      };
      cause.code = "UNABLE_TO_GET_ISSUER_CERT_LOCALLY";
      throw new TypeError("fetch failed", { cause });
    }) as unknown as typeof fetch;
    const result = await runOpenAIOAuthTlsPreflight({ fetchImpl: tlsFetchImpl, timeoutMs: 20 });
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected TLS certificate preflight failure");
    }
    expect(result.kind).toBe("tls-cert");
    expect(result.code).toBe("UNABLE_TO_GET_ISSUER_CERT_LOCALLY");
    expect(result.message).toBe("unable to get local issuer certificate");
  });

  it("classifies a deeply wrapped hostname mismatch", async () => {
    const tlsFetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed", {
        cause: {
          cause: {
            code: "ERR_TLS_CERT_ALTNAME_INVALID",
            message: "Hostname/IP does not match certificate's altnames",
          },
        },
      });
    }) as unknown as typeof fetch;
    await expect(
      runOpenAIOAuthTlsPreflight({ fetchImpl: tlsFetchImpl, timeoutMs: 20 }),
    ).resolves.toEqual({
      ok: false,
      kind: "tls-cert",
      code: "ERR_TLS_CERT_ALTNAME_INVALID",
      message: "Hostname/IP does not match certificate's altnames",
    });
  });

  it("keeps generic TLS transport failures in network classification", async () => {
    const networkFetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed", {
        cause: new Error(
          "Client network socket disconnected before secure TLS connection was established",
        ),
      });
    }) as unknown as typeof fetch;
    const result = await runOpenAIOAuthTlsPreflight({
      fetchImpl: networkFetchImpl,
      timeoutMs: 20,
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected network preflight failure");
    }
    expect(result.kind).toBe("network");
  });
});

describe("formatOpenAIOAuthTlsPreflightFix", () => {
  it("includes remediation commands for TLS failures", () => {
    withEnv({ HOMEBREW_PREFIX: "" }, () => {
      const text = formatOpenAIOAuthTlsPreflightFix({
        ok: false,
        kind: "tls-cert",
        code: "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
        message: "unable to get local issuer certificate",
      });
      expect(text).toContain(
        "OpenAI OAuth prerequisites check failed: Node/OpenSSL cannot validate TLS certificates.",
      );
      expect(text).toContain(
        "Cause: UNABLE_TO_GET_ISSUER_CERT_LOCALLY (unable to get local issuer certificate)",
      );
      expect(text).toContain("Fix (Homebrew Node/OpenSSL):");
      expect(text).toContain("- brew postinstall ca-certificates");
      expect(text).toContain("- brew postinstall openssl@3");
      expect(text).toContain("- Retry the OAuth login flow.");
    });
  });
});

describe("shouldRunOpenAIOAuthTlsPrerequisites", () => {
  it("runs for OpenAI OAuth profiles", () => {
    expect(
      shouldRunOpenAIOAuthTlsPrerequisites({
        cfg: {
          auth: {
            profiles: {
              "openai:default": {
                provider: "openai",
                mode: "oauth",
              },
            },
          },
        },
      }),
    ).toBe(true);
  });
});
