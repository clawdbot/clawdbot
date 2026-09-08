import { execFile } from "node:child_process";
import { X509Certificate } from "node:crypto";
import fs from "node:fs/promises";
import { createServer } from "node:https";
import path from "node:path";
import type { PeerCertificate } from "node:tls";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TEST_TLS_CERT_PEM, TEST_TLS_KEY_PEM } from "../../test/helpers/tls-fixture.js";
import type { fetchConfiguredLocalOriginWithSsrFGuard } from "../infra/net/fetch-guard.js";
import { resolveSystemBin } from "../infra/resolve-system-bin.js";
import { createTrackedTempDirs } from "../test-utils/tracked-temp-dirs.js";
import { resolveControlUiHandoffTarget, waitForControlUiDocument } from "./control-ui-handoff.js";

const documentUrl = "http://127.0.0.1:18789/dashboard/";
const tempDirs = createTrackedTempDirs();
const openssl = resolveSystemBin("openssl");
afterEach(async () => {
  vi.restoreAllMocks();
  await tempDirs.cleanup();
});
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
  const ambientPassword = ["ambient", "password"].join("-");

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
    expect(target.dashboardUrl).toBe(`${documentUrl}#token=shared-test-token`);
  });

  it.each([
    ["blocks implicit token failure", undefined, undefined, "password", undefined],
    ["blocks explicit token failure", "token", undefined, "token", undefined],
    ["ignores inactive token refs", "password", undefined, "password", ambientPassword],
  ] as const)(
    "%s",
    async (_label, configuredMode, configuredPassword, expectedMode, expectedHandoff) => {
      const target = await resolveControlUiHandoffTarget({
        config: {
          gateway: {
            auth: {
              ...(configuredMode ? { mode: configuredMode } : {}),
              token: { source: "env", provider: "default", id: "MISSING_GATEWAY_TOKEN" },
              ...(configuredPassword ? { password: configuredPassword } : {}),
            },
          },
        },
        env: {
          OPENCLAW_GATEWAY_TOKEN: "ambient-token",
          OPENCLAW_GATEWAY_PASSWORD: ambientPassword,
        },
      });

      expect(target.authMode).toBe(expectedMode);
      expect(target.gatewayAuthHandoff).toBe(expectedHandoff);
      expect(target.includeTokenInUrl).toBe(false);
      expect(target.dashboardUrl).not.toContain("ambient-token");
    },
  );
});

