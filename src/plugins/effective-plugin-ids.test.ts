import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginMetadataSnapshot } from "./plugin-metadata-snapshot.js";

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
      configuredDeferredChannelPluginIds: [],
      pluginIds: [],
    });
    mocks.resolveConfiguredChannelPluginIds.mockReturnValue([]);
    mocks.loadManifestMetadataSnapshot.mockReturnValue({
      plugins: [],
    } as unknown as PluginMetadataSnapshot);
    mocks.passesManifestOwnerBasePolicy.mockReturnValue(true);
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
