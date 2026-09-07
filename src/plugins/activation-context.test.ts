// Covers plugin activation context construction and lazy boundaries.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createPluginMetadataSnapshot,
  makeRegistry,
} from "../config/plugin-auto-enable.test-helpers.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { setCurrentPluginMetadataSnapshot } from "./current-plugin-metadata.test-support.js";
import type { PluginDiscoveryResult } from "./discovery.js";
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";

const applyPluginAutoEnableMock = vi.hoisted(() =>
  vi.fn((params: { config?: OpenClawConfig }) => ({
    config: params.config,
    changes: [],
    autoEnabledReasons: {},
  })),
);
const withBundledPluginEnablementCompatMock = vi.hoisted(() =>
  vi.fn((params: { config?: OpenClawConfig }) => params.config),
);

vi.mock("../config/plugin-auto-enable.js", () => ({
  applyPluginAutoEnable: applyPluginAutoEnableMock,
}));
vi.mock("./bundled-compat.js", () => ({
  withBundledPluginEnablementCompat: withBundledPluginEnablementCompatMock,
}));

import {
  resolveBundledCompatActivationInputs,
  withActivatedPluginIds,
} from "./activation-context.js";

afterEach(() => {
  clearPluginMetadataLifecycleCaches();
  applyPluginAutoEnableMock.mockClear();
  withBundledPluginEnablementCompatMock.mockClear();
});

describe("withActivatedPluginIds", () => {
  it("keeps omitted plugin ids outside restrictive allowlists", () => {
    expect(
      withActivatedPluginIds({
        config: {
          plugins: {
            allow: ["memory-core"],
            deny: ["blocked"],
            entries: {
              disabled: { enabled: false },
            },
          },
        },
        pluginIds: ["openai", "blocked", "disabled"],
      }),
    ).toEqual({
      plugins: {
        allow: ["memory-core"],
        deny: ["blocked"],
        entries: {
          disabled: { enabled: false },
        },
      },
    });
  });
});

describe("plugin activation inputs", () => {
  it("passes the current manifest registry into activation auto-enable", () => {
    const manifestRegistry = makeRegistry([{ id: "openai", channels: [], providers: ["openai"] }]);
    const workspaceDir = "/tmp/openclaw-activation-workspace";
    setCurrentPluginMetadataSnapshot(
      createPluginMetadataSnapshot({
        config: {},
        manifestRegistry,
        workspaceDir,
      }),
      {
        config: {},
        workspaceDir,
      },
    );

    resolveBundledCompatActivationInputs({
      rawConfig: { plugins: { allow: ["openai"] } },
      workspaceDir,
      applyAutoEnable: true,
      resolveBundledPluginIds: () => [],
    });

    expect(applyPluginAutoEnableMock).toHaveBeenCalledWith({
      config: { plugins: { allow: ["openai"] } },
      env: process.env,
      manifestRegistry,
    });
  });

  it("uses the caller's exact metadata generation across lifecycle replacement", () => {
    const firstManifestRegistry = makeRegistry([
      { id: "first", channels: [], providers: ["first"] },
    ]);
    const secondManifestRegistry = makeRegistry([
      { id: "second", channels: [], providers: ["second"] },
    ]);
    const firstDiscovery = { plugins: [], diagnostics: [] } as unknown as PluginDiscoveryResult;
    const secondDiscovery = { plugins: [], diagnostics: [] } as unknown as PluginDiscoveryResult;

    for (const [manifestRegistry, discovery] of [
      [firstManifestRegistry, firstDiscovery],
      [secondManifestRegistry, secondDiscovery],
    ] as const) {
      resolveBundledCompatActivationInputs({
        rawConfig: { plugins: { allow: [manifestRegistry.plugins[0]!.id] } },
        manifestRegistry,
        discovery,
        applyAutoEnable: true,
        resolveBundledPluginIds: () => [],
      });
    }

    expect(applyPluginAutoEnableMock).toHaveBeenNthCalledWith(1, {
      config: { plugins: { allow: ["first"] } },
      env: process.env,
      manifestRegistry: firstManifestRegistry,
      discovery: firstDiscovery,
    });
    expect(applyPluginAutoEnableMock).toHaveBeenNthCalledWith(2, {
      config: { plugins: { allow: ["second"] } },
      env: process.env,
      manifestRegistry: secondManifestRegistry,
      discovery: secondDiscovery,
    });
  });

  it("applies bundled enablement once after canonical auto-enable", () => {
    const rawConfig = { plugins: { allow: ["openai"] } } satisfies OpenClawConfig;
    const autoEnabledConfig = {
      plugins: { allow: ["openai"], entries: { openai: { enabled: true } } },
    } satisfies OpenClawConfig;
    const compatConfig = {
      plugins: {
        allow: ["openai", "anthropic"],
        entries: { openai: { enabled: true }, anthropic: { enabled: true } },
      },
    } satisfies OpenClawConfig;
    const resolveBundledPluginIds = vi.fn(() => ["anthropic"]);
    applyPluginAutoEnableMock.mockReturnValueOnce({
      config: autoEnabledConfig,
      changes: [],
      autoEnabledReasons: { openai: ["configured"] },
    });
    withBundledPluginEnablementCompatMock.mockReturnValueOnce(compatConfig);

    const activation = resolveBundledCompatActivationInputs({
      rawConfig,
      env: process.env,
      workspaceDir: "/tmp/openclaw-activation-workspace",
      onlyPluginIds: ["anthropic"],
      applyAutoEnable: true,
      resolveBundledPluginIds,
    });

    expect(resolveBundledPluginIds).toHaveBeenCalledWith({
      config: autoEnabledConfig,
      workspaceDir: "/tmp/openclaw-activation-workspace",
      env: process.env,
      onlyPluginIds: ["anthropic"],
    });
    expect(withBundledPluginEnablementCompatMock).toHaveBeenCalledOnce();
    expect(withBundledPluginEnablementCompatMock).toHaveBeenCalledWith({
      config: autoEnabledConfig,
      pluginIds: ["anthropic"],
      env: process.env,
    });
    expect(activation.config).toBe(compatConfig);
    expect(activation.normalized.entries.anthropic?.enabled).toBe(true);
    expect(activation.activationSourceConfig).toBe(rawConfig);
    expect(activation.autoEnabledReasons).toEqual({ openai: ["configured"] });
  });
});
