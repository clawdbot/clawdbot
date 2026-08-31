// Node status must advertise Node rewrite commands for a legacy /dev/null plist.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveNodeLaunchAgentLabel } from "../../daemon/constants.js";
import { resolveLaunchAgentPlistPathForLabel } from "../../daemon/launchd-service-files.js";
import type { GatewayServiceRuntime } from "../../daemon/service-runtime.js";
import type { GatewayServiceCommandConfig } from "../../daemon/service-types.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { formatCliCommand } from "../command-format.js";
import { runNodeDaemonStatus } from "./daemon.js";

const mocks = vi.hoisted(() => {
  const service = {
    label: "Node service",
    loadedText: "loaded",
    notLoadedText: "not loaded",
    stage: vi.fn(),
    install: vi.fn(),
    uninstall: vi.fn(),
    stop: vi.fn(),
    restart: vi.fn(),
    isLoaded: vi.fn(async () => true),
    readCommand: vi.fn<() => Promise<GatewayServiceCommandConfig | null>>(async () => null),
    readRuntime: vi.fn<() => Promise<GatewayServiceRuntime>>(async () => ({ status: "running" })),
  };
  return {
    runtime: {
      log: vi.fn<(line: string) => void>(),
      error: vi.fn<(line: string) => void>(),
      writeJson: vi.fn(),
      exit: vi.fn(),
    },
    service,
  };
});

vi.mock("../../runtime.js", () => ({
  defaultRuntime: mocks.runtime,
}));

vi.mock("../../daemon/node-service.js", () => ({
  resolveNodeService: () => mocks.service,
}));

function stdout(): string {
  return mocks.runtime.log.mock.calls.map(([line]) => line).join("\n");
}

describe("runNodeDaemonStatus launchd stderr hints", () => {
  let homeDir: string;

  beforeEach(() => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-node-status-hints-"));
    mocks.runtime.log.mockClear();
    mocks.runtime.error.mockClear();
    mocks.service.isLoaded.mockReset().mockResolvedValue(true);
    mocks.service.readCommand.mockReset().mockResolvedValue({
      programArguments: ["node", "node-host"],
      environment: { HOME: homeDir, OPENCLAW_LOG_PREFIX: "node" },
    });
    mocks.service.readRuntime.mockReset().mockResolvedValue({ status: "stopped" });
  });

  afterEach(() => {
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  it("tells a stopped legacy Node LaunchAgent to rewrite the Node service", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "darwin" });
    try {
      const plistPath = resolveLaunchAgentPlistPathForLabel(
        { HOME: homeDir },
        resolveNodeLaunchAgentLabel(),
      );
      fs.mkdirSync(path.dirname(plistPath), { recursive: true });
      fs.writeFileSync(
        plistPath,
        `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
  <dict>
    <key>StandardErrorPath</key>
    <string>/dev/null</string>
  </dict>
</plist>
`,
      );

      await withEnvAsync({ HOME: homeDir, OPENCLAW_PROFILE: undefined }, async () => {
        await runNodeDaemonStatus();
      });
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform });
    }

    expect(stdout()).toContain("suppressed (/dev/null)");
    expect(stdout()).toContain(formatCliCommand("openclaw node restart"));
    expect(stdout()).toContain(formatCliCommand("openclaw node install --force"));
    expect(stdout()).not.toContain("openclaw gateway restart");
    expect(stdout()).not.toContain("openclaw gateway install");
  });
});
