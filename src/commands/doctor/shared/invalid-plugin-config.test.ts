import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";

const validationMocks = vi.hoisted(() => ({
  validateConfigObjectWithPlugins: vi.fn(),
}));

vi.mock("../../../config/validation.js", () => ({
  validateConfigObjectWithPlugins: validationMocks.validateConfigObjectWithPlugins,
}));

const { maybeRepairInvalidPluginConfig } = await import("./invalid-plugin-config.js");

describe("doctor invalid plugin config repair", () => {
  beforeEach(() => {
    validationMocks.validateConfigObjectWithPlugins.mockReset();
  });

  it("disables plugins and removes invalid config payloads", () => {
    validationMocks.validateConfigObjectWithPlugins.mockReturnValue({
      ok: false,
      warnings: [],
      issues: [
        {
          path: "plugins.entries.community-feedback.config.communityRepo",
          message: 'invalid config: must match pattern "^[^/]+/[^/]+$"',
        },
      ],
    });

    const result = maybeRepairInvalidPluginConfig({
      plugins: {
        entries: {
          "community-feedback": {
            enabled: true,
            config: {
              communityRepo: "",
            },
          },
          whatsapp: {
            enabled: true,
            config: {
              session: "keep",
            },
          },
        },
      },
    } as OpenClawConfig);

    expect(result.changes).toEqual([
      "- plugins.entries: quarantined 1 invalid plugin config (community-feedback)",
    ]);
    expect(result.config.plugins?.entries?.["community-feedback"]).toEqual({
      enabled: false,
    });
    expect(result.config.plugins?.entries?.whatsapp).toEqual({
      enabled: true,
      config: {
        session: "keep",
      },
    });
  });

  it("handles slash-delimited plugin ids", () => {
    validationMocks.validateConfigObjectWithPlugins.mockReturnValue({
      ok: false,
      warnings: [],
      issues: [
        {
          path: "plugins.entries.pack/one.config.repo",
          message: "invalid config: must NOT have fewer than 1 characters",
        },
      ],
    });

    const result = maybeRepairInvalidPluginConfig({
      plugins: {
        entries: {
          "pack/one": {
            config: {
              repo: "",
            },
          },
        },
      },
    } as OpenClawConfig);

    expect(result.config.plugins?.entries?.["pack/one"]).toEqual({
      enabled: false,
    });
  });

  it("disables plugins whose required config payload is missing", () => {
    validationMocks.validateConfigObjectWithPlugins.mockReturnValue({
      ok: false,
      warnings: [],
      issues: [
        {
          path: "plugins.entries.community-feedback.config.communityRepo",
          message: 'invalid config: must have required property "communityRepo"',
        },
      ],
    });

    const result = maybeRepairInvalidPluginConfig({
      plugins: {
        entries: {
          "community-feedback": {
            enabled: true,
            hooks: {
              allowPromptInjection: true,
            },
          },
        },
      },
    } as OpenClawConfig);

    expect(result.changes).toEqual([
      "- plugins.entries: quarantined 1 invalid plugin config (community-feedback)",
    ]);
    expect(result.config.plugins?.entries?.["community-feedback"]).toEqual({
      enabled: false,
      hooks: {
        allowPromptInjection: true,
      },
    });
  });

  it("ignores non-plugin validation issues", () => {
    validationMocks.validateConfigObjectWithPlugins.mockReturnValue({
      ok: false,
      warnings: [],
      issues: [
        {
          path: "gateway.mode",
          message: "Expected 'local' or 'remote'",
        },
      ],
    });
    const cfg = {
      gateway: {
        mode: "invalid",
      },
    } as unknown as OpenClawConfig;

    expect(maybeRepairInvalidPluginConfig(cfg)).toEqual({ config: cfg, changes: [] });
  });
});
