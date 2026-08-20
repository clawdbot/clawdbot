import type { PeerCertificate } from "node:tls";
import { describe, expect, it, vi } from "vitest";
import type { fetchConfiguredLocalOriginWithSsrFGuard } from "../infra/net/fetch-guard.js";
import { resolveControlUiHandoffTarget, waitForControlUiDocument } from "./control-ui-handoff.js";

const documentUrl = "http://127.0.0.1:18789/dashboard/";
type GuardedDocumentRequest = Parameters<typeof fetchConfiguredLocalOriginWithSsrFGuard>[0];

function guardedResponse(response: Response) {
  return { response, finalUrl: documentUrl, release: vi.fn(async () => {}) };
}

function htmlHead() {
  return guardedResponse(
    new Response(null, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } }),
  );
}

function requireDirectTlsConnect(request: GuardedDocumentRequest): Record<string, unknown> {
  if (request.dispatcherPolicy?.mode !== "direct" || !request.dispatcherPolicy.connect) {
    throw new Error("expected pinned Gateway TLS options");
  }
  return request.dispatcherPolicy.connect;
}

describe("resolveControlUiHandoffTarget", () => {
  it("keeps plaintext custom browser and exact-base-path document URLs on loopback", async () => {
    const target = await resolveControlUiHandoffTarget({
      config: {
        gateway: {
          bind: "custom",
          customBindHost: "10.0.0.5",
          controlUi: { basePath: "/dashboard" },
          auth: { token: "shared-test-token" },
        },
      },
      env: {},
    });

    expect(target.links.httpUrl).toBe(documentUrl);
    expect(target.documentUrl).toBe(documentUrl);
    expect(target.probeUrl).toBe("ws://10.0.0.5:18789/dashboard");
    expect(target.loopbackAliasHost).toBe("10.0.0.5");
  });
});

