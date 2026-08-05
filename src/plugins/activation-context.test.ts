// Covers plugin activation context construction and lazy boundaries.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createPluginMetadataSnapshot,
  makeRegistry,
} from "../config/plugin-auto-enable.test-helpers.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { setCurrentPluginMetadataSnapshot } from "./current-plugin-metadata-snapshot.js";
import { clearCurrentPluginMetadataSnapshot } from "./current-plugin-metadata-state.js";
import type { PluginDiscoveryResult } from "./discovery.js";

const applyPluginAutoEnableMock = vi.hoisted(() =>
  vi.fn((params: { config?: OpenClawConfig }) => ({
    config: params.config,
    changes: [],
    autoEnabledReasons: {},
  })),
);

vi.mock("../config/plugin-auto-enable.js", () => ({
  applyPluginAutoEnable: applyPluginAutoEnableMock,
}));

import {
  resolveBundledPluginCompatibleActivationInputs,
  withActivatedPluginIds,
} from "./activation-context.js";

afterEach(() => {
  clearCurrentPluginMetadataSnapshot();
  applyPluginAutoEnableMock.mockClear();
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

describe("resolveBundledPluginCompatibleActivationInputs", () => {
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

    resolveBundledPluginCompatibleActivationInputs({
      rawConfig: { plugins: { allow: ["openai"] } },
      workspaceDir,
      applyAutoEnable: true,
      compatMode: {},
      resolveCompatPluginIds: () => [],
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
      resolveBundledPluginCompatibleActivationInputs({
        rawConfig: { plugins: { allow: [manifestRegistry.plugins[0]!.id] } },
        manifestRegistry,
        discovery,
        applyAutoEnable: true,
        compatMode: {},
        resolveCompatPluginIds: () => [],
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
});
