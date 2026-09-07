// The real channels-list route must project manifest facts without executing setup modules.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resetPluginRuntimeStateForTest } from "../plugins/runtime.js";
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
  tryResolveConfiguredAgentWorkspaceDir: vi.fn(() => undefined),
  tryResolveSystemAgentWorkspaceDir: vi.fn(() => undefined),
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

it.each([
  { name: "top-level", channel: { token: "configured" }, accounts: ["default"] },
  {
    name: "named",
    channel: { accounts: { alerts: { token: "configured" }, default: { token: "configured" } } },
    accounts: ["alerts", "default"],
  },
])(
  "renders $name channel accounts without loading setup or runtime",
  async ({ name, channel, accounts }) => {
    resetPluginRuntimeStateForTest();
    testState.json.length = 0;
    const pluginRoot = path.join(tempRoot, name);
    fs.mkdirSync(pluginRoot, { recursive: true });
    const setupMarker = path.join(pluginRoot, "setup-loaded.txt");
    const fixture = createColdPluginFixture({
      rootDir: pluginRoot,
      pluginId: "cold-channel-plugin",
      channelId: "cold-channel",
      setupEntrySource: `require("node:fs").writeFileSync(${JSON.stringify(setupMarker)}, "loaded");
throw new Error("JSON inventory must not execute setup");`,
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
      channels: { "cold-channel": channel },
      plugins: {
        load: { paths: [pluginRoot] },
        entries: { "cold-channel-plugin": { enabled: true } },
      },
    };

    for (const flags of [["--json"], ["--all", "--json"]]) {
      await expect(tryRouteCli(["node", "openclaw", "channels", "list", ...flags])).resolves.toBe(
        true,
      );
    }

    const expected = {
      chat: {
        "cold-channel": {
          accounts,
          installed: true,
          origin: "configured",
        },
      },
    };
    expect(testState.json).toEqual([expected, expected]);
    expect(fs.existsSync(setupMarker)).toBe(false);
    expect(isColdPluginRuntimeLoaded(fixture)).toBe(false);
  },
);
