import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearRuntimeAuthProfileStoreSnapshots } from "../../agents/auth-profiles/runtime-snapshots.js";
import { registerAgentHarness } from "../../agents/harness/registry.js";
import type { AgentHarness } from "../../agents/harness/types.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import {
  getActivePluginRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "../../plugins/runtime.js";
import { resolveSessionWorkerPlacementPatchError } from "../server-methods/sessions-shared.js";
import {
  projectWorkerPlacementAgentRuntime,
  resolveWorkerPlacementCapabilities,
  resolveWorkerPlacementExecutionMode,
  resolveWorkerPlacementSessionRuntime,
  resolveWorkerPlacementSessionRuntimeCapabilities,
} from "./placement-session-runtime.js";

const originalPluginRegistry = getActivePluginRegistry();

describe("worker placement runtime capabilities", () => {
  beforeEach(() => {
    clearRuntimeAuthProfileStoreSnapshots();
    setActivePluginRegistry(createEmptyPluginRegistry(), "placement-runtime-test", "default");
  });

  afterEach(() => {
    clearRuntimeAuthProfileStoreSnapshots();
    if (originalPluginRegistry) {
      setActivePluginRegistry(originalPluginRegistry, "placement-runtime-test-restore", "default");
      return;
    }
    resetPluginRuntimeStateForTest();
  });

  it.each([
    {
      name: "ignores an unlocked historical runtime after selecting a different provider",
      entry: { agentHarnessId: "codex" },
      expected: "openclaw",
    },
    {
      name: "ignores an unlocked historical runtime behind the default override",
      entry: { agentHarnessId: "codex", agentRuntimeOverride: "default" },
      expected: "openclaw",
    },
    {
      name: "preserves locked transcript ownership",
      entry: { agentHarnessId: "codex", modelSelectionLocked: true },
      expected: "codex",
    },
    {
      name: "does not let a historical embedded runtime override a Codex model",
      entry: {
        agentHarnessId: "openclaw",
        providerOverride: "openai",
        modelOverride: "gpt-5.6-sol",
      },
      expected: "codex",
    },
    {
      name: "honors an explicit compatible runtime override",
      entry: {
        agentRuntimeOverride: "codex",
        providerOverride: "openai",
        modelOverride: "gpt-test",
      },
      expected: "codex",
    },
  ])("$name", ({ entry, expected }) => {
    expect(
      resolveWorkerPlacementSessionRuntime({
        cfg: {},
        entry: {
          sessionId: "placement-runtime-session",
          updatedAt: 0,
          providerOverride: "anthropic",
          modelOverride: "claude-test",
          ...entry,
        },
        agentId: "main",
        sessionKey: "agent:main:placement-runtime",
      }),
    ).toBe(expected);
  });

  it.each([
    {
      name: "embedded worker turns support paired devices",
      runtimeId: "openclaw",
      executionMode: "worker-turn",
      devicePlacementSupported: true,
      devicePlacement: { requiredNodeCommands: [], consumesWorkerSlot: true },
    },
    {
      name: "remote execution projects exact device commands without consuming a worker slot",
      runtimeId: "device-harness",
      cloudPlacement: {
        mode: "remote-exec",
        devicePlacement: {
          requiredNodeCommands: ["runtime.exec-server.v1"],
          consumesWorkerSlot: false,
        },
      },
      executionMode: "remote-exec",
      devicePlacementSupported: true,
      devicePlacement: {
        requiredNodeCommands: ["runtime.exec-server.v1"],
        consumesWorkerSlot: false,
      },
    },
    {
      name: "device command requirements are deterministic and deduplicated",
      runtimeId: "ordered-harness",
      cloudPlacement: {
        mode: "remote-exec",
        devicePlacement: {
          requiredNodeCommands: ["runtime.zeta.v1", "runtime.alpha.v1", "runtime.zeta.v1"],
          consumesWorkerSlot: false,
        },
      },
      executionMode: "remote-exec",
      devicePlacementSupported: true,
      devicePlacement: {
        requiredNodeCommands: ["runtime.alpha.v1", "runtime.zeta.v1"],
        consumesWorkerSlot: false,
      },
    },
    {
      name: "cloud-only remote execution does not support paired devices",
      runtimeId: "cloud-harness",
      cloudPlacement: { mode: "remote-exec" },
      executionMode: "remote-exec",
      devicePlacementSupported: false,
    },
    {
      name: "unknown runtimes support no placement",
      runtimeId: "missing-harness",
      executionMode: undefined,
      devicePlacementSupported: false,
    },
  ] as const)("$name", ({ runtimeId, executionMode, devicePlacementSupported, ...declaration }) => {
    if ("cloudPlacement" in declaration) {
      const harness: AgentHarness = {
        id: runtimeId,
        label: runtimeId,
        cloudPlacement: declaration.cloudPlacement,
        supports: () => ({ supported: true }),
        async runAttempt() {
          throw new Error("not used");
        },
      };
      registerAgentHarness(harness);
    }

    expect(resolveWorkerPlacementExecutionMode(runtimeId)).toBe(executionMode);
    expect(resolveWorkerPlacementCapabilities(runtimeId)).toEqual({
      ...(executionMode ? { executionMode } : {}),
      ...("devicePlacement" in declaration ? { devicePlacement: declaration.devicePlacement } : {}),
    });
    expect(resolveWorkerPlacementCapabilities(runtimeId).devicePlacement !== undefined).toBe(
      devicePlacementSupported,
    );
    expect(projectWorkerPlacementAgentRuntime({ id: runtimeId, source: "model" })).toEqual({
      id: runtimeId,
      cloudPlacementSupported: executionMode !== undefined,
      ...(executionMode ? { cloudPlacementExecutionMode: executionMode } : {}),
      ...("devicePlacement" in declaration ? { devicePlacement: declaration.devicePlacement } : {}),
      devicePlacementSupported,
      source: "model",
    });
  });

  it("fails closed when a harness requires more than the bounded command count", () => {
    registerAgentHarness({
      id: "oversized-harness",
      label: "oversized-harness",
      cloudPlacement: {
        mode: "remote-exec",
        devicePlacement: {
          requiredNodeCommands: Array.from({ length: 33 }, (_, index) => `runtime.${index}.v1`),
          consumesWorkerSlot: false,
        },
      },
      supports: () => ({ supported: true }),
      async runAttempt() {
        throw new Error("not used");
      },
    });

    expect(resolveWorkerPlacementCapabilities("oversized-harness").devicePlacement).toBeUndefined();
    expect(
      projectWorkerPlacementAgentRuntime({ id: "oversized-harness", source: "model" }),
    ).toEqual({
      id: "oversized-harness",
      cloudPlacementSupported: true,
      cloudPlacementExecutionMode: "remote-exec",
      devicePlacementSupported: false,
      source: "model",
    });
  });
});

