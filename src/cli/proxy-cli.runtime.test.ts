import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getRuntimeConfigMock, runProxyValidationMock, serverStopSpy, spawnMock } = vi.hoisted(
  () => ({
    getRuntimeConfigMock: vi.fn(),
    runProxyValidationMock: vi.fn(),
    serverStopSpy: vi.fn(async () => undefined),
    spawnMock: vi.fn(),
  }),
);

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: spawnMock,
  };
});

vi.mock("../proxy-capture/proxy-server.js", () => ({
  startDebugProxyServer: vi.fn(async () => ({
    proxyUrl: "http://127.0.0.1:7799",
    stop: serverStopSpy,
  })),
}));

vi.mock("../config/config.js", () => ({
  getRuntimeConfig: getRuntimeConfigMock,
}));

vi.mock("../infra/net/proxy/proxy-validation.js", () => ({
  runProxyValidation: runProxyValidationMock,
}));

describe("proxy cli runtime", () => {
  const envKeys = [
    "OPENCLAW_DEBUG_PROXY_DB_PATH",
    "OPENCLAW_DEBUG_PROXY_BLOB_DIR",
    "OPENCLAW_DEBUG_PROXY_CERT_DIR",
    "OPENCLAW_DEBUG_PROXY_SESSION_ID",
    "OPENCLAW_DEBUG_PROXY_ENABLED",
    "FORCE_COLOR",
    "NO_COLOR",
  ] as const;
  const savedEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  let tempDir = "";

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), "openclaw-proxy-cli-runtime-"));
    process.env.OPENCLAW_DEBUG_PROXY_DB_PATH = path.join(tempDir, "capture.sqlite");
    process.env.OPENCLAW_DEBUG_PROXY_BLOB_DIR = path.join(tempDir, "blobs");
    process.env.OPENCLAW_DEBUG_PROXY_CERT_DIR = path.join(tempDir, "certs");
    delete process.env.OPENCLAW_DEBUG_PROXY_ENABLED;
    delete process.env.OPENCLAW_DEBUG_PROXY_SESSION_ID;
    delete process.env.FORCE_COLOR;
    process.env.NO_COLOR = "1";
    getRuntimeConfigMock.mockReset();
    getRuntimeConfigMock.mockReturnValue({
      proxy: {
        enabled: true,
        proxyUrl: "http://config-proxy.example:3128",
      },
    });
    runProxyValidationMock.mockReset();
    runProxyValidationMock.mockResolvedValue({
      ok: true,
      config: {
        enabled: true,
        proxyUrl: "http://config-proxy.example:3128",
        source: "config",
        errors: [],
      },
      checks: [
        {
          kind: "allowed",
          url: "https://example.com/",
          ok: true,
          status: 200,
        },
      ],
    });
    process.exitCode = undefined;
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    serverStopSpy.mockClear();
    spawnMock.mockReset();
  });

  afterEach(async () => {
    const { closeDebugProxyCaptureStore } = await import("../proxy-capture/store.sqlite.js");
    closeDebugProxyCaptureStore();
    vi.restoreAllMocks();
    vi.resetModules();
    process.exitCode = undefined;
    for (const key of envKeys) {
      const value = savedEnv[key];
      if (value == null) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("prints proxy validation text and leaves exit code unset on success", async () => {
    const { runProxyValidateCommand } = await import("./proxy-cli.runtime.js");

    await runProxyValidateCommand({
      proxyUrl: "http://override.example:3128",
      allowedUrls: ["https://allowed.example/"],
      deniedUrls: ["http://127.0.0.1/"],
      apnsReachability: true,
      apnsAuthority: "https://api.sandbox.push.apple.com",
      timeoutMs: 1234,
    });

    expect(getRuntimeConfigMock).toHaveBeenCalledOnce();
    expect(runProxyValidationMock).toHaveBeenCalledWith({
      config: {
        enabled: true,
        proxyUrl: "http://config-proxy.example:3128",
      },
      env: process.env,
      proxyUrlOverride: "http://override.example:3128",
      allowedUrls: ["https://allowed.example/"],
      deniedUrls: ["http://127.0.0.1/"],
      apnsReachability: true,
      apnsAuthority: "https://api.sandbox.push.apple.com",
      timeoutMs: 1234,
    });
    expect(process.stdout.write).toHaveBeenCalledWith(
      "Proxy validation passed\n\n" +
        "Proxy\n" +
        "  Source: config\n" +
        "  URL:    http://config-proxy.example:3128/\n\n" +
        "Checks\n" +
        "  ✓ allowed https://example.com/ HTTP 200\n",
    );
    expect(process.exitCode).toBeUndefined();
  });

  it("redacts proxy credentials in text output", async () => {
    runProxyValidationMock.mockResolvedValueOnce({
      ok: true,
      config: {
        enabled: true,
        proxyUrl: "http://user:secret@proxy.example:3128?token=secret#fragment",
        source: "config",
        errors: [],
      },
      checks: [],
    });
    const { runProxyValidateCommand } = await import("./proxy-cli.runtime.js");

    await runProxyValidateCommand({});

    expect(process.stdout.write).toHaveBeenCalledWith(
      "Proxy validation passed\n\n" +
        "Proxy\n" +
        "  Source: config\n" +
        "  URL:    http://redacted:redacted@proxy.example:3128/\n",
    );
  });

  it("redacts proxy credentials in JSON output", async () => {
    runProxyValidationMock.mockResolvedValueOnce({
      ok: true,
      config: {
        enabled: true,
        proxyUrl: "http://user:secret@proxy.example:3128?token=secret#fragment",
        source: "config",
        errors: [],
      },
      checks: [],
    });
    const { runProxyValidateCommand } = await import("./proxy-cli.runtime.js");

    await runProxyValidateCommand({ json: true });

    expect(process.stdout.write).toHaveBeenCalledWith(
      `${JSON.stringify(
        {
          ok: true,
          config: {
            enabled: true,
            proxyUrl: "http://redacted:redacted@proxy.example:3128/",
            source: "config",
            errors: [],
          },
          checks: [],
        },
        null,
        2,
      )}\n`,
    );
  });

  it("prints actionable disabled proxy config output", async () => {
    runProxyValidationMock.mockResolvedValueOnce({
      ok: false,
      config: {
        enabled: false,
        proxyUrl: "http://proxy.example:3128",
        source: "config",
        errors: ["proxy validation requires proxy.enabled to be true for configured proxy URLs"],
      },
      checks: [],
    });
    const { runProxyValidateCommand } = await import("./proxy-cli.runtime.js");

    await runProxyValidateCommand({});

    expect(process.stdout.write).toHaveBeenCalledWith(
      "Proxy validation failed\n\n" +
        "Proxy\n" +
        "  Source: config\n" +
        "  URL:    http://proxy.example:3128/\n\n" +
        "Problems\n" +
        "  - proxy validation requires proxy.enabled to be true for configured proxy URLs\n\n" +
        "Next steps\n" +
        "  Enable proxy.enabled with proxy.proxyUrl or OPENCLAW_PROXY_URL, or pass --proxy-url for an explicit one-off validation.\n",
    );
  });

  it("prints actionable output when proxy config is disabled and missing", async () => {
    runProxyValidationMock.mockResolvedValueOnce({
      ok: false,
      config: {
        enabled: false,
        source: "disabled",
        errors: [
          "proxy validation requires proxy.enabled=true with proxy.proxyUrl or OPENCLAW_PROXY_URL, or --proxy-url",
        ],
      },
      checks: [],
    });
    const { runProxyValidateCommand } = await import("./proxy-cli.runtime.js");

    await runProxyValidateCommand({});

    expect(process.stdout.write).toHaveBeenCalledWith(
      "Proxy validation failed\n\n" +
        "Proxy\n" +
        "  Source: disabled\n" +
        "  URL:    not configured\n\n" +
        "Problems\n" +
        "  - proxy validation requires proxy.enabled=true with proxy.proxyUrl or OPENCLAW_PROXY_URL, or --proxy-url\n\n" +
        "Next steps\n" +
        "  Enable proxy.enabled with proxy.proxyUrl or OPENCLAW_PROXY_URL, or pass --proxy-url for an explicit one-off validation.\n",
    );
    expect(process.exitCode).toBe(1);
  });

  it("redacts malformed proxy URLs in text output", async () => {
    runProxyValidationMock.mockResolvedValueOnce({
      ok: false,
      config: {
        enabled: true,
        proxyUrl: "http://user:secret@",
        source: "env",
        errors: ["proxyUrl must use http://"],
      },
      checks: [],
    });
    const { runProxyValidateCommand } = await import("./proxy-cli.runtime.js");

    await runProxyValidateCommand({});

    expect(process.stdout.write).toHaveBeenCalledWith(
      "Proxy validation failed\n\n" +
        "Proxy\n" +
        "  Source: env\n" +
        "  URL:    <invalid proxy URL>\n\n" +
        "Problems\n" +
        "  - proxyUrl must use http://\n\n" +
        "Next steps\n" +
        "  Fix proxy.proxyUrl, OPENCLAW_PROXY_URL, or --proxy-url so it uses a reachable http:// proxy.\n",
    );
  });

  it("redacts malformed proxy URLs in JSON output", async () => {
    runProxyValidationMock.mockResolvedValueOnce({
      ok: false,
      config: {
        enabled: true,
        proxyUrl: "http://user:secret@",
        source: "override",
        errors: ["proxyUrl must use http://"],
      },
      checks: [],
    });
    const { runProxyValidateCommand } = await import("./proxy-cli.runtime.js");

    await runProxyValidateCommand({ json: true });

    expect(process.stdout.write).toHaveBeenCalledWith(
      `${JSON.stringify(
        {
          ok: false,
          config: {
            enabled: true,
            proxyUrl: "<invalid proxy URL>",
            source: "override",
            errors: ["proxyUrl must use http://"],
          },
          checks: [],
        },
        null,
        2,
      )}\n`,
    );
  });

  it("prints check errors on the same line", async () => {
    runProxyValidationMock.mockResolvedValueOnce({
      ok: true,
      config: {
        enabled: true,
        proxyUrl: "http://proxy.example:3128",
        source: "config",
        errors: [],
      },
      checks: [
        {
          kind: "denied",
          url: "http://127.0.0.1:12345/",
          ok: true,
          error: "fetch failed",
        },
      ],
    });
    const { runProxyValidateCommand } = await import("./proxy-cli.runtime.js");

    await runProxyValidateCommand({});

    expect(process.stdout.write).toHaveBeenCalledWith(
      "Proxy validation passed\n\n" +
        "Proxy\n" +
        "  Source: config\n" +
        "  URL:    http://proxy.example:3128/\n\n" +
        "Checks\n" +
        "  ✓ denied  http://127.0.0.1:12345/ — fetch failed\n",
    );
  });

  it("applies the terminal color theme when rich output is enabled", async () => {
    vi.resetModules();
    vi.doMock("../terminal/theme.js", () => ({
      colorize: (rich: boolean, color: (value: string) => string, value: string) =>
        rich ? color(value) : value,
      isRich: () => true,
      theme: {
        heading: (value: string) => `<heading>${value}</heading>`,
        success: (value: string) => `<success>${value}</success>`,
        error: (value: string) => `<error>${value}</error>`,
        muted: (value: string) => `<muted>${value}</muted>`,
        warn: (value: string) => `<warn>${value}</warn>`,
      },
    }));
    try {
      const { runProxyValidateCommand } = await import("./proxy-cli.runtime.js");

      await runProxyValidateCommand({});

      const output = String(vi.mocked(process.stdout.write).mock.calls.at(0)?.[0] ?? "");
      expect(output).toContain("<success>Proxy validation passed</success>");
      expect(output).toContain("<heading>Checks</heading>");
      expect(output).toContain("<success>✓</success>");
    } finally {
      vi.doUnmock("../terminal/theme.js");
    }
  });

  it("prints actionable check failure output", async () => {
    runProxyValidationMock.mockResolvedValueOnce({
      ok: false,
      config: {
        enabled: true,
        proxyUrl: "http://proxy.example:3128",
        source: "config",
        errors: [],
      },
      checks: [
        {
          kind: "allowed",
          url: "http://target.example/allowed",
          ok: true,
          status: 200,
        },
        {
          kind: "denied",
          url: "http://target.example/allowed",
          ok: false,
          status: 200,
          error: "Denied destination was reachable through the proxy",
        },
      ],
    });
    const { runProxyValidateCommand } = await import("./proxy-cli.runtime.js");

    await runProxyValidateCommand({});

    expect(process.stdout.write).toHaveBeenCalledWith(
      "Proxy validation failed\n\n" +
        "Proxy\n" +
        "  Source: config\n" +
        "  URL:    http://proxy.example:3128/\n\n" +
        "Checks\n" +
        "  ✓ allowed http://target.example/allowed HTTP 200\n" +
        "  ✗ denied  http://target.example/allowed HTTP 200 — Denied destination was reachable through the proxy\n\n" +
        "Next steps\n" +
        "  Update the proxy ACL so denied destinations are blocked, or pass the expected --denied-url values.\n",
    );
    expect(process.exitCode).toBe(1);
  });

  it("prints proxy validation JSON and sets exit code on failure", async () => {
    runProxyValidationMock.mockResolvedValueOnce({
      ok: false,
      config: {
        enabled: true,
        source: "missing",
        errors: ["proxy validation requires proxy.proxyUrl, --proxy-url, or OPENCLAW_PROXY_URL"],
      },
      checks: [],
    });
    const { runProxyValidateCommand } = await import("./proxy-cli.runtime.js");

    await runProxyValidateCommand({ json: true });

    expect(process.stdout.write).toHaveBeenCalledWith(
      `${JSON.stringify(
        {
          ok: false,
          config: {
            enabled: true,
            source: "missing",
            errors: [
              "proxy validation requires proxy.proxyUrl, --proxy-url, or OPENCLAW_PROXY_URL",
            ],
          },
          checks: [],
        },
        null,
        2,
      )}\n`,
    );
    expect(process.exitCode).toBe(1);
  });

  it("stops the proxy server and ends the session when child spawn fails", async () => {
    spawnMock.mockImplementation(() => {
      const child = new EventEmitter();
      queueMicrotask(() => {
        child.emit("error", new Error("spawn failed"));
      });
      return child;
    });

    const { runDebugProxyRunCommand } = await import("./proxy-cli.runtime.js");
    const { getDebugProxyCaptureStore } = await import("../proxy-capture/store.sqlite.js");

    const beforeRun = Date.now();
    await expect(
      runDebugProxyRunCommand({
        commandArgs: ["does-not-exist"],
      }),
    ).rejects.toThrow("spawn failed");

    expect(serverStopSpy).toHaveBeenCalledTimes(1);

    const store = getDebugProxyCaptureStore(
      process.env.OPENCLAW_DEBUG_PROXY_DB_PATH!,
      process.env.OPENCLAW_DEBUG_PROXY_BLOB_DIR!,
    );
    const [session] = store.listSessions(5);
    expect(session?.mode).toBe("proxy-run");
    expect(session?.endedAt).toBeGreaterThanOrEqual(beforeRun);
  });
});
