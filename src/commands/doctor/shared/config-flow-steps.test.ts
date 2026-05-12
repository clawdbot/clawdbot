import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
import type { DoctorConfigPreflightResult } from "../../doctor-config-preflight.js";

const { migrateLegacyConfigMock, stripUnknownConfigKeysMock } = vi.hoisted(() => ({
  migrateLegacyConfigMock: vi.fn(),
  stripUnknownConfigKeysMock: vi.fn(),
}));

vi.mock("./legacy-config-migrate.js", () => ({
  migrateLegacyConfig: migrateLegacyConfigMock,
}));

vi.mock("../../doctor-config-analysis.js", () => ({
  stripUnknownConfigKeys: stripUnknownConfigKeysMock,
}));

import { applyLegacyCompatibilityStep, applyUnknownConfigKeyStep } from "./config-flow-steps.js";

function createLegacyStepResult(
  snapshot: DoctorConfigPreflightResult["snapshot"],
  doctorFixCommand = "openclaw doctor --fix",
) {
  return applyLegacyCompatibilityStep({
    snapshot,
    state: {
      cfg: {},
      candidate: {},
      pendingChanges: false,
      fixHints: [],
    },
    shouldRepair: false,
    doctorFixCommand,
  });
}

describe("doctor config flow steps", () => {
  beforeEach(() => {
    migrateLegacyConfigMock.mockReset();
    migrateLegacyConfigMock.mockImplementation((config: OpenClawConfig) => ({
      config,
      changes: [],
    }));
    stripUnknownConfigKeysMock.mockReset();
  });

  it("collects legacy compatibility issue lines and preview fix hints", () => {
    migrateLegacyConfigMock.mockReturnValueOnce({
      config: {},
      changes: ["Moved heartbeat → agents.defaults.heartbeat."],
    });

    const result = createLegacyStepResult({
      exists: true,
      parsed: { heartbeat: { enabled: true } },
      legacyIssues: [{ path: "heartbeat", message: "use agents.defaults.heartbeat" }],
      path: "/tmp/config.json",
      valid: true,
      issues: [],
      raw: "{}",
      resolved: {},
      sourceConfig: {},
      config: {},
      runtimeConfig: {},
      warnings: [],
    } satisfies DoctorConfigPreflightResult["snapshot"]);

    expect(result.issueLines).toEqual(["- heartbeat: use agents.defaults.heartbeat"]);
    expect(result.changeLines).not.toStrictEqual([]);
    expect(result.state.fixHints).toStrictEqual([
      'Run "openclaw doctor --fix" to migrate legacy config keys.',
    ]);
    expect(result.state.pendingChanges).toBe(true);
  });

  it("keeps pending repair state for legacy issues even when the snapshot is already normalized", () => {
    const result = createLegacyStepResult({
      exists: true,
      parsed: { talk: { voiceId: "voice-1", modelId: "eleven_v3" } },
      legacyIssues: [
        {
          path: "talk",
          message: "talk.voiceId/talk.voiceAliases/talk.modelId/talk.outputFormat/talk.apiKey",
        },
      ],
      path: "/tmp/config.json",
      valid: true,
      issues: [],
      raw: "{}",
      resolved: {},
      sourceConfig: {},
      config: {},
      runtimeConfig: {},
      warnings: [],
    } satisfies DoctorConfigPreflightResult["snapshot"]);

    expect(result.changeLines).toStrictEqual([]);
    expect(result.state.pendingChanges).toBe(true);
    expect(result.state.fixHints).toStrictEqual([
      'Run "openclaw doctor --fix" to migrate legacy config keys.',
    ]);
  });

  it("commits migration even when post-migration validation has unrelated issues (#76798)", () => {
    const migratedConfig = { agents: { defaults: { model: { primary: "openai/gpt-5.4" } } } };
    migrateLegacyConfigMock.mockReturnValueOnce({
      config: migratedConfig,
      changes: ["Removed agents.defaults.llm; model idle timeout now follows models.providers."],
      partiallyValid: true,
    });

    const result = createLegacyStepResult({
      exists: true,
      parsed: {
        agents: {
          defaults: { llm: { idleTimeoutSeconds: 120 }, model: { primary: "openai/gpt-5.4" } },
        },
        tools: { web: { search: { provider: "brave" } } },
      },
      legacyIssues: [{ path: "agents.defaults.llm", message: "deprecated key" }],
      path: "/tmp/config.json",
      valid: false,
      issues: [
        {
          path: "tools.web.search.provider",
          message: "web_search provider is not available: brave",
        },
      ],
      raw: "{}",
      resolved: {},
      sourceConfig: {},
      config: {},
      runtimeConfig: {},
      warnings: [],
    } satisfies DoctorConfigPreflightResult["snapshot"]);

    expect(result.state.candidate).toEqual(migratedConfig);
    expect(result.state.cfg).toEqual(migratedConfig);
    expect(result.state.pendingChanges).toBe(true);
  });

  it("removes unknown keys and adds preview hint", () => {
    stripUnknownConfigKeysMock.mockReturnValueOnce({
      config: {},
      removed: ["bogus"],
    });

    const result = applyUnknownConfigKeyStep({
      state: {
        cfg: {},
        candidate: { bogus: true } as unknown as OpenClawConfig,
        pendingChanges: false,
        fixHints: [],
      },
      shouldRepair: false,
      doctorFixCommand: "openclaw doctor --fix",
    });

    expect(result.removed).toEqual(["bogus"]);
    expect(result.state.candidate).toStrictEqual({});
    expect(result.state.fixHints).toStrictEqual([
      'Run "openclaw doctor --fix" to remove these keys.',
    ]);
  });

  it("repairs active malformed auth profile metadata after unknown-key cleanup", () => {
    stripUnknownConfigKeysMock.mockReturnValueOnce({
      config: {
        auth: {
          profiles: {
            "openai:default": {},
          },
        },
        models: {
          providers: {
            openai: { apiKey: "${OPENAI_API_KEY}" },
          },
        },
        agents: {
          defaults: {
            model: {
              primary: "anthropic/claude-opus-4-6",
              fallbacks: ["openai/gpt-5.5"],
            },
          },
        },
      },
      removed: ["auth.profiles.openai:default.key"],
    });

    const result = applyUnknownConfigKeyStep({
      state: {
        cfg: {},
        candidate: {
          auth: {
            profiles: {
              "openai:default": { key: "sk-test" },
            },
          },
          models: {
            providers: {
              openai: { apiKey: "${OPENAI_API_KEY}" },
            },
          },
          agents: {
            defaults: {
              model: {
                primary: "anthropic/claude-opus-4-6",
                fallbacks: ["openai/gpt-5.5"],
              },
            },
          },
        } as unknown as OpenClawConfig,
        pendingChanges: false,
        fixHints: [],
      },
      shouldRepair: true,
      doctorFixCommand: "openclaw doctor --fix",
    });

    expect(result.repairs).toEqual([
      "Repaired auth.profiles.openai:default metadata for active openai auth.",
    ]);
    expect(result.state.cfg.auth?.profiles?.["openai:default"]).toEqual({
      provider: "openai",
      mode: "api_key",
    });
  });

  it("keeps valid active auth profile metadata while stripping stale secret fields", () => {
    stripUnknownConfigKeysMock.mockReturnValueOnce({
      config: {
        auth: {
          profiles: {
            "openai:default": { provider: "openai", mode: "api_key" },
          },
        },
        models: {
          providers: {
            openai: { apiKey: "${OPENAI_API_KEY}" },
          },
        },
        agents: {
          defaults: {
            model: {
              fallbacks: ["openai/gpt-5.5"],
            },
          },
        },
      },
      removed: ["auth.profiles.openai:default.key"],
    });

    const result = applyUnknownConfigKeyStep({
      state: {
        cfg: {},
        candidate: {
          auth: {
            profiles: {
              "openai:default": {
                provider: "openai",
                mode: "api_key",
                key: "sk-test",
              },
            },
          },
          models: {
            providers: {
              openai: { apiKey: "${OPENAI_API_KEY}" },
            },
          },
          agents: {
            defaults: {
              model: {
                fallbacks: ["openai/gpt-5.5"],
              },
            },
          },
        } as unknown as OpenClawConfig,
        pendingChanges: false,
        fixHints: [],
      },
      shouldRepair: true,
      doctorFixCommand: "openclaw doctor --fix",
    });

    expect(result.repairs).toStrictEqual([]);
    expect(result.state.cfg.auth?.profiles?.["openai:default"]).toEqual({
      provider: "openai",
      mode: "api_key",
    });
  });

  it("repairs non-default auth profiles for active providers", () => {
    stripUnknownConfigKeysMock.mockReturnValueOnce({
      config: {
        auth: {
          profiles: {
            "openai:work": {},
          },
        },
        agents: {
          defaults: {
            model: {
              fallbacks: ["openai/gpt-5.5"],
            },
          },
        },
      },
      removed: ["auth.profiles.openai:work.key"],
    });

    const result = applyUnknownConfigKeyStep({
      state: {
        cfg: {},
        candidate: {
          auth: {
            profiles: {
              "openai:work": { key: "sk-test" },
            },
          },
          agents: {
            defaults: {
              model: {
                fallbacks: ["openai/gpt-5.5"],
              },
            },
          },
        } as unknown as OpenClawConfig,
        pendingChanges: false,
        fixHints: [],
      },
      shouldRepair: true,
      doctorFixCommand: "openclaw doctor --fix",
    });

    expect(result.repairs).toEqual([
      "Repaired auth.profiles.openai:work metadata for active openai auth.",
    ]);
    expect(result.state.cfg.auth?.profiles?.["openai:work"]).toEqual({
      provider: "openai",
      mode: "api_key",
    });
  });

  it("preserves explicit model auth profile refs during unknown-key cleanup", () => {
    stripUnknownConfigKeysMock.mockReturnValueOnce({
      config: {
        auth: {
          profiles: {
            "openai:default": {},
          },
        },
        agents: {
          defaults: {
            model: {
              primary: "openai/gpt-5.5@openai:default",
            },
          },
        },
      },
      removed: ["auth.profiles.openai:default.key"],
    });

    const result = applyUnknownConfigKeyStep({
      state: {
        cfg: {},
        candidate: {
          auth: {
            profiles: {
              "openai:default": { key: "sk-test" },
            },
          },
          agents: {
            defaults: {
              model: {
                primary: "openai/gpt-5.5@openai:default",
              },
            },
          },
        } as unknown as OpenClawConfig,
        pendingChanges: false,
        fixHints: [],
      },
      shouldRepair: true,
      doctorFixCommand: "openclaw doctor --fix",
    });

    expect(result.state.cfg.auth?.profiles?.["openai:default"]).toEqual({
      provider: "openai",
      mode: "api_key",
    });
  });

  it("infers providers for bare auth profile suffixes", () => {
    stripUnknownConfigKeysMock.mockReturnValueOnce({
      config: {
        auth: {
          profiles: {
            work: {},
          },
        },
        agents: {
          defaults: {
            model: {
              primary: "openai/gpt-5.5@work",
            },
          },
        },
      },
      removed: ["auth.profiles.work.key"],
    });

    const result = applyUnknownConfigKeyStep({
      state: {
        cfg: {},
        candidate: {
          auth: {
            profiles: {
              work: { key: "sk-test" },
            },
          },
          agents: {
            defaults: {
              model: {
                primary: "openai/gpt-5.5@work",
              },
            },
          },
        } as unknown as OpenClawConfig,
        pendingChanges: false,
        fixHints: [],
      },
      shouldRepair: true,
      doctorFixCommand: "openclaw doctor --fix",
    });

    expect(result.warnings).toStrictEqual([]);
    expect(result.state.cfg.auth?.profiles?.work).toEqual({
      provider: "openai",
      mode: "api_key",
    });
  });

  it("protects auth profiles referenced only by channel model overrides", () => {
    stripUnknownConfigKeysMock.mockReturnValueOnce({
      config: {
        auth: {
          profiles: {
            "openai:default": {},
          },
        },
        channels: {
          modelByChannel: {
            slack: {
              C123: "openai/gpt-5.5@openai:default",
            },
          },
        },
      },
      removed: ["auth.profiles.openai:default.key"],
    });

    const result = applyUnknownConfigKeyStep({
      state: {
        cfg: {},
        candidate: {
          auth: {
            profiles: {
              "openai:default": { key: "sk-test" },
            },
          },
          channels: {
            modelByChannel: {
              slack: {
                C123: "openai/gpt-5.5@openai:default",
              },
            },
          },
        } as unknown as OpenClawConfig,
        pendingChanges: false,
        fixHints: [],
      },
      shouldRepair: true,
      doctorFixCommand: "openclaw doctor --fix",
    });

    expect(result.state.cfg.auth?.profiles?.["openai:default"]).toEqual({
      provider: "openai",
      mode: "api_key",
    });
  });
});