describe("resolveWorkerPlacementSessionRuntimeCapabilities", () => {
  beforeEach(() => {
    clearRuntimeAuthProfileStoreSnapshots();
    setActivePluginRegistry(createEmptyPluginRegistry(), "placement-runtime-test", "default");
  });

  afterEach(() => {
    clearRuntimeAuthProfileStoreSnapshots();
    if (originalPluginRegistry) {
      setActivePluginRegistry(originalPluginRegistry, "placement-runtime-test-restore", "default");
      return;
    }
    resetPluginRuntimeStateForTest();
  });

  it("returns worker-turn for a model with an explicit openclaw runtime policy", () => {
    const caps = resolveWorkerPlacementSessionRuntimeCapabilities({
      cfg: {
        models: {
          providers: {
            anthropic: {
              baseUrl: "https://api.anthropic.example/v1",
              models: [],
              agentRuntime: { id: "openclaw" },
            },
          },
        },
      },
      entry: {
        sessionId: "s1",
        updatedAt: 0,
        providerOverride: "anthropic",
        modelOverride: "claude-test",
      },
      agentId: "main",
      sessionKey: "agent:main:s1",
    });
    expect(caps.executionMode).toBe("worker-turn");
    expect(caps.devicePlacement).toBeDefined();
  });

  it("uses openclaw fallback capabilities for an undetermined (auto) runtime", () => {
    // A provider with no configured runtime policy, no registered harness, and no
    // CLI backend registration resolves to "auto" in projection mode. Canonical
    // execution falls back to the built-in openclaw harness (selection.ts
    // auto_openclaw), so the capabilities mirror that — the guard must not
    // falsely reject a model whose execution will use the placement-capable
    // built-in runtime. (A CLI-backed provider is covered separately below.)
    const caps = resolveWorkerPlacementSessionRuntimeCapabilities({
      cfg: {},
      entry: {
        sessionId: "s2",
        updatedAt: 0,
        providerOverride: "embedded-auto-provider",
        modelOverride: "embedded-auto-model",
      },
      agentId: "main",
      sessionKey: "agent:main:s2",
    });
    expect(caps.executionMode).toBe("worker-turn");
    expect(caps.devicePlacement).toBeDefined();
  });

  it("rejects a CLI-backed provider whose dispatch runs as a local process", () => {
    // The reported #136611 case: Claude CLI is registered as a CLI backend
    // (registerCliBackend), not an agent harness. Its dispatch runs
    // runCliFallbackCandidate locally, so it cannot claim an active cloud
    // worker-turn placement. The guard must reject it via the same
    // CLI-execution classifier the dispatch path uses, instead of misreading
    // the unclaimed "auto" as the built-in openclaw worker-turn runtime.
    const registry = getActivePluginRegistry();
    if (registry) {
      registry.cliBackends.push({
        pluginId: "test-cli-plugin",
        pluginName: "test-cli-plugin",
        backend: { id: "claude-cli", config: { command: "claude" } },
        source: "test",
      });
    }
    const caps = resolveWorkerPlacementSessionRuntimeCapabilities({
      cfg: {},
      entry: {
        sessionId: "s-cli",
        updatedAt: 0,
        providerOverride: "claude-cli",
        modelOverride: "claude-fable-5-1",
      },
      agentId: "main",
      sessionKey: "agent:main:s-cli",
    });
    expect(caps.executionMode).toBeUndefined();
    expect(caps.devicePlacement).toBeUndefined();
  });

  it("honors a non-CLI session runtime override over a CLI-backed provider", () => {
    // P1: when agentRuntimeOverride="openclaw" is active, dispatch skips CLI
    // aliasing and runs the embedded runtime. The guard must agree — the
    // CLI-backed provider must NOT be rejected because the override takes
    // precedence (mirrors agent-runner-fallback-candidate.ts:113-119).
    const registry = getActivePluginRegistry();
    if (registry) {
      registry.cliBackends.push({
        pluginId: "test-cli-plugin",
        pluginName: "test-cli-plugin",
        backend: { id: "claude-cli", config: { command: "claude" } },
        source: "test",
      });
    }
    const caps = resolveWorkerPlacementSessionRuntimeCapabilities({
      cfg: {},
      entry: {
        sessionId: "s-override",
        updatedAt: 0,
        providerOverride: "anthropic",
        modelOverride: "opus-4.7",
        agentRuntimeOverride: "openclaw",
      },
      agentId: "main",
      sessionKey: "agent:main:s-override",
    });
    expect(caps.executionMode).toBe("worker-turn");
  });

  it("passes the selected auth profile to CLI classification — direct-API profile overrides CLI auth order", () => {
    // P1: with CLI-first auth order but an explicit direct-API authProfileOverride,
    // dispatch resolves a non-CLI provider. The guard must pass the profile and
    // not reject (model-runtime-aliases.test.ts:281-290 contract).
    const registry = getActivePluginRegistry();
    if (registry) {
      registry.cliBackends.push({
        pluginId: "test-cli-plugin",
        pluginName: "test-cli-plugin",
        backend: { id: "claude-cli", config: { command: "claude" } },
        source: "test",
      });
    }
    const caps = resolveWorkerPlacementSessionRuntimeCapabilities({
      cfg: {
        auth: {
          order: { anthropic: ["anthropic:claude-cli", "anthropic:api"] },
          profiles: {
            "anthropic:api": { provider: "anthropic", mode: "api_key" },
            "anthropic:claude-cli": { provider: "claude-cli", mode: "oauth" },
          },
        },
      },
      entry: {
        sessionId: "s-auth-direct",
        updatedAt: 0,
        providerOverride: "anthropic",
        modelOverride: "opus-4.7",
        authProfileOverride: "anthropic:api",
      },
      agentId: "main",
      sessionKey: "agent:main:s-auth-direct",
    });
    expect(caps.executionMode).toBe("worker-turn");
  });

  it("rejects when an explicit CLI auth profile overrides a direct-API auth order", () => {
    // P1 reverse: with API-first auth order but an explicit CLI authProfileOverride,
    // dispatch resolves a CLI provider. The guard must reject
    // (model-runtime-aliases.test.ts:292-300 contract).
    const registry = getActivePluginRegistry();
    if (registry) {
      registry.cliBackends.push({
        pluginId: "test-cli-plugin",
        pluginName: "test-cli-plugin",
        backend: { id: "claude-cli", config: { command: "claude" } },
        source: "test",
      });
    }
    const caps = resolveWorkerPlacementSessionRuntimeCapabilities({
      cfg: {
        auth: {
          order: { anthropic: ["anthropic:api"] },
          profiles: {
            "anthropic:api": { provider: "anthropic", mode: "api_key" },
            "anthropic:claude-cli": { provider: "claude-cli", mode: "oauth" },
          },
        },
      },
      entry: {
        sessionId: "s-auth-cli",
        updatedAt: 0,
        providerOverride: "anthropic",
        modelOverride: "opus-4.7",
        authProfileOverride: "anthropic:claude-cli",
      },
      agentId: "main",
      sessionKey: "agent:main:s-auth-cli",
    });
    expect(caps.executionMode).toBeUndefined();
  });

  it("reports remote-exec capabilities for a registered harness via provider policy", () => {
    registerAgentHarness({
      id: "device-harness",
      label: "device-harness",
      cloudPlacement: {
        mode: "remote-exec",
        devicePlacement: {
          requiredNodeCommands: ["runtime.exec-server.v1"],
          consumesWorkerSlot: false,
        },
      },
      supports: () => ({ supported: true }),
      async runAttempt() {
        throw new Error("not used");
      },
    });

    const caps = resolveWorkerPlacementSessionRuntimeCapabilities({
      cfg: {
        models: {
          providers: {
            "device-harness": {
              baseUrl: "https://device-harness.example/v1",
              models: [],
              agentRuntime: { id: "device-harness" },
            },
          },
        },
      },
      entry: {
        sessionId: "s3",
        updatedAt: 0,
        providerOverride: "device-harness",
        modelOverride: "model-x",
      },
      agentId: "main",
      sessionKey: "agent:main:s3",
    });
    expect(caps.executionMode).toBe("remote-exec");
    expect(caps.devicePlacement).toEqual({
      requiredNodeCommands: ["runtime.exec-server.v1"],
      consumesWorkerSlot: false,
    });
  });

  it("resolves a registered auto harness placement capability instead of rejecting auto", () => {
    // When no explicit runtime policy is set, the policy resolves to "auto".
    // A registered harness that supports the model and advertises device
    // placement must be selected — mirroring resolveEffectiveAgentRuntime —
    // so a valid model change is not falsely rejected.
    registerAgentHarness({
      id: "auto-device-harness",
      label: "auto-device-harness",
      cloudPlacement: {
        mode: "remote-exec",
        devicePlacement: {
          requiredNodeCommands: ["runtime.exec-server.v1"],
          consumesWorkerSlot: false,
        },
      },
      supports: () => ({ supported: true }),
      async runAttempt() {
        throw new Error("not used");
      },
    });

    const caps = resolveWorkerPlacementSessionRuntimeCapabilities({
      cfg: {},
      entry: {
        sessionId: "s4",
        updatedAt: 0,
        providerOverride: "auto-provider",
        modelOverride: "auto-model",
      },
      agentId: "main",
      sessionKey: "agent:main:s4",
    });
    expect(caps.executionMode).toBe("remote-exec");
    expect(caps.devicePlacement).toEqual({
      requiredNodeCommands: ["runtime.exec-server.v1"],
      consumesWorkerSlot: false,
    });
  });

  it("falls back to built-in openclaw placement capabilities for an unclaimed auto model", () => {
    // "auto" with no registered supporting harness falls back to the built-in
    // openclaw harness (selection.ts auto_openclaw), which supports worker-turn
    // placement. Rejecting it would block valid model switches for sessions
    // with an active worker placement.
    registerAgentHarness({
      id: "unrelated-harness",
      label: "unrelated-harness",
      cloudPlacement: {
        mode: "remote-exec",
        devicePlacement: {
          requiredNodeCommands: ["runtime.exec-server.v1"],
          consumesWorkerSlot: false,
        },
      },
      supports: () => ({ supported: false }),
      async runAttempt() {
        throw new Error("not used");
      },
    });

    const caps = resolveWorkerPlacementSessionRuntimeCapabilities({
      cfg: {},
      entry: {
        sessionId: "s5",
        updatedAt: 0,
        providerOverride: "unsupported-provider",
        modelOverride: "unsupported-model",
      },
      agentId: "main",
      sessionKey: "agent:main:s5",
    });
    expect(caps.executionMode).toBe("worker-turn");
    expect(caps.devicePlacement).toEqual({
      requiredNodeCommands: [],
      consumesWorkerSlot: true,
    });
  });

  it("sessions.patch boundary: rejects an incompatible model change for an active worker-turn placement", () => {
    // An active worker-turn placement must reject a model whose effective
    // runtime is a CLI harness with no cloud placement support. The harness
    // claims the provider via autoSelection so resolveAutoAgentHarnessId
    // returns it (not the openclaw fallback).
    registerAgentHarness({
      id: "claude-cli",
      label: "claude-cli",
      autoSelection: { providerIds: ["claude-cli"] },
      supports: () => ({ supported: true }),
      async runAttempt() {
        throw new Error("not used");
      },
    });
    const sessionId = "s6";
    const placement = {
      sessionId,
      state: "active" as const,
      executionMode: "worker-turn" as const,
      generation: 1,
      environmentId: "env-1",
      runnerId: "runner-1",
      runnerStatus: "available" as const,
      recoveryError: null,
      terminalReason: null,
      terminalAtMs: null,
      transitionGeneration: 1,
      ownerId: "worker",
      ownerEpoch: 1,
      turnClaim: null,
      workspace: null,
      retirement: null,
      createdAtMs: 0,
      updatedAtMs: 0,
    };
    const context = {
      workerSessionPlacementService: {
        getMany: () => new Map([[sessionId, placement]]),
      },
    };
    const error = resolveSessionWorkerPlacementPatchError({
      agentId: "main",
      cfg: {} as never,
      context: context as never,
      entry: {
        sessionId,
        updatedAt: 0,
        providerOverride: "claude-cli",
        modelOverride: "claude-fable-5-1",
      } as never,
      key: "agent:main:s6",
      patch: { key: "agent:main:s6", model: "claude-cli/claude-fable-5-1" } as never,
      sessionKey: "agent:main:s6",
      validateModelRuntime: true,
    });
    expect(error).toContain("cannot select a runtime without cloud placement support");
  });

  it("sessions.patch boundary: allows a compatible model change for an active worker-turn placement", () => {
    // A model whose runtime supports worker-turn placement must pass the
    // guard without error.
    const sessionId = "s7";
    const placement = {
      sessionId,
      state: "active" as const,
      executionMode: "worker-turn" as const,
      generation: 1,
      environmentId: "env-1",
      runnerId: "runner-1",
      runnerStatus: "available" as const,
      recoveryError: null,
      terminalReason: null,
      terminalAtMs: null,
      transitionGeneration: 1,
      ownerId: "worker",
      ownerEpoch: 1,
      turnClaim: null,
      workspace: null,
      retirement: null,
      createdAtMs: 0,
      updatedAtMs: 0,
    };
    const context = {
      workerSessionPlacementService: {
        getMany: () => new Map([[sessionId, placement]]),
      },
    };
    const error = resolveSessionWorkerPlacementPatchError({
      agentId: "main",
      cfg: {
        models: {
          providers: {
            anthropic: {
              baseUrl: "https://api.anthropic.example/v1",
              models: [],
              agentRuntime: { id: "openclaw" },
            },
          },
        },
      } as never,
      context: context as never,
      entry: {
        sessionId,
        updatedAt: 0,
        providerOverride: "anthropic",
        modelOverride: "claude-test",
      } as never,
      key: "agent:main:s7",
      patch: { key: "agent:main:s7", model: "anthropic/claude-test" } as never,
      sessionKey: "agent:main:s7",
      validateModelRuntime: true,
    });
    expect(error).toBeUndefined();
  });

  it("sessions.patch boundary: allows an unclaimed auto model with openclaw fallback for an active worker-turn placement", () => {
    // An "auto" model with no registered supporting harness falls back to the
    // built-in openclaw runtime, which supports worker-turn placement. The
    // guard must not reject it — this is the compatibility regression fixed
    // in this round (ClawSweeper P1).
    const sessionId = "s8";
    const placement = {
      sessionId,
      state: "active" as const,
      executionMode: "worker-turn" as const,
      generation: 1,
      environmentId: "env-1",
      runnerId: "runner-1",
      runnerStatus: "available" as const,
      recoveryError: null,
      terminalReason: null,
      terminalAtMs: null,
      transitionGeneration: 1,
      ownerId: "worker",
      ownerEpoch: 1,
      turnClaim: null,
      workspace: null,
      retirement: null,
      createdAtMs: 0,
      updatedAtMs: 0,
    };
    const context = {
      workerSessionPlacementService: {
        getMany: () => new Map([[sessionId, placement]]),
      },
    };
    const error = resolveSessionWorkerPlacementPatchError({
      agentId: "main",
      cfg: {} as never,
      context: context as never,
      entry: {
        sessionId,
        updatedAt: 0,
        providerOverride: "some-provider",
        modelOverride: "some-model",
      } as never,
      key: "agent:main:s8",
      patch: { key: "agent:main:s8", model: "some-provider/some-model" } as never,
      sessionKey: "agent:main:s8",
      validateModelRuntime: true,
    });
    expect(error).toBeUndefined();
  });
});
