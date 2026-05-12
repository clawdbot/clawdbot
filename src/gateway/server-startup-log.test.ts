import { afterEach, describe, expect, it, vi } from "vitest";
import { stripAnsi } from "../terminal/ansi.js";
import { formatAgentModelStartupDetails, logGatewayStartup } from "./server-startup-log.js";

describe("gateway startup log", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("warns when dangerous config flags are enabled", () => {
    const info = vi.fn();
    const warn = vi.fn();

    logGatewayStartup({
      cfg: {
        gateway: {
          controlUi: {
            dangerouslyDisableDeviceAuth: true,
          },
        },
      },
      bindHost: "127.0.0.1",
      loadedPluginIds: [],
      port: 18789,
      log: { info, warn },
      isNixMode: false,
    });

    expect(warn.mock.calls).toEqual([
      [
        "security warning: dangerous config flags enabled: gateway.controlUi.dangerouslyDisableDeviceAuth=true. Run `openclaw security audit`.",
      ],
    ]);
  });

  it("does not warn when dangerous config flags are disabled", () => {
    const info = vi.fn();
    const warn = vi.fn();

    logGatewayStartup({
      cfg: {},
      bindHost: "127.0.0.1",
      loadedPluginIds: [],
      port: 18789,
      log: { info, warn },
      isNixMode: false,
    });

    expect(warn).not.toHaveBeenCalled();
  });

  it("logs configured model thinking and fast mode defaults with the startup model", () => {
    const info = vi.fn();
    const warn = vi.fn();

    logGatewayStartup({
      cfg: {
        agents: {
          defaults: {
            model: "openai-codex/gpt-5.5",
            models: {
              "openai-codex/gpt-5.5": {
                params: {
                  fastMode: true,
                  thinking: "medium",
                },
              },
            },
            reasoningDefault: "stream",
          },
        },
      },
      bindHost: "127.0.0.1",
      loadedPluginIds: [],
      port: 18789,
      log: { info, warn },
      isNixMode: false,
    });

    expect(info.mock.calls[0]?.[0]).toBe(
      "agent model: openai-codex/gpt-5.5 (thinking=medium, fast=on)",
    );
    expect(stripAnsi(String(info.mock.calls[0]?.[1]?.consoleMessage))).toBe(
      "agent model: openai-codex/gpt-5.5 (thinking=medium, fast=on)",
    );
  });

  it("defaults unset startup thinking to medium", () => {
    expect(
      formatAgentModelStartupDetails({
        cfg: {
          agents: {
            defaults: {
              model: "openai-codex/gpt-5.5",
            },
            list: [{ id: "main", default: true, fastModeDefault: true }],
          },
        },
        provider: "openai-codex",
        model: "gpt-5.5",
      }),
    ).toBe("thinking=medium, fast=on");
  });

  it("preserves explicit startup thinking off", () => {
    expect(
      formatAgentModelStartupDetails({
        cfg: {
          agents: {
            defaults: {
              models: {
                "openai-codex/gpt-5.5": { params: { thinking: "off", fastMode: true } },
              },
            },
          },
        },
        provider: "openai-codex",
        model: "gpt-5.5",
      }),
    ).toBe("thinking=off, fast=on");
  });

  it("uses default agent mode overrides in the startup model details", () => {
    expect(
      formatAgentModelStartupDetails({
        cfg: {
          agents: {
            defaults: {
              thinkingDefault: "low",
              reasoningDefault: "off",
              models: {
                "openai/gpt-5.5": { params: { fastMode: false } },
              },
            },
            list: [{ id: "alpha", default: true, thinkingDefault: "high", fastModeDefault: true }],
          },
        },
        provider: "openai",
        model: "gpt-5.5",
      }),
    ).toBe("thinking=high, fast=on");
  });

  it("logs a compact listening line with loaded plugin ids and duration", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-03T10:00:16.000Z"));

    const info = vi.fn();
    const warn = vi.fn();

    logGatewayStartup({
      cfg: {},
      bindHost: "127.0.0.1",
      bindHosts: ["127.0.0.1", "::1"],
      loadedPluginIds: ["delta", "alpha", "delta", "beta"],
      port: 18789,
      startupStartedAt: Date.parse("2026-04-03T10:00:00.000Z"),
      log: { info, warn },
      isNixMode: false,
    });

    const listeningMessages = info.mock.calls
      .map((call) => call[0])
      .filter((message) => message.startsWith("http server listening ("));
    expect(listeningMessages).toEqual([
      "http server listening (3 plugins: alpha, beta, delta; 16.0s)",
    ]);
  });
});
