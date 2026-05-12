import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  buildHostnameAllowlistPolicyFromSuffixAllowlist: vi.fn((hosts: string[]) => ({
    hostnameAllowlist: hosts,
  })),
  fetchWithSsrFGuard: vi.fn(),
  gaxiosCtor: vi.fn(
    function MockGaxios(
      this: {
        defaults: Record<string, unknown>;
        interceptors: {
          request: { add: ReturnType<typeof vi.fn> };
          response: { add: ReturnType<typeof vi.fn> };
        };
      },
      defaults,
    ) {
      this.defaults = defaults as Record<string, unknown>;
      this.interceptors = {
        request: { add: vi.fn() },
        response: { add: vi.fn() },
      };
    },
  ),
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  buildHostnameAllowlistPolicyFromSuffixAllowlist:
    mocks.buildHostnameAllowlistPolicyFromSuffixAllowlist,
  fetchWithSsrFGuard: mocks.fetchWithSsrFGuard,
}));

vi.mock("gaxios", () => ({
  Gaxios: mocks.gaxiosCtor,
}));

let __testing: typeof import("./google-auth.runtime.js").__testing;
let createGoogleAuthFetch: typeof import("./google-auth.runtime.js").createGoogleAuthFetch;
let getGoogleAuthTransport: typeof import("./google-auth.runtime.js").getGoogleAuthTransport;
let resolveValidatedGoogleChatCredentials: typeof import("./google-auth.runtime.js").resolveValidatedGoogleChatCredentials;

beforeAll(async () => {
  ({
    __testing,
    createGoogleAuthFetch,
    getGoogleAuthTransport,
    resolveValidatedGoogleChatCredentials,
  } = await import("./google-auth.runtime.js"));
});