describe("waitForControlUiDocument", () => {
  it.runIf(openssl)(
    "verifies a CA-signed HTTPS leaf without the issuer or private key and rejects a replacement",
    async () => {
      const root = await tempDirs.make("openclaw-tls-owner-https-");
      const certPath = path.join(root, "leaf.pem");
      const keyPath = path.join(root, "signer.key");
      const caPath = path.join(root, "signer.pem");
      const csrPath = path.join(root, "leaf.csr");
      await fs.writeFile(keyPath, TEST_TLS_KEY_PEM, { mode: 0o600 });
      await fs.writeFile(caPath, TEST_TLS_CERT_PEM);
      const run = promisify(execFile);
      await run(
        openssl!,
        ["req", "-new", "-key", keyPath, "-subj", "/CN=gateway.test", "-out", csrPath],
        { timeout: 10_000 },
      );
      await run(
        openssl!,
        [
          "x509",
          "-req",
          "-in",
          csrPath,
          "-CA",
          caPath,
          "-CAkey",
          keyPath,
          "-set_serial",
          "2",
          "-days",
          "1",
          "-out",
          certPath,
        ],
        { timeout: 10_000 },
      );
      const cert = await fs.readFile(certPath, "utf8");
      await fs.unlink(keyPath);
      await fs.unlink(caPath);
      let requests = 0;
      const server = createServer({ cert, key: TEST_TLS_KEY_PEM }, (_request, response) => {
        requests++;
        response.writeHead(200, { "content-type": "text/html" });
        response.end();
      });
      await new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", resolve);
      });
      try {
        const address = server.address();
        if (!address || typeof address === "string") {
          throw new Error("expected a test HTTPS port");
        }
        const options = {
          url: `https://127.0.0.1:${address.port}/dashboard/`,
          tlsConfig: { enabled: true, certPath, keyPath, caPath },
        };
        await expect(waitForControlUiDocument(options)).resolves.toMatchObject({ ready: true });
        expect(requests).toBe(1);
        server.closeAllConnections();
        server.setSecureContext({ cert: TEST_TLS_CERT_PEM, key: TEST_TLS_KEY_PEM });
        await expect(waitForControlUiDocument(options)).resolves.toMatchObject({ ready: false });
        expect(requests).toBe(1);
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      }
    },
  );

  it("can inspect dashboard TLS using only the public certificate", async () => {
    const root = await tempDirs.make("openclaw-tls-owner-dashboard-");
    const certPath = path.join(root, "cert.pem");
    await fs.writeFile(certPath, TEST_TLS_CERT_PEM);
    const read = vi.spyOn(fs, "readFile");
    const fetch = vi.fn(async () => htmlHead());

    const result = await waitForControlUiDocument({
      url: "https://127.0.0.1:32123/dashboard/",
      tlsConfig: {
        enabled: true,
        certPath,
        keyPath: path.join(root, "absent-key.pem"),
        caPath: path.join(root, "absent-ca.pem"),
      },
      deps: { fetch },
    });

    expect(result.ready).toBe(true);
    expect(read.mock.calls.map(([file]) => file)).toEqual([certPath]);
    expect(fetch).toHaveBeenCalledOnce();
    await expect(fs.readdir(root)).resolves.toEqual(["cert.pem"]);
  });

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

  it("trusts the public certificate and rejects a different peer without reading a server CA", async () => {
    const root = await tempDirs.make("openclaw-tls-owner-dashboard-");
    const certPath = path.join(root, "cert.pem");
    await fs.writeFile(certPath, TEST_TLS_CERT_PEM);
    const fingerprint = new X509Certificate(TEST_TLS_CERT_PEM).fingerprint256
      .replaceAll(":", "")
      .toLowerCase();
    const fetch = vi.fn(async (_request: GuardedDocumentRequest) => htmlHead());

    await expect(
      waitForControlUiDocument({
        url: "https://127.0.0.1:32123/dashboard/",
        tlsConfig: { enabled: true, certPath, caPath: path.join(root, "absent-ca.pem") },
        deps: { fetch },
      }),
    ).resolves.toEqual({ ready: true, tlsFingerprint: fingerprint });

    const [request] = fetch.mock.calls[0] ?? [];
    if (!request) {
      throw new Error("expected dashboard TLS request");
    }
    const connect = requireDirectTlsConnect(request);
    expect(connect.ca).toBe(TEST_TLS_CERT_PEM);
    expect(connect).not.toHaveProperty("rejectUnauthorized");
    const check = connect.checkServerIdentity as (
      hostname: string,
      certificate: PeerCertificate,
    ) => Error | undefined;
    expect(check("127.0.0.1", { fingerprint256: fingerprint } as PeerCertificate)).toBeUndefined();
    expect(check("127.0.0.1", { fingerprint256: "cd".repeat(32) } as PeerCertificate)).toEqual(
      new Error("Gateway TLS certificate fingerprint mismatch."),
    );
    fetch.mockImplementation(async () => {
      const mismatch = check("127.0.0.1", { fingerprint256: "cd".repeat(32) } as PeerCertificate);
      if (mismatch) {
        throw mismatch;
      }
      return htmlHead();
    });
    await expect(
      waitForControlUiDocument({
        url: "https://127.0.0.1:32123/dashboard/",
        tlsConfig: { enabled: true, certPath },
        deps: { fetch },
      }),
    ).resolves.toEqual({
      ready: false,
      reason: "Control UI dashboard is unavailable: Gateway TLS certificate fingerprint mismatch.",
    });
  });
});
