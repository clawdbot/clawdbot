/** Verifies effective plugin id resolution across config, manifests, and activation sources. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createPluginMetadataSnapshotFixture } from "./plugin-metadata.test-support.js";

const mocks = vi.hoisted(() => ({
  applyPluginAutoEnable:
    vi.fn<typeof import("../config/plugin-auto-enable.js").applyPluginAutoEnable>(),
  listExplicitlyDisabledChannelIdsForConfig: vi.fn(),
  listPotentialConfiguredChannelIds: vi.fn(),
  listExplicitConfiguredChannelIdsForConfig: vi.fn(),
  loadGatewayStartupPluginPlan:
    vi.fn<typeof import("./channel-plugin-ids.js").loadGatewayStartupPluginPlan>(),
  resolveConfiguredChannelPluginIds:
    vi.fn<typeof import("./channel-plugin-ids.js").resolveConfiguredChannelPluginIds>(),
  loadManifestMetadataSnapshot:
    vi.fn<typeof import("./manifest-contract-eligibility.js").loadManifestMetadataSnapshot>(),
  passesManifestOwnerBasePolicy:
    vi.fn<typeof import("./manifest-owner-policy.js").passesManifestOwnerBasePolicy>(),
}));

vi.mock("../config/plugin-auto-enable.js", () => ({
  applyPluginAutoEnable: (...args: Parameters<typeof mocks.applyPluginAutoEnable>) =>
    mocks.applyPluginAutoEnable(...args),
}));

vi.mock("../channels/config-presence.js", () => ({
  listExplicitlyDisabledChannelIdsForConfig: (
    ...args: Parameters<typeof mocks.listExplicitlyDisabledChannelIdsForConfig>
  ) => mocks.listExplicitlyDisabledChannelIdsForConfig(...args),
  listPotentialConfiguredChannelIds: (
    ...args: Parameters<typeof mocks.listPotentialConfiguredChannelIds>
  ) => mocks.listPotentialConfiguredChannelIds(...args),
  listPotentialConfiguredChannelPresenceSignals: () => [
    { channelId: "credential-only", source: "persisted-auth" },
  ],
}));

vi.mock("./channel-presence-policy.js", () => ({
  listExplicitConfiguredChannelIdsForConfig: () => [],
}));

vi.mock("./channel-plugin-ids.js", () => ({
  listExplicitConfiguredChannelIdsForConfig: (
    ...args: Parameters<typeof mocks.listExplicitConfiguredChannelIdsForConfig>
  ) => mocks.listExplicitConfiguredChannelIdsForConfig(...args),
  loadGatewayStartupPluginPlan: (...args: Parameters<typeof mocks.loadGatewayStartupPluginPlan>) =>
    mocks.loadGatewayStartupPluginPlan(...args),
  resolveConfiguredChannelPluginIds: (
    ...args: Parameters<typeof mocks.resolveConfiguredChannelPluginIds>
  ) => mocks.resolveConfiguredChannelPluginIds(...args),
}));

vi.mock("./manifest-contract-eligibility.js", () => ({
  loadManifestMetadataSnapshot: (...args: Parameters<typeof mocks.loadManifestMetadataSnapshot>) =>
    mocks.loadManifestMetadataSnapshot(...args),
}));

vi.mock("./manifest-owner-policy.js", () => ({
  passesManifestOwnerBasePolicy: (
    ...args: Parameters<typeof mocks.passesManifestOwnerBasePolicy>
  ) => mocks.passesManifestOwnerBasePolicy(...args),
}));

import { resolveEffectivePluginIds } from "./effective-plugin-ids.js";
import { collectConfiguredStartupChannelIds } from "./gateway-startup-plugin-config.js";

function resolve(config: OpenClawConfig): string[] {
  return resolveEffectivePluginIds({
    config,
    env: {},
    workspaceDir: "/workspace",
  });
}

describe("resolveEffectivePluginIds", () => {
  beforeEach(() => {
    mocks.applyPluginAutoEnable.mockReset();
    mocks.listExplicitlyDisabledChannelIdsForConfig.mockReset();
    mocks.listPotentialConfiguredChannelIds.mockReset();
    mocks.listExplicitConfiguredChannelIdsForConfig.mockReset();
    mocks.loadGatewayStartupPluginPlan.mockReset();
    mocks.resolveConfiguredChannelPluginIds.mockReset();
    mocks.loadManifestMetadataSnapshot.mockReset();
    mocks.passesManifestOwnerBasePolicy.mockReset();

    mocks.applyPluginAutoEnable.mockImplementation((params) => ({
      config: params.config ?? {},
      changes: [],
      autoEnabledReasons: {},
    }));
    mocks.listExplicitlyDisabledChannelIdsForConfig.mockReturnValue([]);
    mocks.listPotentialConfiguredChannelIds.mockReturnValue([]);
    mocks.listExplicitConfiguredChannelIdsForConfig.mockReturnValue([]);
    mocks.loadGatewayStartupPluginPlan.mockReturnValue({
      channelPluginIds: [],
      pluginIds: [],
    });
    mocks.resolveConfiguredChannelPluginIds.mockReturnValue([]);
    mocks.loadManifestMetadataSnapshot.mockReturnValue(createPluginMetadataSnapshotFixture());
    mocks.passesManifestOwnerBasePolicy.mockReturnValue(true);
  });

  it("uses persisted auth for migration discovery but never activation", () => {
    mocks.listExplicitlyDisabledChannelIdsForConfig.mockReturnValue(["credential-only"]);
    mocks.listPotentialConfiguredChannelIds.mockImplementation((_config, _env, options) =>
      options?.includePersistedAuthState ? ["credential-only"] : [],
    );
    const collect = (includePersistedAuthState = false) =>
      collectConfiguredStartupChannelIds({
        config: {},
        activationSourceConfig: {},
        env: {},
        ...(includePersistedAuthState ? { includePersistedAuthState: true } : {}),
      });
    expect(collect()).toEqual([]);
    expect(collect(true)).toEqual(["credential-only"]);
  });

  it("includes a selected context-engine slot even when omitted from explicit allow and entries", () => {
    expect(
      resolve({
        plugins: {
          slots: { contextEngine: "lossless-claw" },
        },
      }),
    ).toEqual(["lossless-claw"]);
  });

  it("keeps the selected slot but rechecks bundled owner policy after channel callbacks", async () => {
    const { passesManifestOwnerBasePolicy } = await vi.importActual<
      typeof import("./manifest-owner-policy.js")
    >("./manifest-owner-policy.js");
    mocks.passesManifestOwnerBasePolicy.mockImplementation(passesManifestOwnerBasePolicy);
    mocks.listPotentialConfiguredChannelIds.mockReturnValue(["test-channel"]);
    mocks.loadManifestMetadataSnapshot.mockReturnValue(
      createPluginMetadataSnapshotFixture({
        plugins: [{ id: "bundled-channel-owner", channels: ["test-channel"] }],
      }),
    );
    mocks.resolveConfiguredChannelPluginIds.mockImplementation(({ config }) => {
      config.plugins = {
        deny: ["bundled-channel-owner"],
        slots: { contextEngine: "later-context" },
      };
      return [];
    });

    expect(resolve({ plugins: { slots: { contextEngine: "early-context" } } })).toEqual([
      "early-context",
    ]);
  });

  it("keeps the built-in legacy context engine out of plugin preload ids", () => {
    expect(
      resolve({
        plugins: {
          slots: { contextEngine: "legacy" },
        },
      }),
    ).toStrictEqual([]);
  });

  it.each([
    {
      name: "plugins disabled",
      plugins: {
        enabled: false,
        slots: { contextEngine: "lossless-claw" },
      },
    },
    {
      name: "denylisted",
      plugins: {
        deny: ["lossless-claw"],
        slots: { contextEngine: "lossless-claw" },
      },
    },
    {
      name: "entry disabled",
      plugins: {
        entries: {
          "lossless-claw": { enabled: false },
        },
        slots: { contextEngine: "lossless-claw" },
      },
    },
  ] satisfies Array<{ name: string; plugins: NonNullable<OpenClawConfig["plugins"]> }>)(
    "does not preload a selected context-engine slot when $name",
    ({ plugins }) => {
      expect(resolve({ plugins })).toStrictEqual([]);
    },
  );
});