beforeEach(() => {
  __testing.resetGoogleAuthRuntimeForTests();
  mocks.buildHostnameAllowlistPolicyFromSuffixAllowlist.mockClear();
  mocks.fetchWithSsrFGuard.mockReset();
  mocks.gaxiosCtor.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

afterAll(() => {
  vi.doUnmock("openclaw/plugin-sdk/ssrf-runtime");
  vi.doUnmock("gaxios");
  vi.resetModules();
});

describe("googlechat google auth runtime", () => {
  it("routes Google auth fetches through the SSRF guard and preserves explicit proxy mTLS", async () => {
    const release = vi.fn();
    const injectedFetch = vi.fn(globalThis.fetch);
    mocks.fetchWithSsrFGuard.mockResolvedValueOnce({
      response: new Response("ok", { status: 200 }),
      release,
    });

    const guardedFetch = createGoogleAuthFetch(injectedFetch);
    const response = await guardedFetch("https://oauth2.googleapis.com/token", {
      agent: { proxy: new URL("http://proxy.example:8080") },
      cert: "CLIENT_CERT",
      headers: { "content-type": "application/json" },
      key: "CLIENT_KEY",
      method: "POST",
      proxy: "http://proxy.example:8080",
    } as RequestInit);

    expect(mocks.fetchWithSsrFGuard).toHaveBeenCalledWith({
      auditContext: "googlechat.auth.google-auth",
      dispatcherPolicy: {
        allowPrivateProxy: true,
        mode: "explicit-proxy",
        proxyTls: {
          cert: "CLIENT_CERT",
          key: "CLIENT_KEY",
        },
        proxyUrl: "http://proxy.example:8080",
      },
      fetchImpl: injectedFetch,
      init: {
        headers: { "content-type": "application/json" },
        method: "POST",
      },
      policy: {
        hostnameAllowlist: ["accounts.google.com", "googleapis.com"],
      },
      url: "https://oauth2.googleapis.com/token",
    });
    await expect(response.text()).resolves.toBe("ok");
    expect(release).toHaveBeenCalledOnce();
  });

  it("lets the guard resolve the ambient runtime fetch when no override is injected", async () => {
    const release = vi.fn();
    mocks.fetchWithSsrFGuard.mockResolvedValueOnce({
      response: new Response("ok", { status: 200 }),
      release,
    });

    const guardedFetch = createGoogleAuthFetch();
    await guardedFetch("https://oauth2.googleapis.com/token", {
      method: "POST",
    } as RequestInit);

    expect(mocks.fetchWithSsrFGuard.mock.calls[0]?.[0]).not.toHaveProperty("fetchImpl");
    expect(release).toHaveBeenCalledOnce();
  });

  it("keeps using the guard-selected runtime fetch even if global fetch changes later", async () => {
    const release = vi.fn();
    const originalFetch = globalThis.fetch;
    mocks.fetchWithSsrFGuard.mockResolvedValueOnce({
      response: new Response("ok", { status: 200 }),
      release,
    });

    const guardedFetch = createGoogleAuthFetch();
    (globalThis as Record<string, unknown>).fetch = vi.fn(async () => new Response("patched"));

    try {
      await guardedFetch("https://oauth2.googleapis.com/token", {
        method: "POST",
      } as RequestInit);
    } finally {
      (globalThis as Record<string, unknown>).fetch = originalFetch;
    }

    expect(mocks.fetchWithSsrFGuard.mock.calls[0]?.[0]).not.toHaveProperty("fetchImpl");
    expect(release).toHaveBeenCalledOnce();
  });

  it("bypasses explicit proxy when noProxy excludes the Google auth host", async () => {
    const release = vi.fn();
    mocks.fetchWithSsrFGuard.mockResolvedValueOnce({
      response: new Response("ok", { status: 200 }),
      release,
    });

    const guardedFetch = createGoogleAuthFetch();
    const response = await guardedFetch("https://oauth2.googleapis.com/token", {
      cert: "CLIENT_CERT",
      key: "CLIENT_KEY",
      method: "POST",
      noProxy: ["oauth2.googleapis.com"],
      proxy: "http://proxy.example:8080",
    } as RequestInit);

    expect(mocks.fetchWithSsrFGuard).toHaveBeenCalledWith({
      auditContext: "googlechat.auth.google-auth",
      dispatcherPolicy: {
        connect: {
          cert: "CLIENT_CERT",
          key: "CLIENT_KEY",
        },
        mode: "direct",
      },
      init: {
        method: "POST",
      },
      policy: {
        hostnameAllowlist: ["accounts.google.com", "googleapis.com"],
      },
      url: "https://oauth2.googleapis.com/token",
    });
    await expect(response.text()).resolves.toBe("ok");
    expect(release).toHaveBeenCalledOnce();
  });

  it("preserves env-proxy transport when HTTPS proxy is configured", async () => {
    const release = vi.fn();
    mocks.fetchWithSsrFGuard.mockResolvedValueOnce({
      response: new Response("ok", { status: 200 }),
      release,
    });
    vi.stubEnv("HTTPS_PROXY", "http://env-proxy.example:8080");
    vi.stubEnv("https_proxy", "http://lower-proxy.example:8080");

    const guardedFetch = createGoogleAuthFetch();
    const response = await guardedFetch("https://oauth2.googleapis.com/token", {
      cert: "CLIENT_CERT",
      key: "CLIENT_KEY",
      method: "POST",
    } as RequestInit);

    expect(mocks.fetchWithSsrFGuard).toHaveBeenCalledWith({
      auditContext: "googlechat.auth.google-auth",
      dispatcherPolicy: {
        mode: "env-proxy",
        proxyTls: {
          cert: "CLIENT_CERT",
          key: "CLIENT_KEY",
        },
      },
      init: {
        method: "POST",
      },
      policy: {
        hostnameAllowlist: ["accounts.google.com", "googleapis.com"],
      },
      url: "https://oauth2.googleapis.com/token",
    });
    await expect(response.text()).resolves.toBe("ok");
    expect(release).toHaveBeenCalledOnce();
  });

  it("matches gaxios proxy env precedence for Google auth requests", () => {
    vi.stubEnv("HTTP_PROXY", "http://upper-http-proxy.example:8080");
    vi.stubEnv("http_proxy", "http://lower-http-proxy.example:8080");
    vi.stubEnv("HTTPS_PROXY", "http://upper-https-proxy.example:8080");
    vi.stubEnv("https_proxy", "http://lower-https-proxy.example:8080");

    expect(__testing.resolveGoogleAuthEnvProxyUrl("https")).toBe(
      "http://upper-https-proxy.example:8080",
    );
    expect(__testing.resolveGoogleAuthEnvProxyUrl("http")).toBe(
      "http://upper-http-proxy.example:8080",
    );
  });

  it("releases guarded auth fetch resources even when callers do not consume the body", async () => {
    const release = vi.fn();
    mocks.fetchWithSsrFGuard.mockResolvedValueOnce({
      response: new Response("ok", { status: 200 }),
      release,
    });

    const guardedFetch = createGoogleAuthFetch();
    const response = await guardedFetch("https://oauth2.googleapis.com/token", {
      method: "POST",
    } as RequestInit);

    expect(release).toHaveBeenCalledOnce();
    await expect(response.text()).resolves.toBe("ok");
  });

  it("rejects oversized guarded auth responses before buffering them into memory", async () => {
    const release = vi.fn();
    let chunkIndex = 0;
    const chunks = [new Uint8Array(700 * 1024), new Uint8Array(400 * 1024)];
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (chunkIndex < chunks.length) {
          controller.enqueue(chunks[chunkIndex++]);
          return;
        }
        controller.close();
      },
    });
    mocks.fetchWithSsrFGuard.mockResolvedValueOnce({
      response: new Response(body, { status: 200 }),
      release,
    });

    const guardedFetch = createGoogleAuthFetch();

    await expect(
      guardedFetch("https://oauth2.googleapis.com/token", {
        method: "POST",
      } as RequestInit),
    ).rejects.toThrow("Google auth response exceeds 1048576 bytes.");
    expect(release).toHaveBeenCalledOnce();
  });

  it("rejects non-stream guarded auth responses instead of buffering them unbounded", async () => {
    const release = vi.fn();
    const arrayBuffer = vi.fn(async () => new ArrayBuffer(16));
    mocks.fetchWithSsrFGuard.mockResolvedValueOnce({
      response: {
        arrayBuffer,
        body: null,
        headers: new Headers(),
        status: 200,
        statusText: "OK",
      } as unknown as Response,
      release,
    });

    const guardedFetch = createGoogleAuthFetch();

    await expect(
      guardedFetch("https://oauth2.googleapis.com/token", {
        method: "POST",
      } as RequestInit),
    ).rejects.toThrow(
      "Google auth response body stream unavailable; refusing to buffer unbounded response.",
    );
    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
  });

  it("rejects oversized auth responses from content-length before reading the body", async () => {
    const release = vi.fn();
    const arrayBuffer = vi.fn(async () => new ArrayBuffer(16));
    mocks.fetchWithSsrFGuard.mockResolvedValueOnce({
      response: {
        arrayBuffer,
        body: null,
        headers: new Headers({
          "content-length": String(2 * 1024 * 1024),
        }),
        status: 200,
        statusText: "OK",
      } as unknown as Response,
      release,
    });

    const guardedFetch = createGoogleAuthFetch();

    await expect(
      guardedFetch("https://oauth2.googleapis.com/token", {
        method: "POST",
      } as RequestInit),
    ).rejects.toThrow("Google auth response exceeds 1048576 bytes.");
    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
  });

  it("builds a scoped Gaxios transport without mutating global window", async () => {
    const originalWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
    Reflect.deleteProperty(globalThis as object, "window");
    try {
      const transport = await getGoogleAuthTransport();
      const transportDefaults = transport.defaults as { fetchImplementation?: unknown };
      const requestInterceptorAdd = transport.interceptors.request.add as unknown as ReturnType<
        typeof vi.fn
      >;
      const responseInterceptorAdd = transport.interceptors.response.add as unknown as ReturnType<
        typeof vi.fn
      >;
      const requestInterceptor = requestInterceptorAdd.mock.calls[0]?.[0] as
        | { resolved?: unknown }
        | undefined;
      const responseInterceptor = responseInterceptorAdd.mock.calls[0]?.[0] as
        | { resolved?: unknown }
        | undefined;

      expect(mocks.gaxiosCtor).toHaveBeenCalledOnce();
      expect(typeof transportDefaults.fetchImplementation).toBe("function");
      expect(requestInterceptorAdd).toHaveBeenCalledOnce();
      expect(typeof requestInterceptor?.resolved).toBe("function");
      expect(responseInterceptorAdd).toHaveBeenCalledOnce();
      expect(typeof responseInterceptor?.resolved).toBe("function");
      expect("window" in globalThis).toBe(false);
    } finally {
      if (originalWindowDescriptor) {
        Object.defineProperty(globalThis, "window", originalWindowDescriptor);
      }
    }
  });

  it("keeps auth transports isolated from google-auth interceptor mutations", async () => {
    const first = await getGoogleAuthTransport();
    const second = await getGoogleAuthTransport();

    expect(first).not.toBe(second);
    expect(mocks.gaxiosCtor).toHaveBeenCalledTimes(2);
    expect(first.interceptors.request.add).toHaveBeenCalledOnce();
    expect(first.interceptors.response.add).toHaveBeenCalledOnce();
    expect(second.interceptors.request.add).toHaveBeenCalledOnce();
    expect(second.interceptors.response.add).toHaveBeenCalledOnce();
  });

  it("normalizes Google auth request headers before upstream interceptors run", () => {
    const config = {
      headers: { "x-test": "1" },
      url: new URL("https://www.googleapis.com/oauth2/v1/certs"),
    };

    const normalized = __testing.normalizeGoogleAuthPreparedRequestHeaders(config);

    expect(normalized.headers).toBeInstanceOf(Headers);
    expect(normalized.headers.has("x-test")).toBe(true);
    expect(normalized.headers.get("x-test")).toBe("1");
  });

  it("normalizes Google auth response headers before upstream cache-control reads", () => {
    const response = {
      data: {},
      headers: {
        "cache-control": "public, max-age=3600",
      },
    };

    const normalized = __testing.normalizeGoogleAuthResponseHeaders(response);

    expect(normalized.headers).toBeInstanceOf(Headers);
    expect(normalized.headers.get("cache-control")).toBe("public, max-age=3600");
  });

  it("rejects service-account credentials that override Google auth endpoints", async () => {
    await expect(
      resolveValidatedGoogleChatCredentials({
        accountId: "default",
        config: {},
        credentialSource: "inline",
        credentials: {
          client_email: "bot@example.iam.gserviceaccount.com",
          private_key: "key",
          token_uri: "https://evil.example/token",
          type: "service_account",
        },
        enabled: true,
      }),
    ).rejects.toThrow(/token_uri/);
  });

  it("reads and validates service-account files before passing them to google-auth", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "googlechat-auth-"));
    try {
      const credentialsPath = path.join(tempDir, "service-account.json");
      await fs.writeFile(
        credentialsPath,
        JSON.stringify({
          auth_provider_x509_cert_url: "https://www.googleapis.com/oauth2/v1/certs",
          auth_uri: "https://accounts.google.com/o/oauth2/auth",
          client_email: "bot@example.iam.gserviceaccount.com",
          private_key: "key",
          token_uri: "https://oauth2.googleapis.com/token",
          type: "service_account",
          universe_domain: "googleapis.com",
        }),
        "utf8",
      );

      const credentials = await resolveValidatedGoogleChatCredentials({
        accountId: "default",
        config: {},
        credentialSource: "file",
        credentialsFile: credentialsPath,
        enabled: true,
      });
      if (!credentials) {
        throw new Error("expected validated credentials");
      }
      expect(credentials.client_email).toBe("bot@example.iam.gserviceaccount.com");
      expect(credentials.token_uri).toBe("https://oauth2.googleapis.com/token");
      expect(credentials.type).toBe("service_account");
    } finally {
      await fs.rm(tempDir, { force: true, recursive: true });
    }
  });

  it("accepts symlinked service-account files used by secret mounts", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "googlechat-auth-link-"));
    try {
      const credentialsPath = path.join(tempDir, "service-account.json");
      const symlinkPath = path.join(tempDir, "service-account-link.json");
      await fs.writeFile(
        credentialsPath,
        JSON.stringify({
          auth_provider_x509_cert_url: "https://www.googleapis.com/oauth2/v1/certs",
          auth_uri: "https://accounts.google.com/o/oauth2/auth",
          client_email: "bot@example.iam.gserviceaccount.com",
          private_key: "key",
          token_uri: "https://oauth2.googleapis.com/token",
          type: "service_account",
          universe_domain: "googleapis.com",
        }),
        "utf8",
      );
      try {
        await fs.symlink(credentialsPath, symlinkPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EPERM") {
          return;
        }
        throw error;
      }

      const credentials = await resolveValidatedGoogleChatCredentials({
        accountId: "default",
        config: {},
        credentialSource: "file",
        credentialsFile: symlinkPath,
        enabled: true,
      });
      if (!credentials) {
        throw new Error("expected validated credentials");
      }
      expect(credentials.client_email).toBe("bot@example.iam.gserviceaccount.com");
      expect(credentials.token_uri).toBe("https://oauth2.googleapis.com/token");
      expect(credentials.type).toBe("service_account");
    } finally {
      await fs.rm(tempDir, { force: true, recursive: true });
    }
  });

  it("does not disclose raw credential paths or OS errors when file reads fail", async () => {
    const missingPath = path.join(os.tmpdir(), "googlechat-auth-missing", "service-account.json");

    let thrown: unknown;
    try {
      await resolveValidatedGoogleChatCredentials({
        accountId: "default",
        config: {},
        credentialSource: "file",
        credentialsFile: missingPath,
        enabled: true,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe("Failed to load Google Chat service account file.");
    expect((thrown as Error).message).not.toMatch(
      /ENOENT|service-account\.json|googlechat-auth-missing/,
    );
  });
});
