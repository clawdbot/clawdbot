import { afterEach, describe, expect, it, vi } from "vitest";
import { logGatewayStartup } from "./server-startup-log.js";

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

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("dangerous config flags enabled"));
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("gateway.controlUi.dangerouslyDisableDeviceAuth=true"),
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("openclaw security audit"));
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

  it("logs a compact ready line with loaded plugin ids and duration", () => {
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

    const readyMessages = info.mock.calls
      .map((call) => call[0])
      .filter((message) => message.startsWith("ready ("));
    expect(readyMessages).toEqual(["ready (3 plugins: alpha, beta, delta; 16.0s)"]);
  });
});
