import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  cleanupPluginLoaderFixturesForTest,
  EMPTY_PLUGIN_SCHEMA,
  makeTempDir,
  resetPluginLoaderTestStateForTest,
  useNoBundledPlugins,
} from "../plugins/loader.test-fixtures.js";
import { withEnvAsync } from "../test-utils/env.js";
import { channelsStatusCommand } from "./channels/status.js";
import { createCapturingTestRuntime } from "./test-runtime-config-helpers.js";

const mocks = vi.hoisted(() => ({
  callGateway: vi.fn(),
  readConfigFileSnapshot: vi.fn(async () => ({ path: "/tmp/openclaw.json" })),
  requireValidConfigSnapshot: vi.fn(),
  resolveCommandConfigWithSecrets: vi.fn(),
}));

vi.mock("../gateway/call.js", () => ({
  callGateway: (opts: unknown) => mocks.callGateway(opts),
}));

vi.mock("../config/config.js", () => ({
  readConfigFileSnapshot: () => mocks.readConfigFileSnapshot(),
}));

vi.mock("../cli/command-config-resolution.js", () => ({
  resolveCommandConfigWithSecrets: (opts: unknown) => mocks.resolveCommandConfigWithSecrets(opts),
}));

vi.mock("./channels/shared.js", () => ({
  requireValidConfigSnapshot: (runtime: unknown) => mocks.requireValidConfigSnapshot(runtime),
  formatChannelAccountLabel: ({ channel, accountId }: { channel: string; accountId: string }) =>
    `${channel} ${accountId}`,
  appendBaseUrlBit: () => undefined,
  appendEnabledConfiguredLinkedBits: () => undefined,
  appendModeBit: () => undefined,
  appendTokenSourceBits: () => undefined,
  buildChannelAccountLine: () => "",
}));

vi.mock("../cli/progress.js", () => ({
  withProgress: async (_opts: unknown, run: () => Promise<unknown>) => await run(),
}));

function writeExternalEnvChannelPlugin() {
  useNoBundledPlugins();
  const pluginDir = makeTempDir();
  const fullMarker = path.join(pluginDir, "full-loaded.txt");
  fs.writeFileSync(
    path.join(pluginDir, "package.json"),
    JSON.stringify(
      {
        name: "@example/openclaw-external-env-channel",
        version: "1.0.0",
        openclaw: {
          extensions: ["./index.cjs"],
        },
      },
      null,
      2,
    ),
    "utf-8",
  );
  fs.writeFileSync(
    path.join(pluginDir, "openclaw.plugin.json"),
    JSON.stringify(
      {
        id: "external-env-channel-plugin",
        configSchema: EMPTY_PLUGIN_SCHEMA,
        channels: ["external-env-channel"],
        channelEnvVars: {
          "external-env-channel": ["EXTERNAL_ENV_CHANNEL_TOKEN"],
        },
      },
      null,
      2,
    ),
    "utf-8",
  );
  fs.writeFileSync(
    path.join(pluginDir, "index.cjs"),
    `require("node:fs").writeFileSync(${JSON.stringify(fullMarker)}, "loaded", "utf-8");`,
    "utf-8",
  );
  return { pluginDir, fullMarker };
}

describe("channelsStatusCommand external env-only channel fallback", () => {
  beforeEach(() => {
    mocks.callGateway.mockReset();
    mocks.callGateway.mockRejectedValue(new Error("gateway closed"));
    mocks.readConfigFileSnapshot.mockClear();
    mocks.requireValidConfigSnapshot.mockReset();
    mocks.resolveCommandConfigWithSecrets.mockReset();
  });

  afterEach(() => {
    resetPluginLoaderTestStateForTest();
  });

  it("reports env-only external manifest channels in JSON fallback without full runtime load", async () => {
    const { pluginDir, fullMarker } = writeExternalEnvChannelPlugin();
    const config = {
      plugins: {
        load: { paths: [pluginDir] },
        allow: ["external-env-channel-plugin"],
      },
    } as OpenClawConfig;
    mocks.requireValidConfigSnapshot.mockResolvedValue(config);
    mocks.resolveCommandConfigWithSecrets.mockResolvedValue({
      resolvedConfig: config,
      effectiveConfig: config,
      diagnostics: [],
    });
    const { runtime, logs } = createCapturingTestRuntime();

    await withEnvAsync({ EXTERNAL_ENV_CHANNEL_TOKEN: "token" }, async () => {
      await channelsStatusCommand({ json: true, probe: false }, runtime as never);
    });

    expect(fs.existsSync(fullMarker)).toBe(false);
    const payload = JSON.parse(logs.at(-1) ?? "{}");
    expect(payload.gatewayReachable).toBe(false);
    expect(payload.configOnly).toBe(true);
    expect(payload.configuredChannels).toEqual(["external-env-channel"]);
  });
});

afterAll(() => {
  cleanupPluginLoaderFixturesForTest();
});
