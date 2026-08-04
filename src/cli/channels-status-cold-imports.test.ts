// The real route-first channel status path must honor the shared catalog guard policy.
import { beforeEach, describe, expect, it, vi } from "vitest";

const loaded = vi.hoisted(() => {
  const modules = new Set<string>();
  return {
    modules,
    mark(name: string) {
      modules.add(name);
    },
  };
});
const callGatewayMock = vi.hoisted(() => vi.fn(async () => ({ channelAccounts: {} })));
const runtime = vi.hoisted(() => ({
  error: vi.fn(),
  exit: vi.fn(),
  log: vi.fn(),
  writeJson: vi.fn(),
  writeStdout: vi.fn(),
}));

vi.mock("./program/config-guard.js", () => {
  loaded.mark("config-guard");
  return { ensureConfigReady: vi.fn(async () => {}) };
});

vi.mock("../commands/channels/status.runtime.js", () => {
  loaded.mark("channels-status-runtime");
  return {
    formatGatewayChannelsStatusLines: vi.fn(() => []),
    renderChannelsStatusFallback: vi.fn(async () => {}),
  };
});

vi.mock("../gateway/call.js", () => ({
  callGateway: callGatewayMock,
}));

vi.mock("./progress.js", () => ({
  withProgress: vi.fn(async (_opts, run: () => Promise<unknown>) => await run()),
}));

vi.mock("../runtime.js", () => ({
  defaultRuntime: runtime,
  writeRuntimeJson: vi.fn((target, value) => target.writeJson(value, 2)),
}));

import { tryRouteCli } from "./route.js";

describe("routed channels status cold imports", () => {
  beforeEach(() => {
    // Never clear `loaded.modules`: mock factories mark at module-load time, so an
    // eager import during route.js's own static import graph is exactly the
    // regression evidence this test exists to keep.
    vi.clearAllMocks();
  });

  it("keeps successful all-channel JSON routes cold with and without probing", async () => {
    for (const probe of [false, true]) {
      vi.clearAllMocks();
      const timeoutMs = probe ? 30000 : 10000;
      const argv = [
        "node",
        "openclaw",
        "channels",
        "status",
        "--json",
        "--channel",
        probe ? " ALL " : "all",
      ];
      if (probe) {
        argv.push("--probe");
      }

      await expect(tryRouteCli(argv)).resolves.toBe(true);

      expect(callGatewayMock).toHaveBeenCalledOnce();
      expect(callGatewayMock).toHaveBeenCalledWith({
        method: "channels.status",
        params: { probe, timeoutMs },
        timeoutMs,
      });
      expect(runtime.writeJson).toHaveBeenCalledWith({ channelAccounts: {} }, 2);
      expect(loaded.modules).not.toContain("config-guard");
      expect(loaded.modules).not.toContain("channels-status-runtime");
    }
  });
});
