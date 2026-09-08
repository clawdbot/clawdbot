import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import type { OpenKeyedStoreOptions } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateSyncKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setReefRuntime } from "./runtime.js";
import { reefSetupWizard } from "./setup.js";
import {
  finalizeReefIdentityBinding,
  generateAndStoreKeys,
  loadKeys,
  loadReefIdentityBinding,
  reserveReefIdentityBinding,
} from "./state.js";
import { ReefRelayError, ReefTransportClient } from "./transport.js";

describe("Reef setup wizard identity binding", () => {
  let stateDir = "";

  beforeEach(() => {
    resetPluginStateStoreForTests();
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-reef-setup-"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetPluginStateStoreForTests();
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  function installRuntime() {
    const runtime = createPluginRuntimeMock();
    runtime.state.openSyncKeyedStore = <T>(options: OpenKeyedStoreOptions) =>
      createPluginStateSyncKeyedStoreForTests<T>("reef", {
        ...options,
        env: { OPENCLAW_STATE_DIR: stateDir },
      });
    runtime.state.resolveStateDir = () => stateDir;
    setReefRuntime(runtime);
    return runtime;
  }

  function bindIdentity(runtime: ReturnType<typeof installRuntime>, handle: string): void {
    finalizeReefIdentityBinding(
      runtime,
      reserveReefIdentityBinding(runtime, { handle, relayUrl: "https://reefwire.ai" }),
    );
  }

  it("rejects a different handle before reusing the stored identity keys", async () => {
    const runtime = installRuntime();
    bindIdentity(runtime, "existing");
    const textAnswers = [
      "https://reefwire.ai",
      "owner@example.com",
      "setup-session",
      "replacement",
    ];
    const prompter = {
      note: vi.fn(async () => undefined),
      text: vi.fn(async () => textAnswers.shift() ?? ""),
      select: vi.fn(async () => "code-only"),
    };

    await expect(
      reefSetupWizard.configureInteractive({ cfg: {}, prompter: prompter as never }),
    ).rejects.toThrow("already holds the Reef identity @existing");
  });

  it("persists the identity binding immediately after claiming the handle", async () => {
    const runtime = installRuntime();
    await generateAndStoreKeys(runtime);
    vi.spyOn(ReefTransportClient.prototype, "createHandle").mockResolvedValue({
      handle: "molty",
      key_epoch: 1,
    });
    const textAnswers = [
      "https://reefwire.ai",
      "owner@example.com",
      "setup-session",
      "molty",
      "gpt-5.6-terra",
      "REEF_GUARD_OPENAI_KEY",
      "reef-v1",
    ];
    const selectAnswers = ["code-only", "openai", "api-key"];
    const prompter = {
      note: vi.fn(async () => undefined),
      text: vi.fn(async () => textAnswers.shift() ?? ""),
      select: vi.fn(async () => selectAnswers.shift()),
    };

    await reefSetupWizard.configureInteractive({ cfg: {}, prompter: prompter as never });

    expect(loadReefIdentityBinding(runtime)).toEqual({
      handle: "molty",
      relayUrl: "https://reefwire.ai",
    });
  });

  const noRuntimePromptCases: Array<{
    name: string;
    cfg: OpenClawConfig;
    runtimeConfigured: boolean;
  }> = [
    { name: "unconfigured runtime", cfg: {}, runtimeConfigured: false },
    {
      name: "inherited Codex runtime",
      runtimeConfigured: true,
      cfg: {
        models: {
          providers: {
            openai: {
              baseUrl: "https://api.openai.com/v1",
              agentRuntime: { id: "codex" },
              models: [],
            },
          },
        },
      } satisfies OpenClawConfig,
    },
    {
      name: "sole agent Codex runtime ahead of shared policy",
      runtimeConfigured: true,
      cfg: {
        agents: {
          defaults: {
            models: { "openai/gpt-5.6-terra": { agentRuntime: { id: "openclaw" } } },
          },
          entries: {
            "guard-owner": {
              models: { "openai/gpt-5.6-terra": { agentRuntime: { id: "codex" } } },
            },
          },
        },
      } satisfies OpenClawConfig,
    },
    {
      name: "explicit system agent Codex runtime ahead of shared policy",
      runtimeConfigured: true,
      cfg: {
        agents: {
          ownership: "explicit",
          defaults: {
            systemAgent: { agentId: "guard-owner" },
            models: { "openai/gpt-5.6-terra": { agentRuntime: { id: "openclaw" } } },
          },
          entries: {
            main: { models: { "openai/gpt-5.6-terra": { agentRuntime: { id: "openclaw" } } } },
            "guard-owner": {
              models: { "openai/gpt-5.6-terra": { agentRuntime: { id: "codex" } } },
            },
          },
        },
      } satisfies OpenClawConfig,
    },
  ];

  it.each(noRuntimePromptCases)(
    "configures host-authorized OAuth without a runtime prompt: $name",
    async ({ cfg: input, runtimeConfigured }) => {
      const cfg: OpenClawConfig = structuredClone(input);
      const original = structuredClone(cfg);
      const runtime = installRuntime();
      await generateAndStoreKeys(runtime);
      vi.spyOn(ReefTransportClient.prototype, "createHandle").mockResolvedValue({
        handle: "molty",
        key_epoch: 1,
      });
      const textAnswers = [
        "https://reefwire.ai",
        "owner@example.com",
        "setup-session",
        "molty",
        "gpt-5.6-terra",
        "openai:work",
        "reef-v1",
      ];
      const selectAnswers = ["code-only", "openai", "oauth"];
      const prompter = {
        note: vi.fn(async () => undefined),
        text: vi.fn(async () => textAnswers.shift() ?? ""),
        select: vi.fn(async () => selectAnswers.shift()),
        confirm: vi.fn(async () => false),
      };

      const result = await reefSetupWizard.configureInteractive({
        cfg,
        prompter: prompter as never,
      });

      expect(result.cfg.channels?.reef?.guard).toEqual({
        provider: "openai",
        authMode: "oauth",
        authProfileId: "openai:work",
        pinnedModel: "gpt-5.6-terra",
        policyVersion: "reef-v1",
        timeoutMs: 120_000,
      });
      expect(result.cfg.plugins?.entries?.reef?.llm).toEqual({
        allowModelOverride: true,
        allowedModels: ["openai/gpt-5.6-terra"],
        allowedCompletionModels: ["openai/gpt-5.6-terra"],
      });
      if (runtimeConfigured) {
        expect(result.cfg.agents).toEqual(original.agents);
        expect(result.cfg.models).toEqual(original.models);
      } else {
        expect(result.cfg.agents?.defaults?.models?.["openai/gpt-5.6-terra"]).toEqual({
          agentRuntime: { id: "codex" },
        });
      }
      expect(JSON.stringify(result.cfg)).not.toContain("apiKeyEnv");
      expect(cfg).toEqual(original);
      expect(prompter.confirm).not.toHaveBeenCalled();
    },
  );

  const runtimePolicyCases: Array<{
    name: string;
    cfg: OpenClawConfig;
    rejection?: string;
  }> = [
    {
      name: "sole agent wildcard",
      cfg: {
        agents: {
          entries: {
            "guard-owner": { models: { "openai/*": { agentRuntime: { id: "openclaw" } } } },
          },
        },
      },
    },
    {
      name: "explicit system agent wildcard",
      cfg: {
        agents: {
          ownership: "explicit",
          defaults: { systemAgent: { agentId: "guard-owner" } },
          entries: {
            main: { models: { "openai/gpt-5.6-terra": { agentRuntime: { id: "codex" } } } },
            "guard-owner": { models: { "openai/*": { agentRuntime: { id: "openclaw" } } } },
          },
        },
      },
    },
    {
      name: "sole agent exact model",
      rejection: "agent-specific runtime policy",
      cfg: {
        agents: {
          entries: {
            "guard-owner": {
              models: { "openai/gpt-5.6-terra": { agentRuntime: { id: "openclaw" } } },
            },
          },
        },
      },
    },
    {
      name: "explicit system agent exact model",
      rejection: "agent-specific runtime policy",
      cfg: {
        agents: {
          ownership: "explicit",
          defaults: { systemAgent: { agentId: "guard-owner" } },
          entries: {
            main: { models: { "openai/gpt-5.6-terra": { agentRuntime: { id: "codex" } } } },
            "guard-owner": {
              models: { "openai/gpt-5.6-terra": { agentRuntime: { id: "openclaw" } } },
            },
          },
        },
      },
    },
    {
      name: "explicit fleet without a system owner",
      rejection: "Multiple agents are configured",
      cfg: {
        agents: {
          ownership: "explicit",
          entries: { main: {}, "guard-owner": {} },
        },
      },
    },
    {
      name: "exact default model",
      cfg: {
        agents: {
          defaults: {
            models: {
              "openai/gpt-5.6-terra": { alias: "reef-guard", agentRuntime: { id: "openclaw" } },
            },
          },
        },
      },
    },
    {
      name: "wildcard default model ahead of provider policy",
      cfg: {
        agents: { defaults: { models: { "openai/*": { agentRuntime: { id: "openclaw" } } } } },
        models: {
          providers: {
            openai: {
              baseUrl: "https://api.openai.com/v1",
              agentRuntime: { id: "codex" },
              models: [],
            },
          },
        },
      },
    },
    {
      name: "provider",
      cfg: {
        models: {
          providers: {
            openai: {
              baseUrl: "https://api.openai.com/v1",
              agentRuntime: { id: "openclaw" },
              models: [],
            },
          },
        },
      },
    },
    {
      name: "provider model ahead of provider policy",
      cfg: {
        models: {
          providers: {
            openai: {
              baseUrl: "https://api.openai.com/v1",
              agentRuntime: { id: "codex" },
              models: [
                {
                  id: "gpt-5.6-terra",
                  name: "Reef guard",
                  reasoning: true,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  maxTokens: 8192,
                  agentRuntime: { id: "openclaw" },
                },
              ],
            },
          },
        },
      },
    },
  ];

  it.each(
    runtimePolicyCases.flatMap(({ name, cfg, rejection }) =>
      (rejection ? [false] : [false, true]).map((accepted) => ({
        name,
        cfg,
        rejection,
        accepted,
      })),
    ),
  )(
    "preserves runtime policy from $name (accepted: $accepted)",
    async ({ cfg: input, accepted, rejection }) => {
      const runtime = installRuntime();
      await generateAndStoreKeys(runtime);
      vi.spyOn(ReefTransportClient.prototype, "createHandle").mockResolvedValue({
        handle: "molty",
        key_epoch: 1,
      });
      const textAnswers = [
        "https://reefwire.ai",
        "owner@example.com",
        "setup-session",
        "molty",
        "gpt-5.6-terra",
        "openai:work",
        "reef-v1",
      ];
      const selectAnswers = ["code-only", "openai", "oauth"];
      const prompter = {
        note: vi.fn(async () => undefined),
        text: vi.fn(async () => textAnswers.shift() ?? ""),
        select: vi.fn(async () => selectAnswers.shift()),
        confirm: vi.fn(async () => accepted),
      };
      const cfg = structuredClone(input);
      const original = structuredClone(cfg);
      const configuring = reefSetupWizard.configureInteractive({
        cfg,
        prompter: prompter as never,
      });

      if (rejection) {
        await expect(configuring).rejects.toThrow(rejection);
        expect(cfg).toEqual(original);
        expect(prompter.confirm).not.toHaveBeenCalled();
        return;
      }
      if (accepted) {
        const result = await configuring;
        expect(
          runtime.modelConfig.resolveModelRuntimePolicy({
            config: result.cfg,
            provider: "openai",
            modelId: "gpt-5.6-terra",
            agentId: result.cfg.agents?.defaults?.systemAgent?.agentId,
          }).policy?.id,
        ).toBe("codex");
        expect(result.cfg.agents).toEqual({
          ...original.agents,
          defaults: {
            ...original.agents?.defaults,
            models: {
              ...original.agents?.defaults?.models,
              "openai/gpt-5.6-terra": {
                ...original.agents?.defaults?.models?.["openai/gpt-5.6-terra"],
                agentRuntime: { id: "codex" },
              },
            },
          },
        });
        expect(result.cfg.models).toEqual(original.models);
      } else {
        await expect(configuring).rejects.toThrow(
          "left openai/gpt-5.6-terra on the openclaw agent runtime",
        );
      }
      expect(cfg).toEqual(original);
      expect(prompter.confirm).toHaveBeenCalledExactlyOnceWith({
        message:
          "openai/gpt-5.6-terra currently uses the openclaw agent runtime. Reef OAuth requires codex; change this shared model runtime?",
        initialValue: false,
      });
    },
  );

  it("releases a reservation after a definitively rejected handle claim", async () => {
    const runtime = installRuntime();
    await generateAndStoreKeys(runtime);
    vi.spyOn(ReefTransportClient.prototype, "createHandle").mockRejectedValue(
      new ReefRelayError(409, "handle_unavailable"),
    );
    vi.spyOn(ReefTransportClient.prototype, "listFriends").mockRejectedValue(
      new ReefRelayError(401, "unknown_handle"),
    );
    const textAnswers = ["https://reefwire.ai", "owner@example.com", "setup-session", "molty"];
    const prompter = {
      note: vi.fn(async () => undefined),
      text: vi.fn(async () => textAnswers.shift() ?? ""),
      select: vi.fn(async () => "code-only"),
    };

    await expect(
      reefSetupWizard.configureInteractive({ cfg: {}, prompter: prompter as never }),
    ).rejects.toThrow("handle_unavailable");
    expect(loadReefIdentityBinding(runtime)).toBeUndefined();
  });

  it("keeps a binding after an ambiguous handle-claim failure", async () => {
    const runtime = installRuntime();
    await generateAndStoreKeys(runtime);
    vi.spyOn(ReefTransportClient.prototype, "createHandle").mockRejectedValue(
      new TypeError("connection reset"),
    );
    const textAnswers = ["https://reefwire.ai", "owner@example.com", "setup-session", "molty"];
    const prompter = {
      note: vi.fn(async () => undefined),
      text: vi.fn(async () => textAnswers.shift() ?? ""),
      select: vi.fn(async () => "code-only"),
    };

    await expect(
      reefSetupWizard.configureInteractive({ cfg: {}, prompter: prompter as never }),
    ).rejects.toThrow("connection reset");
    expect(loadReefIdentityBinding(runtime)).toEqual({
      handle: "molty",
      relayUrl: "https://reefwire.ai",
    });
  });

  it("keeps a binding when an ownership probe fails without proving non-ownership", async () => {
    const runtime = installRuntime();
    await generateAndStoreKeys(runtime);
    vi.spyOn(ReefTransportClient.prototype, "createHandle").mockRejectedValue(
      new ReefRelayError(409, "handle_unavailable"),
    );
    vi.spyOn(ReefTransportClient.prototype, "listFriends").mockRejectedValue(
      new ReefRelayError(401, "invalid_signature"),
    );
    const textAnswers = ["https://reefwire.ai", "owner@example.com", "setup-session", "molty"];
    const prompter = {
      note: vi.fn(async () => undefined),
      text: vi.fn(async () => textAnswers.shift() ?? ""),
      select: vi.fn(async () => "code-only"),
    };

    await expect(
      reefSetupWizard.configureInteractive({ cfg: {}, prompter: prompter as never }),
    ).rejects.toThrow("invalid_signature");
    expect(loadReefIdentityBinding(runtime)).toEqual({
      handle: "molty",
      relayUrl: "https://reefwire.ai",
    });
  });

  it("declares its persistence boundary before writing keys or creating the handle", async () => {
    const runtime = installRuntime();
    const beforePersistentEffect = vi.fn(async () => {
      await expect(loadKeys(runtime)).rejects.toMatchObject({ code: "ENOENT" });
    });
    vi.spyOn(ReefTransportClient.prototype, "createHandle").mockImplementation(async () => {
      expect(beforePersistentEffect).toHaveBeenCalledTimes(1);
      return { handle: "molty", key_epoch: 1 };
    });
    const textAnswers = [
      "https://reefwire.ai",
      "owner@example.com",
      "setup-session",
      "molty",
      "gpt-5.6-terra",
      "REEF_GUARD_OPENAI_KEY",
      "reef-v1",
    ];
    const selectAnswers = ["code-only", "openai", "api-key"];
    const prompter = {
      note: vi.fn(async () => undefined),
      text: vi.fn(async () => textAnswers.shift() ?? ""),
      select: vi.fn(async () => selectAnswers.shift()),
    };

    await reefSetupWizard.configureInteractive({
      cfg: {},
      prompter: prompter as never,
      options: { beforePersistentEffect },
    });

    expect(beforePersistentEffect).toHaveBeenCalledTimes(1);
    await expect(loadKeys(runtime)).resolves.toBeDefined();
  });
});
