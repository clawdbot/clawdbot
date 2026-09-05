// Proxy CLI rich-theme coverage stays isolated because the theme mock must precede runtime import.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getRuntimeConfigMock, runProxyValidationMock } = vi.hoisted(() => ({
  getRuntimeConfigMock: vi.fn(),
  runProxyValidationMock: vi.fn(),
}));

vi.mock("../config/config.js", () => ({
  getRuntimeConfig: getRuntimeConfigMock,
}));

vi.mock("../infra/net/proxy/proxy-validation.js", () => ({
  runProxyValidation: runProxyValidationMock,
}));

describe("proxy cli runtime theme", () => {
  beforeEach(() => {
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
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("applies the terminal color theme when rich output is enabled", async () => {
    vi.resetModules();
    vi.doMock("../../packages/terminal-core/src/theme.js", () => ({
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

      const output = String(vi.mocked(process.stdout["write"]).mock.calls.at(0)?.[0] ?? "");
      expect(output).toContain("<success>Proxy validation passed</success>");
      expect(output).toContain("<heading>Checks</heading>");
      expect(output).toContain("<success>✓</success>");
    } finally {
      vi.doUnmock("../../packages/terminal-core/src/theme.js");
    }
  });
});