describe("waitForControlUiDocument", () => {
  it("probes the exact HTML document without credentials or redirects", async () => {
    const response = htmlHead();
    const fetch = vi.fn(async () => response);

    await expect(waitForControlUiDocument({ url: documentUrl, deps: { fetch } })).resolves.toEqual({
      ready: true,
    });

    expect(fetch).toHaveBeenCalledWith(
      expect.objectContaining({
        url: documentUrl,
        configuredLocalOriginBaseUrl: "http://127.0.0.1:18789",
        policy: { allowedOrigins: ["http://127.0.0.1:18789"] },
        maxRedirects: 0,
        capture: false,
        init: {
          method: "HEAD",
          headers: { Accept: "text/html", "Accept-Encoding": "identity" },
        },
      }),
    );
    expect(response.release).toHaveBeenCalledOnce();
  });

  it("rejects HTTP 200 responses that are not dashboard HTML", async () => {
    const response = guardedResponse(
      new Response(null, { status: 200, headers: { "content-type": "application/json" } }),
    );

    await expect(
      waitForControlUiDocument({ url: documentUrl, deps: { fetch: async () => response } }),
    ).resolves.toEqual({
      ready: false,
      reason: "Control UI dashboard is unavailable (HTTP 200).",
      status: 200,
    });
    expect(response.release).toHaveBeenCalledOnce();
  });

  it("retries only explicitly preparing dashboards before starting the handoff clock", async () => {
    let elapsedMs = 0;
    const preparing = guardedResponse(
      new Response(null, { status: 503, headers: { "retry-after": "1" } }),
    );
    const ready = htmlHead();
    const fetch = vi.fn().mockResolvedValueOnce(preparing).mockResolvedValueOnce(ready);
    const onPending = vi.fn();

    await expect(
      waitForControlUiDocument({
        url: documentUrl,
        onPending,
        deps: {
          fetch,
          now: () => elapsedMs,
          sleep: async (ms) => {
            elapsedMs += ms;
          },
        },
      }),
    ).resolves.toEqual({ ready: true });

    expect(elapsedMs).toBe(1_000);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(onPending).toHaveBeenCalledOnce();
    expect(preparing.release).toHaveBeenCalledOnce();
    expect(ready.release).toHaveBeenCalledOnce();
  });

  it("fails immediately for JSON consumers while assets are preparing", async () => {
    const preparing = guardedResponse(
      new Response(null, { status: 503, headers: { "retry-after": "1" } }),
    );
    const fetch = vi.fn(async () => preparing);
    const onPending = vi.fn();

    await expect(
      waitForControlUiDocument({
        url: documentUrl,
        waitForPending: false,
        onPending,
        deps: { fetch },
      }),
    ).resolves.toEqual({
      ready: false,
      reason: "Control UI assets are still preparing.",
      status: 503,
    });

    expect(fetch).toHaveBeenCalledOnce();
    expect(onPending).not.toHaveBeenCalled();
  });

  it("reads one bounded sanitized diagnostic only for terminal plain-text failures", async () => {
    const head = guardedResponse(new Response(null, { status: 503 }));
    const diagnostic = guardedResponse(
      new Response("Invalid configured root\nRun openclaw doctor --fix", {
        status: 503,
        headers: { "content-type": "text/plain; charset=utf-8" },
      }),
    );
    const fetch = vi.fn().mockResolvedValueOnce(head).mockResolvedValueOnce(diagnostic);

    await expect(waitForControlUiDocument({ url: documentUrl, deps: { fetch } })).resolves.toEqual({
      ready: false,
      reason: "Invalid configured root Run openclaw doctor --fix",
      status: 503,
    });

    expect(fetch.mock.calls.map(([request]) => request.init.method)).toEqual(["HEAD", "GET"]);
    expect(head.release).toHaveBeenCalledOnce();
    expect(diagnostic.release).toHaveBeenCalledOnce();
  });

  it("does not expose HTML when a terminal failure becomes ready during diagnostic fetch", async () => {
    const head = guardedResponse(new Response(null, { status: 503 }));
    const repaired = guardedResponse(
      new Response("<html>private-looking UI content</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
    );
    const fetch = vi.fn().mockResolvedValueOnce(head).mockResolvedValueOnce(repaired);

    await expect(waitForControlUiDocument({ url: documentUrl, deps: { fetch } })).resolves.toEqual({
      ready: false,
      reason: "Control UI dashboard is unavailable (HTTP 503).",
      status: 503,
    });
  });

  it("bounds the independent preparing deadline", async () => {
    let elapsedMs = 0;
    const fetch = vi.fn(async () =>
      guardedResponse(new Response(null, { status: 503, headers: { "retry-after": "1" } })),
    );

    await expect(
      waitForControlUiDocument({
        url: documentUrl,
        timeoutMs: 2_500,
        deps: {
          fetch,
          now: () => elapsedMs,
          sleep: async (ms) => {
            elapsedMs += ms;
          },
        },
      }),
    ).resolves.toEqual({
      ready: false,
      reason: "Control UI assets did not finish preparing in time.",
    });
    expect(elapsedMs).toBe(2_500);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("trusts only the configured Gateway certificate and pins the actual TLS peer", async () => {
    const fingerprint = "ab".repeat(32);
    const loadTls = vi.fn(async () => ({
      enabled: true,
      required: true,
      fingerprintSha256: fingerprint,
      tlsOptions: { cert: "exact-gateway-certificate" },
    }));
    const fetch = vi.fn(async (_request: GuardedDocumentRequest) => htmlHead());

    await expect(
      waitForControlUiDocument({
        url: "https://127.0.0.1:18789/dashboard/",
        tlsConfig: { enabled: true },
        deps: { fetch, loadTls },
      }),
    ).resolves.toEqual({ ready: true, tlsFingerprint: fingerprint });

    expect(loadTls).toHaveBeenCalledWith({ enabled: true, autoGenerate: false });
    const [request] = fetch.mock.calls[0] ?? [];
    if (!request) {
      throw new Error("expected dashboard TLS request");
    }
    const connect = requireDirectTlsConnect(request);
    expect(connect.ca).toBe("exact-gateway-certificate");
    expect(connect).not.toHaveProperty("rejectUnauthorized");
    const check = connect.checkServerIdentity as
      | ((hostname: string, certificate: PeerCertificate) => Error | undefined)
      | undefined;
    expect(
      check?.("127.0.0.1", { fingerprint256: fingerprint } as PeerCertificate),
    ).toBeUndefined();
    expect(check?.("127.0.0.1", { fingerprint256: "cd".repeat(32) } as PeerCertificate)).toEqual(
      new Error("Gateway TLS certificate fingerprint mismatch."),
    );
  });

  it("trusts the served Gateway certificate alongside a distinct client-verification CA", async () => {
    const fingerprint = "ab".repeat(32);
    const loadTls = vi.fn(async () => ({
      enabled: true,
      required: true,
      fingerprintSha256: fingerprint,
      tlsOptions: {
        cert: "exact-gateway-certificate",
        ca: "separate-client-verification-ca",
      },
    }));
    const fetch = vi.fn(async (request: GuardedDocumentRequest) => {
      const connect = requireDirectTlsConnect(request);
      if (!Array.isArray(connect.ca) || !connect.ca.includes("exact-gateway-certificate")) {
        throw new Error("self-signed Gateway certificate is not trusted");
      }
      const check = connect.checkServerIdentity as (
        hostname: string,
        certificate: PeerCertificate,
      ) => Error | undefined;
      const mismatch = check("127.0.0.1", { fingerprint256: fingerprint } as PeerCertificate);
      if (mismatch) {
        throw mismatch;
      }
      return htmlHead();
    });

    await expect(
      waitForControlUiDocument({
        url: "https://127.0.0.1:18789/dashboard/",
        tlsConfig: { enabled: true, caPath: "/gateway/client-verification-ca.pem" },
        deps: { fetch, loadTls },
      }),
    ).resolves.toEqual({ ready: true, tlsFingerprint: fingerprint });

    const [request] = fetch.mock.calls[0] ?? [];
    if (!request) {
      throw new Error("expected dashboard TLS request");
    }
    const connect = requireDirectTlsConnect(request);
    expect(connect.ca).toEqual(["exact-gateway-certificate", "separate-client-verification-ca"]);
    expect(connect).not.toHaveProperty("rejectUnauthorized");
  });

  it("rejects a mismatched TLS certificate before accepting dashboard HTML", async () => {
    const loadTls = vi.fn(async () => ({
      enabled: true,
      required: true,
      fingerprintSha256: "ab".repeat(32),
      tlsOptions: { cert: "exact-gateway-certificate" },
    }));
    const fetch = vi.fn(async (request: GuardedDocumentRequest) => {
      const check = requireDirectTlsConnect(request).checkServerIdentity as (
        hostname: string,
        certificate: PeerCertificate,
      ) => Error | undefined;
      const mismatch = check("127.0.0.1", { fingerprint256: "cd".repeat(32) } as PeerCertificate);
      if (mismatch) {
        throw mismatch;
      }
      return htmlHead();
    });

    await expect(
      waitForControlUiDocument({
        url: "https://127.0.0.1:18789/dashboard/",
        tlsConfig: { enabled: true },
        deps: { fetch, loadTls },
      }),
    ).resolves.toEqual({
      ready: false,
      reason: "Control UI dashboard is unavailable: Gateway TLS certificate fingerprint mismatch.",
    });
  });
});
