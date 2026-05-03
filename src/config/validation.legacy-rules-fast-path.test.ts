import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LegacyConfigRule } from "./legacy.shared.js";

const { collectChannelLegacyConfigRulesMock, listPluginDoctorLegacyConfigRulesMock } = vi.hoisted(
  () => ({
    collectChannelLegacyConfigRulesMock: vi.fn((): LegacyConfigRule[] => []),
    listPluginDoctorLegacyConfigRulesMock: vi.fn((): LegacyConfigRule[] => []),
  }),
);

vi.mock("../channels/plugins/legacy-config.js", () => ({
  collectChannelLegacyConfigRules: collectChannelLegacyConfigRulesMock,
}));

vi.mock("../plugins/doctor-contract-registry.js", () => ({
  listPluginDoctorLegacyConfigRules: listPluginDoctorLegacyConfigRulesMock,
}));

import { validateConfigObjectRaw } from "./validation.js";

describe("config validation legacy rule loading", () => {
  beforeEach(() => {
    collectChannelLegacyConfigRulesMock.mockReset();
    collectChannelLegacyConfigRulesMock.mockReturnValue([]);
    listPluginDoctorLegacyConfigRulesMock.mockReset();
    listPluginDoctorLegacyConfigRulesMock.mockReturnValue([]);
  });

  it("does not load channel or plugin doctor legacy rules for valid raw config", () => {
    collectChannelLegacyConfigRulesMock.mockReturnValue([
      {
        path: ["channels", "discord", "legacy"],
        message: "legacy discord key",
      },
    ]);

    const result = validateConfigObjectRaw({
      channels: {
        discord: {},
      },
    });

    expect(result.ok).toBe(true);
    expect(collectChannelLegacyConfigRulesMock).not.toHaveBeenCalled();
    expect(listPluginDoctorLegacyConfigRulesMock).not.toHaveBeenCalled();
  });

  it("does not load plugin doctor legacy rules for invalid raw config", () => {
    listPluginDoctorLegacyConfigRulesMock.mockReturnValue([
      {
        path: ["plugins", "entries", "demo", "legacy"],
        message: "legacy demo key",
      },
    ]);

    const result = validateConfigObjectRaw({
      plugins: {
        entries: {
          demo: {
            legacy: true,
          },
        },
      },
    });

    expect(result.ok).toBe(false);
    expect(collectChannelLegacyConfigRulesMock).not.toHaveBeenCalled();
    expect(listPluginDoctorLegacyConfigRulesMock).not.toHaveBeenCalled();
  });

  it("skips enabled-only and empty-config plugin entries", () => {
    const result = validateConfigObjectRaw({
      plugins: {
        entries: {
          anthropic: {
            enabled: true,
          },
          discord: {
            config: {},
            enabled: true,
          },
        },
      },
    });

    expect(result.ok).toBe(true);
    expect(collectChannelLegacyConfigRulesMock).not.toHaveBeenCalled();
    expect(listPluginDoctorLegacyConfigRulesMock).not.toHaveBeenCalled();
  });

  it("does not use touched paths to load doctor rules during raw validation", () => {
    const result = validateConfigObjectRaw(
      {
        plugins: {
          entries: {
            demo: {},
            other: {},
          },
        },
      },
      {
        touchedPaths: [["plugins", "entries", "demo", "enabled"]],
      },
    );

    expect(result.ok).toBe(true);
    expect(collectChannelLegacyConfigRulesMock).not.toHaveBeenCalled();
    expect(listPluginDoctorLegacyConfigRulesMock).not.toHaveBeenCalled();
  });
});
