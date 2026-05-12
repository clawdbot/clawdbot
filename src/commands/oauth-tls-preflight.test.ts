import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  formatOpenAIOAuthTlsPreflightFix,
  runOpenAIOAuthTlsPreflight,
} from "./oauth-tls-preflight.js";

describe("runOpenAIOAuthTlsPreflight", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  it("returns ok when OpenAI auth endpoint is reachable", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("", { status: 400 }),
    ) as unknown as typeof fetch;
    const result = await runOpenAIOAuthTlsPreflight({ fetchImpl, timeoutMs: 20 });
    expect(result).toEqual({ ok: true });
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
    vi.stubEnv("HOMEBREW_PREFIX", "");
    const text = formatOpenAIOAuthTlsPreflightFix({
      ok: false,
      kind: "tls-cert",
      code: "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
      message: "unable to get local issuer certificate",
    });
    expect(text).toBe(
      [
        "OpenAI OAuth prerequisites check failed: Node/OpenSSL cannot validate TLS certificates.",
        "Cause: UNABLE_TO_GET_ISSUER_CERT_LOCALLY (unable to get local issuer certificate)",
        "",
        "Fix (Homebrew Node/OpenSSL):",
        "- brew postinstall ca-certificates",
        "- brew postinstall openssl@3",
        "- Retry the OAuth login flow.",
      ].join("\n"),
    );
  });
});
