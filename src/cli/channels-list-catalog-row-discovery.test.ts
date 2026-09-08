// The real channels-list route must resolve catalog-row repair hints from prepared
// manifest facts instead of rebuilding the manifest registry once per catalog row.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, expect, it, vi } from "vitest";
import type { ChannelPluginCatalogEntry } from "../channels/plugins/catalog.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

const testState = vi.hoisted(() => ({
  config: {} as OpenClawConfig,
  json: [] as unknown[],
  catalogEntries: [] as ChannelPluginCatalogEntry[],
  manifestRegistryRebuilds: 0,
}));

vi.mock("../plugins/plugin-registry-contributions.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../plugins/plugin-registry-contributions.js")>();
  return {
    ...actual,
    loadPluginManifestRegistryForPluginRegistry: (
      ...args: Parameters<typeof actual.loadPluginManifestRegistryForPluginRegistry>
    ) => {
      testState.manifestRegistryRebuilds += 1;
      return actual.loadPluginManifestRegistryForPluginRegistry(...args);
    },
  };
});

vi.mock("./command-execution-startup.js", () => ({
  applyCliExecutionStartupPresentation: vi.fn(async () => {}),
  ensureCliExecutionBootstrap: vi.fn(async () => {}),
}));

vi.mock("../commands/channels/shared.js", () => ({
  formatChannelAccountLabel: vi.fn(),
  requireValidChannelConfig: vi.fn(async () => testState.config),
}));

vi.mock("../commands/channel-setup/trusted-catalog.js", () => ({
  listTrustedChannelPluginCatalogEntries: vi.fn(() => testState.catalogEntries),
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

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-channels-list-catalog-rows-"));

// Official external channels whose owner plugin is not installed. Each one is
// configured, so `channels list` renders it as a catalog-only row and resolves a
// repair hint for it.
const OWNERLESS_CHANNEL_IDS = ["feishu", "googlechat", "matrix", "twitch"] as const;

function officialExternalCatalogEntry(channelId: string): ChannelPluginCatalogEntry {
  return {
    id: channelId,
    meta: { label: channelId },
    install: { npmSpec: `@openclaw/${channelId}` },
  } as ChannelPluginCatalogEntry;
}

async function runChannelsListJson(channelIds: readonly string[]): Promise<{
  rebuilds: number;
  chat: unknown;
}> {
  testState.catalogEntries = channelIds.map(officialExternalCatalogEntry);
  testState.config = {
    channels: Object.fromEntries(channelIds.map((channelId) => [channelId, { enabled: true }])),
  } as OpenClawConfig;
  testState.json = [];
  testState.manifestRegistryRebuilds = 0;
  await expect(tryRouteCli(["node", "openclaw", "channels", "list", "--json"])).resolves.toBe(true);
  return {
    rebuilds: testState.manifestRegistryRebuilds,
    chat: (testState.json[0] as { chat: unknown }).chat,
  };
}

beforeEach(() => {
  vi.stubEnv("OPENCLAW_DISABLE_BUNDLED_PLUGINS", "1");
  vi.stubEnv("OPENCLAW_HOME", path.join(tempRoot, "home"));
  vi.stubEnv("OPENCLAW_STATE_DIR", path.join(tempRoot, "state"));
});

afterAll(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

it("resolves catalog-row repair hints without rebuilding the manifest registry", async () => {
  const empty = await runChannelsListJson([]);
  const rows = await runChannelsListJson(OWNERLESS_CHANNEL_IDS);

  // Every row still resolves its repair hint, so the presence policy really ran.
  expect(rows.chat).toEqual(
    Object.fromEntries(
      OWNERLESS_CHANNEL_IDS.map((channelId) => [
        channelId,
        { accounts: [], installed: false, origin: "configured" },
      ]),
    ),
  );
  // Discovery is prepared once per invocation, so row count cannot move this number.
  expect({ noRows: empty.rebuilds, fourRows: rows.rebuilds }).toEqual({ noRows: 0, fourRows: 0 });
});
