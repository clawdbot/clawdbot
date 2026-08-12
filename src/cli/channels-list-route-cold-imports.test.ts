// The real channels-list route must project manifest facts without executing setup modules.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  createColdPluginFixture,
  isColdPluginRuntimeLoaded,
} from "../plugins/test-helpers/cold-plugin-fixtures.js";

const testState = vi.hoisted(() => ({
  config: {} as OpenClawConfig,
  json: [] as unknown[],
}));

vi.mock("./command-execution-startup.js", () => ({
  applyCliExecutionStartupPresentation: vi.fn(async () => {}),
  ensureCliExecutionBootstrap: vi.fn(async () => {}),
  resolveCliExecutionStartupContext: vi.fn(() => ({
    startupPolicy: { loadPlugins: false, suppressDoctorStdout: true },
  })),
}));

vi.mock("../commands/channels/shared.js", () => ({
  formatChannelAccountLabel: vi.fn(),
  requireValidChannelConfig: vi.fn(async () => testState.config),
}));

vi.mock("../commands/channel-setup/trusted-catalog.js", () => ({
  listTrustedChannelPluginCatalogEntries: vi.fn(() => []),
}));

vi.mock("../agents/agent-scope.js", () => ({
  resolveAgentWorkspaceDir: vi.fn(() => undefined),
  resolveDefaultAgentId: vi.fn(() => "main"),
}));

vi.mock("../runtime.js", () => ({
  defaultRuntime: {
    error: vi.fn(),
    exit: vi.fn(),
    log: vi.fn(),
    writeJson: (value: unknown) => testState.json.push(value),
    writeStdout: vi.fn(),
  },
  writeRuntimeJson: vi.fn((runtime: { writeJson: (value: unknown) => void }, value: unknown) =>
    runtime.writeJson(value),
  ),
}));

import { tryRouteCli } from "./route.js";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-channels-list-route-"));

afterAll(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

it("renders configured channel metadata without loading the plugin runtime", async () => {
  const pluginRoot = path.join(tempRoot, "cold-channel-plugin");
  fs.mkdirSync(pluginRoot, { recursive: true });
  const fixture = createColdPluginFixture({
    rootDir: pluginRoot,
    pluginId: "cold-channel-plugin",
    channelId: "cold-channel",
    manifest: {
      channelConfigs: {
        "cold-channel": {
          schema: {
            type: "object",
            additionalProperties: false,
            properties: { token: { type: "string" } },
          },
          label: "Cold Channel",
          description: "Prepared cold channel metadata",
        },
      },
    },
  });
  vi.stubEnv("OPENCLAW_DISABLE_BUNDLED_PLUGINS", "1");
  vi.stubEnv("OPENCLAW_HOME", path.join(tempRoot, "home"));
  vi.stubEnv("OPENCLAW_STATE_DIR", path.join(tempRoot, "state"));
  testState.config = {
    channels: { "cold-channel": { token: "configured" } },
    plugins: {
      load: { paths: [pluginRoot] },
      entries: { "cold-channel-plugin": { enabled: true } },
    },
  };

  await expect(tryRouteCli(["node", "openclaw", "channels", "list", "--json"])).resolves.toBe(true);

  expect(testState.json).toEqual([
    {
      chat: {
        "cold-channel": {
          accounts: ["default"],
          installed: true,
          origin: "configured",
        },
      },
    },
  ]);
  expect(isColdPluginRuntimeLoaded(fixture)).toBe(false);
});
