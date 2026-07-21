// Chat engine tests: proposals, approvals, and the chat-hosted channel wizard.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  fingerprintAuthProfileCredential,
  fingerprintOpaqueRuntimeOwner,
  fingerprintResolvedProviderAuth,
} from "../agents/execution-auth-binding.js";
import { hashSystemAgentOperation } from "../agents/tools/system-agent-tool.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "../config/types.openclaw.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import { runSystemAgentTurnWithDeps } from "./agent-turn.test-support.js";
import { classifySystemAgentApprovalText } from "./approval-intent.js";
import {
  SystemAgentChatEngine as RuntimeSystemAgentChatEngine,
  type SystemAgentChatEngineOptions,
} from "./chat-engine.js";
import { SystemAgentInferenceUnavailableError } from "./inference-error.js";
import {
  resolveSystemAgentConfiguredRouteFromConfig,
  type SystemAgentConfiguredRoute,
} from "./inference-route.js";
import { createSystemAgentVerifiedInferenceTestFixture } from "./system-agent.test-helpers.js";
import {
  createSystemAgentVerifiedInferenceBinding,
  type SystemAgentVerifiedInferenceBinding,
  type SystemAgentVerifiedInferenceDeps,
} from "./verified-inference.js";

const mocks = vi.hoisted(() => ({
  readConfigFileSnapshot: vi.fn(async () => ({
    exists: true,
    valid: true,
    path: "/tmp/openclaw.json",
    hash: "h",
    config: {},
    sourceConfig: {},
    issues: [],
  })),
  readSetupConfigFileSnapshot: vi.fn(),
  setupChannels: vi.fn(),
  writeWizardConfigFile: vi.fn(),
  runCollectedChannelOnboardingPostWriteHooks: vi.fn(async () => {}),
}));

vi.mock("../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/config.js")>()),
  readConfigFileSnapshot: mocks.readConfigFileSnapshot,
}));

vi.mock("../wizard/setup.shared.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../wizard/setup.shared.js")>()),
  readSetupConfigFileSnapshot: mocks.readSetupConfigFileSnapshot,
  writeWizardConfigFile: mocks.writeWizardConfigFile,
}));

vi.mock("../commands/onboard-channels.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../commands/onboard-channels.js")>()),
  setupChannels: mocks.setupChannels,
  runCollectedChannelOnboardingPostWriteHooks: mocks.runCollectedChannelOnboardingPostWriteHooks,
}));

vi.mock("../plugins/providers.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/providers.js")>()),
  resolveOwningPluginIdsForModelRefs: vi.fn(() => []),
  resolveOwningPluginIdsForProviderRef: vi.fn(() => []),
}));

const tempDirs: string[] = [];

const sharedVerifiedInferenceConfig = {
  agents: {
    list: [
      {
        id: "main",
        default: true,
        agentDir: "/tmp/openclaw-openclaw-chat-engine-agent",
        model: "openai/gpt-5.5",
      },
    ],
  },
  models: {
    providers: {
      openai: {
        baseUrl: "https://api.openai.com/v1",
        apiKey: "test-key",
        auth: "api-key",
        models: [],
      },
    },
  },
} satisfies OpenClawConfig;

let sharedVerifiedInference: SystemAgentVerifiedInferenceBinding | undefined;
let sharedVerifiedInferenceDeps: SystemAgentVerifiedInferenceDeps | undefined;

function useTempStateDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-engine-"));
  tempDirs.push(dir);
  vi.stubEnv("OPENCLAW_STATE_DIR", dir);
  return dir;
}

function configSnapshot(config: OpenClawConfig): ConfigFileSnapshot {
  return {
    exists: true,
    valid: true,
    path: "/tmp/openclaw.json",
    hash: "h",
    raw: null,
    parsed: config,
    config,
    runtimeConfig: config,
    sourceConfig: config,
    resolved: config,
    issues: [],
    warnings: [],
    legacyIssues: [],
  };
}

function testHarnessBinding(route: SystemAgentConfiguredRoute) {
  if (route.runner !== "embedded") {
    return { auth: {}, deps: {} };
  }
  const agentHarnessId =
    route.agentHarnessRuntimeOverride === "auto" ? "openclaw" : route.agentHarnessRuntimeOverride;
  if (agentHarnessId === "openclaw") {
    return { auth: { agentHarnessId }, deps: {} };
  }
  return {
    auth: {
      agentHarnessId,
      runtimeOwnerKind: "plugin-harness" as const,
      runtimeOwnerId: agentHarnessId,
      runtimeArtifactId: `${agentHarnessId}-test-artifact`,
      runtimeArtifactFingerprint: `${agentHarnessId}-test-fingerprint`,
    },
    deps: {
      validateAgentHarnessRuntimeArtifact: vi.fn(async () => true),
    },
  };
}

async function createAmbientVerifiedBinding(config: OpenClawConfig) {
  const route = await resolveSystemAgentConfiguredRouteFromConfig(config);
  if (!route) {
    throw new Error("missing test route");
  }
  const authFingerprint = fingerprintResolvedProviderAuth({
    apiKey: "test-key",
    source: "models.json",
    mode: "api-key",
  });
  if (!authFingerprint) {
    throw new Error("missing test ambient auth fingerprint");
  }
  const harnessBinding = testHarnessBinding(route);
  return await createSystemAgentVerifiedInferenceBinding({
    configuredRoute: route,
    executionRoute: route,
    auth: {
      authFingerprint,
      modelId: route.model,
      modelApi: route.provider === "anthropic" ? "anthropic-messages" : "openai-responses",
      ...harnessBinding.auth,
    },
    deps: harnessBinding.deps,
  });
}

async function createOAuthVerifiedBinding(
  config: OpenClawConfig,
  credential: Parameters<typeof fingerprintAuthProfileCredential>[0]["credential"],
) {
  const route = await resolveSystemAgentConfiguredRouteFromConfig(config);
  if (!route) {
    throw new Error("missing test OAuth route");
  }
  const profileId = "anthropic:oauth";
  const authFingerprint = fingerprintAuthProfileCredential({ profileId, credential });
  if (!authFingerprint) {
    throw new Error("missing test OAuth fingerprint");
  }
  const harnessBinding = testHarnessBinding(route);
  return await createSystemAgentVerifiedInferenceBinding({
    configuredRoute: route,
    executionRoute: route,
    auth: { authProfileId: profileId, authFingerprint, ...harnessBinding.auth },
    deps: {
      ...harnessBinding.deps,
      ensureAuthProfileStore: vi.fn(() => ({
        version: 1,
        profiles: { [profileId]: credential },
      })) as never,
    },
  });
}

async function createCliVerifiedBinding(config: OpenClawConfig) {
  const route = await resolveSystemAgentConfiguredRouteFromConfig(config);
  if (!route || route.runner !== "cli") {
    throw new Error("missing test CLI route");
  }
  const runtimeArtifactId = route.provider;
  const runtimeArtifactFingerprint = `${runtimeArtifactId}-test-artifact`;
  const runtimeOwnerFingerprint = fingerprintOpaqueRuntimeOwner({
    kind: "cli-runtime",
    runner: "cli",
    provider: route.provider,
    backendId: runtimeArtifactId,
    runtimeArtifactFingerprint,
  });
  if (!runtimeOwnerFingerprint) {
    throw new Error("missing test CLI runtime-owner fingerprint");
  }
  const deps: SystemAgentVerifiedInferenceDeps = {
    resolveCliRuntimeArtifactFingerprint: vi.fn(async () => runtimeArtifactFingerprint),
    resolveCliRuntimeOwnerFingerprint: vi.fn(async () => runtimeOwnerFingerprint),
  };
  const binding = await createSystemAgentVerifiedInferenceBinding({
    configuredRoute: route,
    executionRoute: route,
    auth: {
      runtimeOwnerFingerprint,
      runtimeOwnerKind: "cli-runtime",
      runtimeOwnerId: runtimeArtifactId,
      runtimeArtifactId,
      runtimeArtifactFingerprint,
    },
    deps,
  });
  return { binding, deps };
}

type TestSystemAgentChatEngineOptions = Omit<SystemAgentChatEngineOptions, "verifiedInference"> & {
  verifiedInference?: SystemAgentVerifiedInferenceBinding;
};

/** Every ordinary engine test starts from a real, live-gate-shaped authority grant. */
class SystemAgentChatEngine extends RuntimeSystemAgentChatEngine {
  constructor(opts: TestSystemAgentChatEngineOptions = {}) {
    const explicitBinding = opts.verifiedInference;
    const verifiedInference = explicitBinding ?? sharedVerifiedInference;
    if (!verifiedInference) {
      throw new Error("shared verified inference fixture was not initialized");
    }
    if (!sharedVerifiedInferenceDeps) {
      throw new Error("shared verified inference dependencies were not initialized");
    }
    super({
      ...opts,
      verifiedInference,
      deps: {
        ...(explicitBinding
          ? { validateAgentHarnessRuntimeArtifact: async () => true }
          : sharedVerifiedInferenceDeps),
        readConfigFileSnapshot: async () =>
          configSnapshot(structuredClone(sharedVerifiedInferenceConfig)),
        ...opts.deps,
      },
    });
  }
}

beforeAll(async () => {
  const fixture = await createSystemAgentVerifiedInferenceTestFixture(
    sharedVerifiedInferenceConfig,
  );
  sharedVerifiedInference = fixture.binding;
  sharedVerifiedInferenceDeps = fixture.deps;
  mocks.readConfigFileSnapshot.mockResolvedValue(
    configSnapshot(structuredClone(sharedVerifiedInferenceConfig)) as never,
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  mocks.readConfigFileSnapshot.mockResolvedValue(
    configSnapshot(structuredClone(sharedVerifiedInferenceConfig)) as never,
  );
  mocks.readSetupConfigFileSnapshot.mockReset();
  mocks.setupChannels.mockReset();
  mocks.writeWizardConfigFile.mockReset();
  mocks.runCollectedChannelOnboardingPostWriteHooks.mockReset();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("SystemAgentChatEngine", () => {
  it("lets only an operator arm delegated persistent writes", async () => {
    useTempStateDir();
    const operation = { kind: "config-set" as const, path: "gateway.port", value: "19001" };
    const proposalHash = hashSystemAgentOperation(operation);
    const armed: boolean[] = [];
    const runConfigSet = vi.fn(async () => {});
    const engine = new SystemAgentChatEngine({
      operatorApprovalOnly: true,
      runAgentTurn: async (params) => {
        armed.push(params.approvalArmed);
        if (!params.approvalArmed) {
          params.session.proposalRef.current = proposalHash;
          params.session.proposalRef.operation = operation;
          return { text: "Change ready." };
        }
        return {
          text: "Applying.",
          directive: { kind: "approved-operation", operation },
        };
      },
      deps: { runConfigSet, loadOverview: fakeOverviewLoader() },
    });

    await engine.handle("Change port.");
    const agentApproval = await engine.handle("yes");

    expect(agentApproval.text).toContain("Approval pending");
    expect(armed).toEqual([false]);
    expect(runConfigSet).not.toHaveBeenCalled();

    await engine.resolveOperatorApproval("allow-once", proposalHash);

    expect(armed).toEqual([false, true]);
    expect(runConfigSet).toHaveBeenCalledOnce();
  });

  it("refuses a delegated channel-setup directive instead of starting the wizard", async () => {
    useTempStateDir();
    const runChannelSetupWizard = vi.fn(async () => {});
    const engine = new SystemAgentChatEngine({
      operatorApprovalOnly: true,
      runAgentTurn: async () => ({
        text: "Setting up.",
        directive: { kind: "channel-setup", channel: "telegram" },
      }),
      runChannelSetupWizard,
      deps: { loadOverview: fakeOverviewLoader() },
    });

    const reply = await engine.handle("connect telegram");

    expect(reply.text).toContain("human operator");
    expect(reply.action).toBe("none");
    expect(runChannelSetupWizard).not.toHaveBeenCalled();
  });

  it("applies a delegated host proposal without another model turn", async () => {
    useTempStateDir();
    const runAgentTurn = vi.fn(async () => ({ text: "must not run" }));
    const runConfigSet = vi.fn(async () => {});
    const operation = { kind: "config-set" as const, path: "gateway.port", value: "19001" };
    const engine = new SystemAgentChatEngine({
      operatorApprovalOnly: true,
      runAgentTurn,
      deps: { runConfigSet, loadOverview: fakeOverviewLoader() },
    });
    engine.propose(operation);

    const pending = await engine.handle("yes");
    const applied = await engine.resolveOperatorApproval(
      "allow-once",
      hashSystemAgentOperation(operation),
    );

    expect(pending.text).toContain("Approval pending");
    expect(runAgentTurn).not.toHaveBeenCalled();
    expect(runConfigSet).toHaveBeenCalledOnce();
    expect(applied?.text).toContain("[openclaw] done: config.set");
    expect(engine.hasPendingProposal()).toBe(false);
  });

  it("applies a seeded proposal on a bare yes with verified inference", async () => {
    useTempStateDir();
    const runConfigSet = vi.fn(async () => {});
    const engine = new SystemAgentChatEngine({ deps: { runConfigSet } });

    const plan = engine.propose({ kind: "config-set", path: "gateway.port", value: "19001" });
    expect(plan).toContain("gateway.port");
    expect(engine.hasPendingProposal()).toBe(true);

    const reply = await engine.handle("yes");
    expect(runConfigSet).toHaveBeenCalledOnce();
    expect(reply.action).toBe("none");
    expect(reply.text).toContain("[openclaw] done: config.set");
    expect(engine.hasPendingProposal()).toBe(false);
  });

  it("hatches into the agent after a fresh setup applies", async () => {
    useTempStateDir();
    const verifyInferenceConfig = vi.fn(async () => ({
      ok: true as const,
      modelRef: "openai/gpt-5.5",
      latencyMs: 100,
    }));
    const applySetup = vi.fn(async () => ({
      configPath: "/tmp/openclaw.json",
      configHashBefore: "before",
      configHashAfter: "after",
      bootstrapPending: true,
      agentId: "main",
      lines: ["Workspace: /tmp/hatch-work"],
    }));
    const engine = new SystemAgentChatEngine({
      runAgentTurn: async () => null,
      planWithAssistant: async () => null,
      classifyApproval: async ({ message }) => (message === "yes" ? "approve" : "other"),
      deps: {
        applySetup,
        verifyInferenceConfig,
        loadOverview: fakeOverviewLoader({ defaultModel: "openai/gpt-5.5" }),
      },
    });
    engine.propose({ kind: "setup", workspace: "/tmp/hatch-work" });

    const reply = await engine.handle("yes");

    expect(applySetup).toHaveBeenCalledOnce();
    expect(reply.action).toBe("open-tui");
    expect(reply.agentDraft).toBe("hatch");
    expect(reply.handoff).toMatchObject({
      kind: "open-tui",
      workspace: "/tmp/hatch-work",
      agentDraft: "hatch",
    });
    expect(reply.text).toContain("Your agent is hatching");
    expect(reply.text).toContain("Settings → Ask OpenClaw");
  });

  it("hatches into a newly created agent and carries its id", async () => {
    useTempStateDir();
    const createAgent = vi.fn(async () => ({
      status: "created" as const,
      agentId: "researcher",
      name: "researcher",
      workspace: "/tmp/researcher",
      agentDir: "/tmp/agent-researcher",
      bootstrapPending: true,
    }));
    const engine = new SystemAgentChatEngine({
      runAgentTurn: async () => null,
      planWithAssistant: async () => null,
      classifyApproval: async ({ message }) => (message === "yes" ? "approve" : "other"),
      deps: { createAgent, loadOverview: fakeOverviewLoader() },
    });
    engine.propose({ kind: "create-agent", agentId: "researcher" });

    const reply = await engine.handle("yes");

    expect(createAgent).toHaveBeenCalledWith({ name: "researcher" });
    expect(reply.action).toBe("open-tui");
    expect(reply.handoff).toMatchObject({
      kind: "open-tui",
      agentId: "researcher",
      agentDraft: "hatch",
    });
  });

  it("stays in setup when an established workspace has no bootstrap pending", async () => {
    useTempStateDir();
    const applySetup = vi.fn(async () => ({
      configPath: "/tmp/openclaw.json",
      configHashBefore: "before",
      configHashAfter: "after",
      bootstrapPending: false,
      agentId: "main",
      lines: ["Workspace: /tmp/established-work"],
    }));
    const engine = new SystemAgentChatEngine({
      runAgentTurn: async () => null,
      planWithAssistant: async () => null,
      classifyApproval: async ({ message }) => (message === "yes" ? "approve" : "other"),
      deps: {
        applySetup,
        verifyInferenceConfig: vi.fn(async () => ({
          ok: true as const,
          modelRef: "openai/gpt-5.5",
          latencyMs: 100,
        })),
        loadOverview: fakeOverviewLoader({ defaultModel: "openai/gpt-5.5" }),
      },
    });
    engine.propose({ kind: "setup", workspace: "/tmp/established-work" });

    const reply = await engine.handle("yes");

    expect(reply.action).toBe("none");
    expect(reply.agentDraft).toBeUndefined();
    expect(reply.handoff).toBeUndefined();
    expect(reply.text).not.toContain("Your agent is hatching");
  });

  it("stays in setup when post-write verification flags the config", async () => {
    useTempStateDir();
    const verifyInferenceConfig = vi.fn(async () => ({
      ok: true as const,
      modelRef: "openai/gpt-5.5",
      latencyMs: 100,
    }));
    let applied = false;
    const applySetup = vi.fn(async () => {
      applied = true;
      return {
        configPath: "/tmp/openclaw.json",
        configHashBefore: "before",
        configHashAfter: "after",
        bootstrapPending: true,
        agentId: "main",
        lines: ["Workspace: /tmp/hatch-work"],
      };
    });
    // The written config turns out invalid: post-write verification must hold
    // the user in setup instead of hatching into an agent that cannot answer.
    // Reads stay valid through preflight/apply and flip only after the write.
    const validSnapshot = mocks.readConfigFileSnapshot.getMockImplementation()!;
    mocks.readConfigFileSnapshot.mockImplementation(async () => {
      const snapshot = await validSnapshot();
      return applied
        ? ({
            ...snapshot,
            valid: false,
            issues: [{ path: "agents", message: "broken" }],
          } as never)
        : snapshot;
    });
    const engine = new SystemAgentChatEngine({
      runAgentTurn: async () => ({ text: "repair suggestion" }),
      planWithAssistant: async () => null,
      classifyApproval: async ({ message }) => (message === "yes" ? "approve" : "other"),
      deps: {
        applySetup,
        verifyInferenceConfig,
        loadOverview: fakeOverviewLoader({ defaultModel: "openai/gpt-5.5" }),
      },
    });
    engine.propose({ kind: "setup", workspace: "/tmp/hatch-work" });

    const reply = await engine.handle("yes");

    expect(applySetup).toHaveBeenCalledOnce();
    expect(reply.action).toBe("none");
    expect(reply.agentDraft).toBeUndefined();
    expect(reply.handoff).toBeUndefined();
    expect(reply.text).not.toContain("Your agent is hatching");
  });

  it("does not hand off when a non-setup persistent operation applies", async () => {
    useTempStateDir();
    const runConfigSet = vi.fn(async () => {});
    const engine = new SystemAgentChatEngine({ deps: { runConfigSet } });
    engine.propose({ kind: "config-set", path: "gateway.port", value: "19002" });

    const reply = await engine.handle("yes");

    expect(reply.action).toBe("none");
    expect(reply.agentDraft).toBeUndefined();
    expect(reply.handoff).toBeUndefined();
  });

  it("rejects a seeded approval when its binding changes during classification", async () => {
    const baseConfig = {
      agents: { defaults: { model: "openai/gpt-5.5" } },
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            apiKey: "test-key",
            auth: "api-key",
            models: [],
          },
        },
      },
    } satisfies OpenClawConfig;
    const changedConfig = {
      agents: { defaults: { model: "anthropic/claude-opus-4-8" } },
    } satisfies OpenClawConfig;
    const verifiedInference = await createAmbientVerifiedBinding(baseConfig);
    let currentConfig = baseConfig as OpenClawConfig;
    const runConfigSet = vi.fn(async () => {});
    const engine = new SystemAgentChatEngine({
      verifiedInference,
      classifyApproval: async () => {
        currentConfig = changedConfig;
        return "approve";
      },
      deps: {
        readConfigFileSnapshot: vi.fn(async () => configSnapshot(currentConfig)) as never,
        runConfigSet,
      },
    });
    engine.propose({ kind: "config-set", path: "gateway.port", value: "19001" });

    await expect(engine.handle("yes")).rejects.toBeInstanceOf(SystemAgentInferenceUnavailableError);
    expect(runConfigSet).not.toHaveBeenCalled();
  });

  it("rejects a setup write without a verified inference binding", async () => {
    useTempStateDir();
    const applySetup = vi.fn(async () => ({
      configPath: "/tmp/openclaw.json",
      configHashBefore: null,
      configHashAfter: "after",
      bootstrapPending: false,
      agentId: "main",
      lines: ["Workspace: /tmp/work"],
    }));
    expect(
      () =>
        new RuntimeSystemAgentChatEngine({
          surface: "cli",
          runAgentTurn: async () => null,
          planWithAssistant: async () => null,
          deps: {
            applySetup,
            loadOverview: fakeOverviewLoader(),
          },
        } as unknown as SystemAgentChatEngineOptions),
    ).toThrow(SystemAgentInferenceUnavailableError);
    expect(applySetup).not.toHaveBeenCalled();
  });

  it("routes model provider changes out of the active inference session", async () => {
    const engine = new SystemAgentChatEngine({
      surface: "gateway",
      runAgentTurn: async () => null,
      planWithAssistant: async () => null,
      deps: { loadOverview: fakeOverviewLoader() },
    });

    const reply = await engine.handle("configure model provider workspace /tmp/gateway-work");

    expect(reply.action).toBe("none");
    expect(reply.handoff).toBeUndefined();
    expect(reply.sensitive).toBeUndefined();
    expect(reply.text).toContain("replace the inference route powering this session");
    expect(reply.text).toContain("Exit OpenClaw and run `openclaw onboard`");
  });

  it("keeps the current inference route when model provider setup is declined", async () => {
    const engine = new SystemAgentChatEngine();
    engine.propose({ kind: "model-setup" });

    const reply = await engine.handle("not now");

    expect(reply.text).toContain("current inference route is unchanged");
    expect(engine.hasPendingProposal()).toBe(false);
  });

  it("drops the proposal when the user declines", async () => {
    const runConfigSet = vi.fn(async () => {});
    const engine = new SystemAgentChatEngine({ deps: { runConfigSet } });
    engine.propose({ kind: "config-set", path: "gateway.port", value: "19001" });

    const reply = await engine.handle("no thanks");
    expect(runConfigSet).not.toHaveBeenCalled();
    expect(reply.text).toContain("Skipped");
    expect(engine.hasPendingProposal()).toBe(false);
  });

  it("voids an agent-loop proposal on decline and lets the AI acknowledge", async () => {
    let observedProposalOnSecondTurn: string | undefined = "sentinel";
    const runAgentTurn = vi.fn(
      async (params: { session: { proposalRef: { current?: string } } }) => {
        if (runAgentTurn.mock.calls.length === 1) {
          params.session.proposalRef.current = "registered-operation";
          return { text: "I can change that after your approval." };
        }
        observedProposalOnSecondTurn = params.session.proposalRef.current;
        return { text: "Okay, leaving it as is." };
      },
    );
    const engine = new SystemAgentChatEngine({
      runAgentTurn: runAgentTurn as never,
      classifyApproval: async ({ message }) => classifySystemAgentApprovalText(message),
      deps: { loadOverview: fakeOverviewLoader() },
    });

    await engine.handle("change the model");
    const declined = await engine.handle("no thanks");

    // The decline voids the registered hash before the AI turn, so a later
    // generic approval can never arm the stale mutation.
    expect(observedProposalOnSecondTurn).toBeUndefined();
    expect(declined.text).toContain("leaving it as is");
    expect(runAgentTurn).toHaveBeenCalledTimes(2);
  });

  it("hosts a channel setup wizard as chat turns", async () => {
    useTempStateDir();
    const wizardRuns: string[] = [];
    const engine = new SystemAgentChatEngine({
      runAgentTurn: async () => null,
      planWithAssistant: async () => null,
      deps: { loadOverview: fakeOverviewLoader() },
      runChannelSetupWizard: async (channel: string, prompter: WizardPrompter) => {
        wizardRuns.push(channel);
        const token = await prompter.text({ message: "Bot token" });
        wizardRuns.push(`token:${token}`);
        const mode = await prompter.select({
          message: "DM mode",
          options: [
            { value: "pair", label: "Pairing" },
            { value: "open", label: "Open" },
          ],
        });
        wizardRuns.push(`mode:${mode}`);
      },
    });

    // Starting the wizard is not a write: it begins immediately, no approval step.
    const tokenStep = await engine.handle("connect telegram");
    expect(tokenStep.text).toContain("Bot token");
    // Text steps stay prose-only; only closed choices become typed questions.
    expect(tokenStep.question).toBeUndefined();

    const modeStep = await engine.handle("123:abc");
    expect(modeStep.text).toContain("1. Pairing");
    // The awaited select step is mirrored for card-capable clients; labels are
    // the replies parseWizardAnswer accepts.
    expect(modeStep.question).toEqual({
      id: expect.any(String),
      header: "Choose one",
      question: "DM mode",
      options: [{ label: "Pairing" }, { label: "Open" }],
    });

    const done = await engine.handle("Open");
    expect(done.text).toContain("telegram is configured");
    expect(done.question).toBeUndefined();
    expect(wizardRuns).toEqual(["telegram", "token:123:abc", "mode:open"]);
  });

  it("reports hosted channel setup success when audit persistence fails", async () => {
    const appendAuditEntry = vi.fn(async () => {
      throw new Error("audit store is read-only");
    });
    const engine = new SystemAgentChatEngine({
      runAgentTurn: async () => null,
      planWithAssistant: async () => null,
      deps: { loadOverview: fakeOverviewLoader() },
      runChannelSetupWizard: async () => {},
      appendAuditEntry,
    });

    const reply = await engine.handle("connect telegram");

    expect(reply.text).toContain("Done — telegram is configured.");
    expect(reply.text).not.toContain("audit store is read-only");
    expect(appendAuditEntry).toHaveBeenCalledOnce();
  });

  it("recommends the confirm option matching the initial value", async () => {
    let enabled: boolean | undefined;
    const engine = new SystemAgentChatEngine({
      runAgentTurn: async () => null,
      planWithAssistant: async () => null,
      deps: { loadOverview: fakeOverviewLoader() },
      runChannelSetupWizard: async (_channel: string, prompter: WizardPrompter) => {
        enabled = await prompter.confirm({
          message: "Enable delegated auth?",
          initialValue: false,
        });
      },
    });

    const confirmStep = await engine.handle("connect telegram");

    expect(confirmStep.question).toEqual({
      id: expect.any(String),
      header: "Confirm",
      question: "Enable delegated auth?",
      options: [
        { label: "Yes", reply: "yes" },
        { label: "No", reply: "no", recommended: true },
      ],
    });

    await engine.handle("no");
    expect(enabled).toBe(false);

    const defaultEngine = new SystemAgentChatEngine({
      runAgentTurn: async () => null,
      planWithAssistant: async () => null,
      deps: { loadOverview: fakeOverviewLoader() },
      runChannelSetupWizard: async (_channel: string, prompter: WizardPrompter) => {
        await prompter.confirm({ message: "Continue?" });
      },
    });

    const defaultConfirmStep = await defaultEngine.handle("connect telegram");

    expect(defaultConfirmStep.question?.options).toEqual([
      { label: "Yes", reply: "yes", recommended: true },
      { label: "No", reply: "no" },
    ]);
    await defaultEngine.handle("yes");
  });

  it("rejects non-decimal menu numbers in hosted wizard choices", async () => {
    useTempStateDir();
    const runs: unknown[] = [];
    const engine = new SystemAgentChatEngine({
      runAgentTurn: async () => null,
      planWithAssistant: async () => null,
      deps: { loadOverview: fakeOverviewLoader() },
      runChannelSetupWizard: async (_channel, prompter) => {
        runs.push(
          await prompter.select({
            message: "DM mode",
            options: [
              { value: "pair", label: "Pairing" },
              { value: "open", label: "Open" },
            ],
          }),
        );
        runs.push(
          await prompter.multiselect({
            message: "Features",
            options: [
              { value: "alerts", label: "Alerts" },
              { value: "logs", label: "Logs" },
            ],
          }),
        );
      },
    });
    expect((await engine.handle("connect telegram")).text).toContain("1. Pairing");
    expect((await engine.handle("1e0")).text).toContain("I could not match that answer.");
    expect(runs).toEqual([]);
    expect((await engine.handle("1")).text).toContain("1. Alerts");
    expect((await engine.handle("0x1")).text).toContain("I could not match that answer.");
    expect(await engine.handle("1,2")).toHaveProperty(
      "text",
      expect.stringContaining("telegram is configured"),
    );
    expect(runs).toEqual(["pair", ["alerts", "logs"]]);
  });

  it("rejects a hosted channel commit after a concurrent inference-route change", async () => {
    useTempStateDir();
    const baseConfig: OpenClawConfig = {
      agents: { defaults: { model: { primary: "openai/gpt-5.5" } } },
      auth: {
        profiles: { "openai:main": { provider: "openai", mode: "api_key" } },
      },
    };
    let currentConfig = structuredClone(baseConfig);
    let currentHash = "base-hash";
    mocks.readSetupConfigFileSnapshot.mockImplementation(async () => ({
      exists: true,
      valid: true,
      path: "/tmp/openclaw.json",
      hash: currentHash,
      config: structuredClone(currentConfig),
      sourceConfig: structuredClone(currentConfig),
      issues: [],
    }));
    mocks.setupChannels.mockImplementation(
      async (config: OpenClawConfig, _runtime: unknown, prompter: WizardPrompter) => {
        const token = await prompter.text({ message: "Bot token" });
        return {
          ...config,
          channels: {
            ...config.channels,
            telegram: { botToken: token },
          },
        };
      },
    );
    mocks.writeWizardConfigFile.mockImplementation(
      async (nextConfig: OpenClawConfig, opts: { baseHash?: string }) => {
        if (opts.baseHash !== currentHash) {
          throw new Error("configuration changed during channel setup");
        }
        currentConfig = structuredClone(nextConfig);
        currentHash = "committed-hash";
        return nextConfig;
      },
    );
    const engine = new SystemAgentChatEngine({
      surface: "gateway",
      runAgentTurn: async () => null,
      planWithAssistant: async () => null,
      deps: { loadOverview: fakeOverviewLoader() },
    });

    const tokenStep = await engine.handle("connect telegram");
    expect(tokenStep.text).toContain("Bot token");

    const concurrentConfig: OpenClawConfig = {
      agents: { defaults: { model: { primary: "anthropic/claude-opus-4-8" } } },
      auth: {
        profiles: { "anthropic:main": { provider: "anthropic", mode: "api_key" } },
      },
    };
    currentConfig = structuredClone(concurrentConfig);
    currentHash = "concurrent-hash";

    const stopped = await engine.handle("123:abc");

    expect(stopped.text).toContain("Channel setup stopped");
    expect(stopped.text).toContain("configuration changed during channel setup");
    expect(mocks.writeWizardConfigFile).toHaveBeenCalledWith(
      expect.objectContaining({
        channels: expect.objectContaining({ telegram: { botToken: "123:abc" } }),
      }),
      expect.objectContaining({
        baseHash: "base-hash",
        migrationBaseConfig: baseConfig,
      }),
    );
    expect(currentConfig).toEqual(concurrentConfig);
  });

  it("rechecks inference authority immediately before a hosted channel write", async () => {
    useTempStateDir();
    const baseConfig: OpenClawConfig = {
      agents: { defaults: { model: { primary: "openai/gpt-5.5" } } },
      auth: { profiles: { "openai:main": { provider: "openai", mode: "api_key" } } },
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            apiKey: "test-key",
            auth: "api-key",
            models: [],
          },
        },
      },
    };
    const changedConfig: OpenClawConfig = {
      agents: { defaults: { model: { primary: "anthropic/claude-opus-4-8" } } },
    };
    const verifiedInference = await createAmbientVerifiedBinding(baseConfig);
    let currentConfig = structuredClone(baseConfig);
    mocks.readSetupConfigFileSnapshot.mockResolvedValue({
      exists: true,
      valid: true,
      path: "/tmp/openclaw.json",
      hash: "base-hash",
      config: structuredClone(baseConfig),
      sourceConfig: structuredClone(baseConfig),
      issues: [],
    });
    mocks.setupChannels.mockImplementation(
      async (config: OpenClawConfig, _runtime: unknown, prompter: WizardPrompter) => {
        const token = await prompter.text({ message: "Bot token" });
        currentConfig = structuredClone(changedConfig);
        return {
          ...config,
          channels: { telegram: { botToken: token } },
        };
      },
    );
    mocks.writeWizardConfigFile.mockImplementation(async (config: OpenClawConfig) => config);
    const engine = new SystemAgentChatEngine({
      surface: "gateway",
      verifiedInference,
      runAgentTurn: async () => null,
      planWithAssistant: async () => null,
      deps: {
        loadOverview: fakeOverviewLoader(),
        readConfigFileSnapshot: vi.fn(async () => configSnapshot(currentConfig)) as never,
      },
    });

    const tokenStep = await engine.handle("connect telegram");
    expect(tokenStep.text).toContain("Bot token");
    const stopped = await engine.handle("123:abc");

    expect(stopped.text).toContain("Channel setup stopped");
    expect(mocks.writeWizardConfigFile).not.toHaveBeenCalled();
    expect(mocks.runCollectedChannelOnboardingPostWriteHooks).not.toHaveBeenCalled();
  });

  it("rechecks inference authority before hosted channel post-write hooks", async () => {
    useTempStateDir();
    const baseConfig: OpenClawConfig = {
      agents: { defaults: { model: { primary: "openai/gpt-5.5" } } },
      auth: { profiles: { "openai:main": { provider: "openai", mode: "api_key" } } },
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            apiKey: "test-key",
            auth: "api-key",
            models: [],
          },
        },
      },
    };
    const changedConfig: OpenClawConfig = {
      agents: { defaults: { model: { primary: "anthropic/claude-opus-4-8" } } },
    };
    const verifiedInference = await createAmbientVerifiedBinding(baseConfig);
    let currentConfig = structuredClone(baseConfig);
    const hook = { channel: "telegram", accountId: "default", run: vi.fn() };
    mocks.readSetupConfigFileSnapshot.mockResolvedValue({
      exists: true,
      valid: true,
      path: "/tmp/openclaw.json",
      hash: "base-hash",
      config: structuredClone(baseConfig),
      sourceConfig: structuredClone(baseConfig),
      issues: [],
    });
    mocks.setupChannels.mockImplementation(
      async (
        config: OpenClawConfig,
        _runtime: unknown,
        prompter: WizardPrompter,
        options: { onPostWriteHook?: (hook: unknown) => void },
      ) => {
        const token = await prompter.text({ message: "Bot token" });
        options.onPostWriteHook?.(hook);
        return {
          ...config,
          channels: { telegram: { botToken: token } },
        };
      },
    );
    mocks.writeWizardConfigFile.mockImplementation(async (config: OpenClawConfig) => {
      currentConfig = structuredClone(changedConfig);
      return config;
    });
    mocks.runCollectedChannelOnboardingPostWriteHooks.mockImplementationOnce(
      async (params?: { beforePersistentEffect?: () => Promise<void> }) => {
        await params?.beforePersistentEffect?.();
      },
    );
    const engine = new SystemAgentChatEngine({
      surface: "gateway",
      verifiedInference,
      runAgentTurn: async () => null,
      planWithAssistant: async () => null,
      deps: {
        loadOverview: fakeOverviewLoader(),
        readConfigFileSnapshot: vi.fn(async () => configSnapshot(currentConfig)) as never,
      },
    });

    const tokenStep = await engine.handle("connect telegram");
    expect(tokenStep.text).toContain("Bot token");
    const stopped = await engine.handle("123:abc");

    expect(stopped.text).toContain("Channel setup stopped");
    expect(mocks.writeWizardConfigFile).toHaveBeenCalledOnce();
    expect(mocks.runCollectedChannelOnboardingPostWriteHooks).toHaveBeenCalledOnce();
    expect(hook.run).not.toHaveBeenCalled();
  });

  it("marks sensitive hosted-wizard replies and auto-advances notes", async () => {
    useTempStateDir();
    const engine = new SystemAgentChatEngine({
      surface: "gateway",
      runAgentTurn: async () => null,
      planWithAssistant: async () => null,
      deps: { loadOverview: fakeOverviewLoader() },
      runChannelSetupWizard: async (_channel: string, prompter: WizardPrompter) => {
        await prompter.note("Before entering the token, open the provider console.");
        await prompter.text({ message: "Bot token", sensitive: true });
      },
    });

    const tokenStep = await engine.handle("connect telegram");

    expect(tokenStep.text).toContain("Before entering the token");
    expect(tokenStep.text).toContain("Bot token");
    expect(tokenStep.sensitive).toBe(true);
    expect(tokenStep.wizardInputPending).toBe(true);
  });

  it("marks a non-card hosted-wizard step as pending input", async () => {
    useTempStateDir();
    const engine = new SystemAgentChatEngine({
      surface: "gateway",
      runAgentTurn: async () => null,
      planWithAssistant: async () => null,
      deps: { loadOverview: fakeOverviewLoader() },
      runChannelSetupWizard: async (_channel: string, prompter: WizardPrompter) => {
        await prompter.text({ message: "Bot label" });
      },
    });

    const textStep = await engine.handle("connect telegram");

    expect(textStep.text).toContain("Bot label");
    expect(textStep.question).toBeUndefined();
    expect(textStep.sensitive).toBeUndefined();
    expect(textStep.wizardInputPending).toBe(true);
  });

  it("routes sensitive CLI wizard prompts to the masked channel setup flow", async () => {
    useTempStateDir();
    const engine = new SystemAgentChatEngine({
      surface: "cli",
      runAgentTurn: async () => null,
      planWithAssistant: async () => null,
      deps: { loadOverview: fakeOverviewLoader() },
      runChannelSetupWizard: async (_channel: string, prompter: WizardPrompter) => {
        await prompter.text({ message: "Bot token", sensitive: true });
      },
    });

    const reply = await engine.handle("connect telegram");

    expect(reply.text).toContain("Sensitive input is not accepted");
    expect(reply.text).toContain("openclaw channels add --channel telegram");
    expect(reply.sensitive).toBeUndefined();

    const handoff = await engine.handle("open channel wizard");
    expect(handoff.action).toBe("open-setup");
    expect(handoff.handoff).toEqual({
      kind: "open-setup",
      target: "channels",
      channel: "telegram",
    });

    const channelRequired = await engine.handle("open channel wizard");
    expect(channelRequired.action).toBe("none");
    expect(channelRequired.text).toContain("Which channel");

    const selectedChannel = await engine.handle("slack");
    expect(selectedChannel.action).toBe("open-setup");
    expect(selectedChannel.handoff).toEqual({
      kind: "open-setup",
      target: "channels",
      channel: "slack",
    });
  });

  it("routes inference setup out of both CLI and gateway sessions", async () => {
    const common = {
      runAgentTurn: async () => null,
      planWithAssistant: async () => null,
      deps: { loadOverview: fakeOverviewLoader() },
    };
    const cli = new SystemAgentChatEngine({ ...common, surface: "cli" });
    for (const command of ["open setup wizard", "open classic wizard"]) {
      const cliReply = await cli.handle(command);
      expect(cliReply.action).toBe("none");
      expect(cliReply.handoff).toBeUndefined();
      expect(cliReply.text).toContain("run `openclaw onboard`");
    }

    const gateway = new SystemAgentChatEngine({ ...common, surface: "gateway" });
    const gatewayReply = await gateway.handle("open setup wizard");
    expect(gatewayReply.action).toBe("none");
    expect(gatewayReply.handoff).toBeUndefined();
    expect(gatewayReply.text).toContain("The app owns the setup screens here");
  });

  it.each([
    { command: "open setup wizard", action: "none" },
    { command: "configure model provider", action: "none" },
  ] as const)(
    "voids stale agent proposals before the exact $command route",
    async ({ command, action }) => {
      const armed: boolean[] = [];
      const runAgentTurn = vi.fn(
        async (params: {
          approvalArmed: boolean;
          session: { proposalRef: { current?: string } };
        }) => {
          armed.push(params.approvalArmed);
          if (armed.length === 1) {
            params.session.proposalRef.current = "stale-operation";
          }
          return { text: "No pending change." };
        },
      );
      const engine = new SystemAgentChatEngine({
        surface: "cli",
        runAgentTurn: runAgentTurn as never,
        classifyApproval: async ({ message }) => classifySystemAgentApprovalText(message),
        deps: { loadOverview: fakeOverviewLoader() },
      });

      await engine.handle("prepare a change for me");
      const handoff = await engine.handle(command);
      await engine.handle("yes");

      expect(handoff.action).toBe(action);
      expect(armed).toEqual([false, false]);
    },
  );

  it("keeps hosted-wizard validation errors on the current prompt", async () => {
    useTempStateDir();
    const engine = new SystemAgentChatEngine({
      runAgentTurn: async () => null,
      planWithAssistant: async () => null,
      deps: { loadOverview: fakeOverviewLoader() },
      runChannelSetupWizard: async (_channel: string, prompter: WizardPrompter) => {
        await prompter.text({
          message: "Port",
          validate: (value) => (value === "18789" ? undefined : "Enter port 18789"),
        });
      },
    });

    const prompt = await engine.handle("connect telegram");
    expect(prompt.text).toContain("Port");
    const invalid = await engine.handle("banana");
    expect(invalid.text).toContain("Enter port 18789");
    expect(invalid.text).toContain("Port");
    const done = await engine.handle("18789");
    expect(done.text).toContain("telegram is configured");
  });

  it("cancels a hosted wizard mid-flight", async () => {
    useTempStateDir();
    const engine = new SystemAgentChatEngine({
      runAgentTurn: async () => null,
      planWithAssistant: async () => null,
      deps: { loadOverview: fakeOverviewLoader() },
      runChannelSetupWizard: async (_channel: string, prompter: WizardPrompter) => {
        await prompter.text({ message: "Bot token" });
      },
    });

    const tokenStep = await engine.handle("connect discord");
    expect(tokenStep.text).toContain("Bot token");

    const cancelled = await engine.handle("cancel");
    expect(cancelled.text).toContain("cancelled");
  });

  it("voids a stale host proposal before an exact wizard, including cancellation", async () => {
    const runConfigSet = vi.fn(async () => {});
    const runAgentTurn = vi.fn(async (params: { approvalArmed: boolean }) => ({
      text: params.approvalArmed ? "unexpected approval" : "No pending change.",
    }));
    const engine = new SystemAgentChatEngine({
      runAgentTurn: runAgentTurn as never,
      classifyApproval: async ({ message }) => classifySystemAgentApprovalText(message),
      runChannelSetupWizard: async (_channel: string, prompter: WizardPrompter) => {
        await prompter.text({ message: "Bot token" });
      },
      deps: { runConfigSet, loadOverview: fakeOverviewLoader() },
    });
    engine.propose({ kind: "config-set", path: "gateway.port", value: "19001" });

    await engine.handle("connect discord");
    const cancelled = await engine.handle("cancel");
    const laterApproval = await engine.handle("yes");

    expect(cancelled.text).toContain("cancelled");
    expect(engine.hasPendingProposal()).toBe(false);
    expect(runConfigSet).not.toHaveBeenCalled();
    expect(runAgentTurn.mock.calls.at(-1)?.[0]?.approvalArmed).toBe(false);
    expect(laterApproval.text).toContain("No pending change");
  });

  it("voids a stale agent proposal after an exact wizard completes", async () => {
    useTempStateDir();
    const armed: boolean[] = [];
    const runAgentTurn = vi.fn(
      async (params: {
        approvalArmed: boolean;
        session: { proposalRef: { current?: string } };
      }) => {
        armed.push(params.approvalArmed);
        if (armed.length === 1) {
          params.session.proposalRef.current = "stale-operation";
        }
        return { text: "No pending change." };
      },
    );
    const engine = new SystemAgentChatEngine({
      runAgentTurn: runAgentTurn as never,
      classifyApproval: async ({ message }) => classifySystemAgentApprovalText(message),
      runChannelSetupWizard: async (_channel: string, prompter: WizardPrompter) => {
        await prompter.text({ message: "Bot token" });
      },
      deps: { loadOverview: fakeOverviewLoader() },
    });

    await engine.handle("prepare a change for me");
    await engine.handle("connect telegram");
    const done = await engine.handle("123:abc");
    await engine.handle("yes");

    expect(done.text).toContain("telegram is configured");
    expect(armed).toEqual([false, false]);
  });

  it("signals the exact agent handoff without an inference turn", async () => {
    const engine = new SystemAgentChatEngine({
      runAgentTurn: async () => null,
      planWithAssistant: async () => null,
      deps: { loadOverview: fakeOverviewLoader() },
    });
    const reply = await engine.handle("talk to agent");
    expect(reply.action).toBe("open-tui");
    expect(reply.handoff?.kind).toBe("open-tui");
  });

  it("handles the exact agent handoff without consulting a usable model", async () => {
    const runAgentTurn = vi.fn(async () => ({ text: "model reply without a directive" }));
    const engine = new SystemAgentChatEngine({
      runAgentTurn,
      deps: { loadOverview: fakeOverviewLoader() },
    });

    const reply = await engine.handle("talk to agent");

    expect(runAgentTurn).not.toHaveBeenCalled();
    expect(reply.action).toBe("open-tui");
    expect(reply.handoff).toEqual({ kind: "open-tui" });
  });

  it("executes an open-tui directive from the agent loop", async () => {
    const engine = new SystemAgentChatEngine({
      runAgentTurn: async () => ({
        text: "Handing you over. *waves claw*",
        directive: { kind: "open-tui" as const, agentId: "work" },
      }),
      deps: { loadOverview: fakeOverviewLoader() },
    });
    const reply = await engine.handle("I want to talk to my work agent now");
    expect(reply.action).toBe("open-tui");
    expect(reply.handoff).toMatchObject({ kind: "open-tui", agentId: "work" });
    expect(reply.text).toContain("Handing you over");
  });

  it("retires an agent proposal before a reusable Gateway handoff", async () => {
    const armed: boolean[] = [];
    let turn = 0;
    const classifyApproval = vi.fn(async ({ message }: { message: string }) =>
      classifySystemAgentApprovalText(message),
    );
    const engine = new SystemAgentChatEngine({
      runAgentTurn: async (params) => {
        turn += 1;
        armed.push(params.approvalArmed);
        if (turn === 1) {
          params.session.proposalRef.current = "stale-operation";
        }
        return turn === 2
          ? {
              text: "Handing you over.",
              directive: { kind: "open-tui" as const, agentId: "work" },
            }
          : { text: "Agent reply." };
      },
      classifyApproval: classifyApproval as never,
      deps: { loadOverview: fakeOverviewLoader() },
    });

    await engine.handle("prepare a change");
    expect((await engine.handle("please hand me back now")).action).toBe("open-tui");
    await engine.handle("yes");

    expect(classifyApproval).toHaveBeenCalledOnce();
    expect(armed).toEqual([false, false, false]);
  });

  it("does not replay a failed host directive through the planner", async () => {
    const planner = vi.fn(async () => ({ reply: "should not run" }));
    const engine = new SystemAgentChatEngine({
      runAgentTurn: async () => ({
        text: "Opening setup.",
        directive: { kind: "channel-setup" as const, channel: "telegram" },
      }),
      planWithAssistant: planner,
      runChannelSetupWizard: async () => {
        throw new Error("wizard exploded");
      },
      deps: { loadOverview: fakeOverviewLoader() },
    });

    const reply = await engine.handle("connect telegram for me");

    expect(reply.text).toContain("wizard exploded");
    expect(planner).not.toHaveBeenCalled();
  });

  it("routes an inference-setup directive out of the agent loop", async () => {
    const engine = new SystemAgentChatEngine({
      surface: "cli",
      runAgentTurn: async () => ({
        text: "Opening the menu wizard.",
        directive: { kind: "open-setup" as const, target: "guided" as const },
      }),
      deps: { loadOverview: fakeOverviewLoader() },
    });
    const reply = await engine.handle("I would rather use menus");
    expect(reply.action).toBe("none");
    expect(reply.handoff).toBeUndefined();
    expect(reply.text).toContain("Opening the menu wizard");
    expect(reply.text).toContain("run `openclaw onboard`");
  });

  it("starts the channel wizard from an agent-loop directive", async () => {
    useTempStateDir();
    const engine = new SystemAgentChatEngine({
      runAgentTurn: async () => ({
        text: "Telegram it is — setup questions follow.",
        directive: { kind: "channel-setup" as const, channel: "telegram" },
      }),
      deps: { loadOverview: fakeOverviewLoader() },
      runChannelSetupWizard: async (_channel: string, prompter: WizardPrompter) => {
        await prompter.text({ message: "Bot token" });
      },
    });
    const reply = await engine.handle("hook me up with telegram please");
    expect(reply.text).toContain("Telegram it is");
    expect(reply.text).toContain("Bot token");
  });

  it("rejects an agent directive when the verified route changes during its turn", async () => {
    const baseConfig = {
      agents: { defaults: { model: "openai/gpt-5.5" } },
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            apiKey: "test-key",
            auth: "api-key",
            models: [],
          },
        },
      },
    } satisfies OpenClawConfig;
    const changedConfig = {
      agents: { defaults: { model: "anthropic/claude-opus-4-8" } },
    } satisfies OpenClawConfig;
    const verifiedInference = await createAmbientVerifiedBinding(baseConfig);
    const readConfigFileSnapshot = vi
      .fn()
      .mockResolvedValueOnce(configSnapshot(baseConfig))
      .mockResolvedValueOnce(configSnapshot(baseConfig))
      .mockResolvedValue(configSnapshot(changedConfig));
    const runChannelSetupWizard = vi.fn(async () => {});
    const engine = new SystemAgentChatEngine({
      verifiedInference,
      runAgentTurn: async () => ({
        text: "Telegram it is.",
        directive: { kind: "channel-setup" as const, channel: "telegram" },
      }),
      deps: {
        readConfigFileSnapshot: readConfigFileSnapshot as never,
        loadOverview: fakeOverviewLoader(),
      },
      runChannelSetupWizard,
    });

    await expect(engine.handle("please connect a messaging channel")).rejects.toBeInstanceOf(
      SystemAgentInferenceUnavailableError,
    );
    expect(runChannelSetupWizard).not.toHaveBeenCalled();
  });

  it("rejects an approved agent operation when OAuth rotates at the persistent-apply boundary", async () => {
    const config = {
      agents: { defaults: { model: "anthropic/claude-opus-4-8@anthropic:oauth" } },
      auth: { profiles: { "anthropic:oauth": { provider: "anthropic", mode: "oauth" } } },
    } satisfies OpenClawConfig;
    let credential = {
      type: "oauth" as const,
      provider: "anthropic",
      access: "access-a",
      refresh: "refresh-a",
      expires: 1,
    };
    const verifiedInference = await createOAuthVerifiedBinding(config, credential);
    const runConfigSet = vi.fn(async () => {});
    let authReads = 0;
    const engine = new SystemAgentChatEngine({
      verifiedInference,
      runAgentTurn: async () => ({
        text: "Applying the approved port change.",
        directive: {
          kind: "approved-operation" as const,
          operation: { kind: "config-set" as const, path: "gateway.port", value: "19001" },
        },
      }),
      deps: {
        readConfigFileSnapshot: vi.fn(async () => configSnapshot(config)) as never,
        ensureAuthProfileStore: vi.fn(() => {
          authReads += 1;
          // Turn start, overview, and post-agent checks see the verified grant.
          // The fourth read is the last-moment guard inside applyPersistentOperation.
          if (authReads === 4) {
            credential = { ...credential, access: "access-b", refresh: "refresh-b" };
          }
          return { version: 1, profiles: { "anthropic:oauth": credential } };
        }) as never,
        runConfigSet,
        loadOverview: fakeOverviewLoader(),
      },
    });

    await expect(engine.handle("yes, apply that exact port change")).rejects.toBeInstanceOf(
      SystemAgentInferenceUnavailableError,
    );
    expect(runConfigSet).not.toHaveBeenCalled();
  });

  it("applies an approved agent operation across a stable-identity OAuth refresh", async () => {
    useTempStateDir();
    const config = {
      agents: { defaults: { model: "anthropic/claude-opus-4-8@anthropic:oauth" } },
      auth: { profiles: { "anthropic:oauth": { provider: "anthropic", mode: "oauth" } } },
    } satisfies OpenClawConfig;
    let credential = {
      type: "oauth" as const,
      provider: "anthropic",
      access: "access-a",
      refresh: "refresh-a",
      expires: 1,
      accountId: "account-1",
    };
    const verifiedInference = await createOAuthVerifiedBinding(config, credential);
    const runConfigSet = vi.fn(async () => {});
    const engine = new SystemAgentChatEngine({
      verifiedInference,
      runAgentTurn: async () => {
        credential = { ...credential, access: "access-b", refresh: "refresh-b", expires: 2 };
        return {
          text: "Applying the approved port change.",
          directive: {
            kind: "approved-operation" as const,
            operation: { kind: "config-set" as const, path: "gateway.port", value: "19001" },
          },
        };
      },
      deps: {
        readConfigFileSnapshot: vi.fn(async () => configSnapshot(config)) as never,
        ensureAuthProfileStore: vi.fn(() => ({
          version: 1,
          profiles: { "anthropic:oauth": credential },
        })) as never,
        runConfigSet,
        loadOverview: fakeOverviewLoader(),
      },
    });

    const reply = await engine.handle("yes, apply that exact port change");

    expect(runConfigSet).toHaveBeenCalledOnce();
    expect(reply.text).toContain("[openclaw] done: config.set");
  });

  it("arms an agent turn when the classifier approves in the user's own words", async () => {
    const armedFlags: boolean[] = [];
    let classifierBinding: SystemAgentVerifiedInferenceBinding | undefined;
    const runAgentTurn = vi.fn(
      async (params: {
        approvalArmed: boolean;
        session: { proposalRef: { current?: string } };
      }) => {
        armedFlags.push(params.approvalArmed);
        params.session.proposalRef.current = "op-hash";
        return { text: "ok" };
      },
    );
    const engine = new SystemAgentChatEngine({
      runAgentTurn: runAgentTurn as never,
      classifyApproval: async ({ message, verifiedInference }) => {
        classifierBinding = verifiedInference;
        return message.includes("sounds great") ? "approve" : "other";
      },
      deps: { loadOverview: fakeOverviewLoader() },
    });

    await engine.handle("switch me to gpt");
    await engine.handle("that sounds great, please");

    expect(armedFlags).toEqual([false, true]);
    expect(classifierBinding).toBe(sharedVerifiedInference);
  });

  it("clears a stale host proposal once the agent loop owns the conversation", async () => {
    const engine = new SystemAgentChatEngine({
      runAgentTurn: async (params) => {
        params.session.proposalRef.current = "agent-proposal";
        return { text: "loop reply" };
      },
      classifyApproval: async () => "other",
      deps: { loadOverview: fakeOverviewLoader() },
    });
    engine.propose({ kind: "config-set", path: "gateway.port", value: "19001" });

    await engine.handle("actually, tell me about workspaces first");

    // A later approval must arm the loop's own proposal, not the stale one.
    expect(engine.hasPendingProposal()).toBe(false);
  });

  it("keeps a host setup proposal when the loop only answers a question", async () => {
    let observedInput = "";
    const engine = new SystemAgentChatEngine({
      runAgentTurn: async (params) => {
        observedInput = params.input;
        return { text: "A workspace is where your agent keeps its project files." };
      },
      classifyApproval: async () => "other",
      deps: { loadOverview: fakeOverviewLoader() },
    });
    engine.propose({
      kind: "setup",
      workspace: "/tmp/work",
      model: "openai/gpt-5.5",
    });

    await engine.handle("what does workspace mean?");

    expect(engine.hasPendingProposal()).toBe(true);
    expect(observedInput).toContain('"model":"openai/gpt-5.5"');
    expect(observedInput).toContain("Keep the verified model");
  });

  it("preserves the verified setup model when planner fallback changes only the workspace", async () => {
    useTempStateDir();
    const verifyInferenceConfig = vi.fn(async () => ({
      ok: true as const,
      modelRef: "openai/gpt-5.5",
      latencyMs: 100,
    }));
    const applySetup = vi.fn(async () => ({
      configPath: "/tmp/openclaw.json",
      configHashBefore: "before",
      configHashAfter: "after",
      bootstrapPending: false,
      agentId: "main",
      lines: ["Workspace: /tmp/new-work"],
    }));
    let pendingOperation = "";
    const engine = new SystemAgentChatEngine({
      runAgentTurn: async () => null,
      planWithAssistant: async (params) => {
        pendingOperation = params.pendingOperation ?? "";
        return {
          reply: "I'll use the new workspace and keep the selected AI route.",
          command: "setup workspace /tmp/new-work",
          modelLabel: "planner",
        };
      },
      classifyApproval: async ({ message }) => (message === "yes" ? "approve" : "other"),
      deps: {
        applySetup,
        verifyInferenceConfig,
        loadOverview: fakeOverviewLoader({ defaultModel: "openai/gpt-5.5" }),
      },
    });
    engine.propose({
      kind: "setup",
      workspace: "/tmp/old-work",
      model: "openai/gpt-5.5",
    });

    const revised = await engine.handle("put the workspace under /tmp/new-work instead");
    expect(revised.text).toContain("Model choice: keep verified default openai/gpt-5.5.");
    expect(pendingOperation).toContain('"model":"openai/gpt-5.5"');

    await engine.handle("yes");

    expect(verifyInferenceConfig).toHaveBeenCalledOnce();
    expect(applySetup).toHaveBeenCalledWith(
      expect.objectContaining({
        workspace: "/tmp/new-work",
        expectedInferenceRoute: expect.objectContaining({
          route: expect.objectContaining({ modelLabel: "openai/gpt-5.5" }),
        }),
      }),
      expect.any(Object),
    );
  });

  it("tells the agent loop when a preserved host proposal was resolved", async () => {
    const observedInputs: string[] = [];
    const runConfigSet = vi.fn(async () => {});
    const engine = new SystemAgentChatEngine({
      runAgentTurn: async (params) => {
        observedInputs.push(params.input);
        return { text: "answer" };
      },
      classifyApproval: async ({ message }) => (message === "yes" ? "approve" : "other"),
      deps: { loadOverview: fakeOverviewLoader(), runConfigSet },
    });
    engine.propose({ kind: "config-set", path: "gateway.port", value: "19001" });

    await engine.handle("why that port?");
    await engine.handle("yes");
    await engine.handle("what next?");

    expect(runConfigSet).toHaveBeenCalledOnce();
    expect(observedInputs).toHaveLength(2);
    expect(observedInputs[1]).toContain("[host-proposal-resolved]");
    expect(observedInputs[1]).toContain("was approved");
  });

  it("keeps a host-resolution marker queued across planner fallback", async () => {
    const observedInputs: string[] = [];
    const runConfigSet = vi.fn(async () => {});
    const runAgentTurn = vi.fn(async (params: { input: string }) => {
      observedInputs.push(params.input);
      return observedInputs.length === 1 ? null : { text: "native reply" };
    });
    const planner = vi.fn(async () => ({ reply: "planner fallback", modelLabel: "planner" }));
    const engine = new SystemAgentChatEngine({
      runAgentTurn: runAgentTurn as never,
      planWithAssistant: planner,
      classifyApproval: async ({ message }) => (message === "yes" ? "approve" : "other"),
      deps: { loadOverview: fakeOverviewLoader(), runConfigSet },
    });
    engine.propose({ kind: "config-set", path: "gateway.port", value: "19001" });

    await engine.handle("yes");
    await engine.handle("what next?");
    await engine.handle("try the native session again");
    await engine.handle("and now?");

    expect(planner).toHaveBeenCalledOnce();
    expect(observedInputs).toHaveLength(3);
    expect(observedInputs[0]).toContain("was approved");
    expect(observedInputs[1]).toContain("was approved");
    expect(observedInputs[2]).not.toContain("host-proposal-resolved");
  });

  it("clears both proposal stores when the agent takes a directive", async () => {
    const armedFlags: boolean[] = [];
    const engine = new SystemAgentChatEngine({
      runAgentTurn: async (params) => {
        armedFlags.push(params.approvalArmed);
        if (armedFlags.length === 1) {
          params.session.proposalRef.current = "agent-proposal";
          return {
            text: "Opening setup.",
            directive: { kind: "open-setup" as const, target: "guided" as const },
          };
        }
        return { text: "No pending change." };
      },
      classifyApproval: async ({ message }) => (message === "yes" ? "approve" : "other"),
      deps: { loadOverview: fakeOverviewLoader() },
    });
    engine.propose({ kind: "config-set", path: "gateway.port", value: "19001" });

    await engine.handle("use the wizard instead");
    await engine.handle("yes");

    expect(engine.hasPendingProposal()).toBe(false);
    expect(armedFlags).toEqual([false, false]);
  });

  it("never injects exact sensitive config JSON into a follow-up model turn", async () => {
    let observedInput = "";
    const secret = "123:very-secret";
    const engine = new SystemAgentChatEngine({
      runAgentTurn: async (params) => {
        observedInput = params.input;
        return { text: "That is the Telegram bot credential." };
      },
      classifyApproval: async () => "other",
      deps: { loadOverview: fakeOverviewLoader(), runConfigSet: vi.fn(async () => {}) },
    });

    await engine.handle(`config set channels.telegram.botToken ${secret}`);
    await engine.handle("what is that setting?");

    expect(observedInput).not.toContain(secret);
    expect(observedInput).toContain("<redacted>");
  });

  it("keeps an exact sensitive config set away from every model path", async () => {
    useTempStateDir();
    const runAgentTurn = vi.fn(async () => ({ text: "should never run" }));
    const planner = vi.fn(async () => ({ reply: "should never run" }));
    const runConfigSet = vi.fn(async () => {});
    const engine = new SystemAgentChatEngine({
      runAgentTurn: runAgentTurn as never,
      planWithAssistant: planner as never,
      deps: { runConfigSet, loadOverview: fakeOverviewLoader() },
    });

    const proposed = await engine.handle("config set channels.telegram.botToken 123:very-secret");

    expect(runAgentTurn).not.toHaveBeenCalled();
    expect(planner).not.toHaveBeenCalled();
    expect(proposed.text).toContain("<redacted>");
    expect(proposed.text).not.toContain("very-secret");
    expect(engine.hasPendingProposal()).toBe(true);

    const applied = await engine.handle("yes");
    expect(runConfigSet).toHaveBeenCalledOnce();
    expect(applied.text).toContain("[openclaw] done: config.set");
  });

  it("redacts sensitive config-set values from the AI-visible history", async () => {
    const planner = vi.fn(async (_params: { history?: Array<{ role: string; text: string }> }) => ({
      reply: "noted",
    }));
    const engine = new SystemAgentChatEngine({
      runAgentTurn: async () => null,
      planWithAssistant: planner as never,
      classifyApproval: async () => "other",
      deps: { loadOverview: fakeOverviewLoader() },
    });

    await engine.handle("config set channels.telegram.botToken 123:very-secret");
    await engine.handle("did that work?");

    const history = planner.mock.calls.at(-1)?.[0]?.history ?? [];
    const userTurns = history.filter((turn) => turn.role === "user").map((turn) => turn.text);
    expect(userTurns.some((text) => text.includes("very-secret"))).toBe(false);
    expect(userTurns.some((text) => text.includes("<redacted secret>"))).toBe(true);
  });

  it("prefers the real agent loop for fuzzy messages", async () => {
    const runAgentTurn = vi.fn(
      async (_params: {
        input: string;
        surface: string;
        approvalArmed: boolean;
        session: { sessionId: string };
      }) => ({
        text: "*click* I checked your shell — all good. Want channels next?",
        modelLabel: "openai/gpt-5.5",
      }),
    );
    const planner = vi.fn(async () => null);
    const engine = new SystemAgentChatEngine({
      runAgentTurn,
      planWithAssistant: planner,
      surface: "gateway",
      deps: { loadOverview: fakeOverviewLoader() },
    });

    const reply = await engine.handle("how is my setup looking?");

    expect(reply.text).toContain("I checked your shell");
    expect(planner).not.toHaveBeenCalled();
    const call = expectDefined(
      runAgentTurn.mock.calls[0],
      "runAgentTurn.mock.calls[0] test invariant",
    )[0];
    expect(call.input).toContain("setup looking");
    expect(call.surface).toBe("gateway");
    // A question is not consent: mutations stay locked for this turn.
    expect(call.approvalArmed).toBe(false);
    expect(call.session.sessionId).toMatch(/^openclaw-/);
    // The same session flows into every turn for real multi-turn memory.
    await engine.handle("and the gateway?");
    expect(runAgentTurn.mock.calls[1]?.[0]).toMatchObject({
      session: { sessionId: call.session.sessionId },
    });
  });

  it("answers fuzzy messages through the system agent with conversation history", async () => {
    const planner = vi.fn(
      async (_params: { input: string; history?: Array<{ role: string; text: string }> }) => ({
        reply: "I'm your system agent. Nothing changes without your yes.",
      }),
    );
    const engine = new SystemAgentChatEngine({
      runAgentTurn: async () => null,
      planWithAssistant: planner,
      deps: { loadOverview: fakeOverviewLoader() },
    });
    engine.noteAssistantMessage("welcome text");

    const reply = await engine.handle("what are you going to do to my machine?");

    expect(reply.text).toContain("system agent");
    expect(reply.action).toBe("none");
    const call = expectDefined(planner.mock.calls[0], "planner.mock.calls[0] test invariant")[0];
    expect(call.input).toContain("machine");
    expect(call.history?.[0]).toEqual({ role: "assistant", text: "welcome text" });
  });

  it("does not expose a custom planner reply after its inference owner drifts", async () => {
    const baseConfig = {
      agents: { defaults: { model: "openai/gpt-5.5" } },
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            apiKey: "test-key",
            auth: "api-key",
            models: [],
          },
        },
      },
    } satisfies OpenClawConfig;
    const changedConfig = {
      agents: { defaults: { model: "anthropic/claude-opus-4-8" } },
    } satisfies OpenClawConfig;
    const verifiedInference = await createAmbientVerifiedBinding(baseConfig);
    let currentConfig: OpenClawConfig = baseConfig;
    const planner = vi.fn(async () => {
      currentConfig = changedConfig;
      return { reply: "stale reply" };
    });
    const engine = new SystemAgentChatEngine({
      verifiedInference,
      runAgentTurn: async () => null,
      planWithAssistant: planner,
      deps: {
        readConfigFileSnapshot: vi.fn(async () => configSnapshot(currentConfig)) as never,
        loadOverview: fakeOverviewLoader(),
      },
    });

    await expect(engine.handle("what should I do next?")).rejects.toBeInstanceOf(
      SystemAgentInferenceUnavailableError,
    );
  });

  it("routes AI-proposed persistent commands through approval with provenance", async () => {
    const planner = vi.fn(async () => ({
      reply: "Let's point your agent at gpt-5.5.",
      command: "set default model openai/gpt-5.5",
      modelLabel: "claude-cli",
    }));
    const engine = new SystemAgentChatEngine({
      runAgentTurn: async () => null,
      planWithAssistant: planner,
      deps: { loadOverview: fakeOverviewLoader() },
    });

    const reply = await engine.handle("actually use an openai model");

    expect(reply.text).toContain("Let's point your agent at gpt-5.5.");
    expect(reply.text).toContain("(claude-cli → `set default model openai/gpt-5.5`)");
    expect(reply.text).toContain("Apply this operation");
    expect(engine.hasPendingProposal()).toBe(true);
  });

  it("rebinds the live conversation after changing its default model", async () => {
    useTempStateDir();
    const baseConfig = structuredClone(sharedVerifiedInferenceConfig);
    const changedConfig = {
      ...baseConfig,
      agents: {
        ...baseConfig.agents,
        list: baseConfig.agents.list.map((agent) => ({ ...agent, model: "openai/gpt-5.6-sol" })),
      },
    } satisfies OpenClawConfig;
    const verifiedInference = await createAmbientVerifiedBinding(baseConfig);
    const reboundInference = await createAmbientVerifiedBinding(changedConfig);
    let currentConfig: OpenClawConfig = baseConfig;
    const executeOperation = vi.fn(async (_operation, runtime, options) => {
      currentConfig = changedConfig;
      options.onVerifiedInferenceChanged?.(reboundInference);
      runtime.log("Default model: openai/gpt-5.6-sol");
      return { applied: true };
    });
    const runAgentTurn = vi.fn(async (params) => {
      if (currentConfig === baseConfig) {
        return null;
      }
      return { text: `using ${params.session.verifiedInference.execution.modelLabel}` };
    });
    const engine = new SystemAgentChatEngine({
      yes: true,
      verifiedInference,
      executeOperation,
      runAgentTurn,
      planWithAssistant: async () => ({
        reply: "Switching models.",
        command: "set default model openai/gpt-5.6-sol",
        modelLabel: "openai/gpt-5.5",
      }),
      deps: {
        readConfigFileSnapshot: vi.fn(async () => configSnapshot(currentConfig)) as never,
        loadOverview: fakeOverviewLoader({ defaultModel: "openai/gpt-5.5" }),
      },
    });

    const changed = await engine.handle("switch models");
    const next = await engine.handle("which model is active now?");

    expect(changed.text).toContain("Default model: openai/gpt-5.6-sol");
    expect(next.text).toBe("using openai/gpt-5.6-sol");
    expect(executeOperation).toHaveBeenCalledOnce();
    expect(runAgentTurn).toHaveBeenLastCalledWith(
      expect.objectContaining({
        session: expect.objectContaining({ verifiedInference: reboundInference }),
      }),
    );
  });

  it("keeps a pending proposal when the user asks a question instead of yes/no", async () => {
    const planner = vi.fn(async (_params: { input: string; pendingOperation?: string }) => ({
      reply: "A workspace is where your agent keeps its files.",
    }));
    const engine = new SystemAgentChatEngine({
      runAgentTurn: async () => null,
      planWithAssistant: planner,
      classifyApproval: async () => "other",
      deps: { loadOverview: fakeOverviewLoader() },
    });
    engine.propose({ kind: "config-set", path: "gateway.port", value: "19001" });

    const reply = await engine.handle("wait, what's a workspace?");

    expect(reply.text).toContain("agent keeps its files");
    expect(engine.hasPendingProposal()).toBe(true);
    const call = expectDefined(planner.mock.calls[0], "planner.mock.calls[0] test invariant")[0];
    expect(call.pendingOperation).toContain("gateway.port");
  });

  it("verifies config after an applied write and drives a self-fix turn", async () => {
    useTempStateDir();
    const planner = vi.fn(async (params: { input: string }) => {
      if (params.input.startsWith("[config-verify]")) {
        return {
          reply: "That port was not a number — here is the fix.",
          command: "config set gateway.port 18789",
          modelLabel: "claude-cli",
        };
      }
      return null;
    });
    // The write flips the config to invalid: every snapshot read after the
    // stubbed set reports validation issues (audit reads happen before/after).
    const runInvalidConfigSet = vi.fn(async () => {
      mocks.readConfigFileSnapshot.mockResolvedValue({
        exists: true,
        valid: false,
        path: "/tmp/openclaw.json",
        hash: "h",
        config: {},
        sourceConfig: {},
        issues: [{ path: "gateway.port", message: "Expected number, received string" }],
      } as never);
    });
    const engine = new SystemAgentChatEngine({
      runAgentTurn: async () => null,
      planWithAssistant: planner as never,
      deps: { runConfigSet: runInvalidConfigSet, loadOverview: fakeOverviewLoader() },
    });
    engine.propose({ kind: "config-set", path: "gateway.port", value: "banana" });

    const reply = await engine.handle("yes");

    expect(reply.text).toContain("failed validation");
    expect(reply.text).toContain("gateway.port: Expected number, received string");
    expect(reply.text).toContain("That port was not a number");
    expect(reply.text).toContain("config set gateway.port 18789");
    // The corrective write is proposed, not auto-applied.
    expect(engine.hasPendingProposal()).toBe(true);
    expect(planner.mock.calls[0]?.[0]?.input).toContain("[config-verify]");
  });

  it("reports an applied invalid write when inference cannot propose a repair", async () => {
    useTempStateDir();
    const runInvalidConfigSet = vi.fn(async () => {
      mocks.readConfigFileSnapshot.mockResolvedValue({
        exists: true,
        valid: false,
        path: "/tmp/openclaw.json",
        hash: "h",
        config: {},
        sourceConfig: {},
        issues: [{ path: "gateway.port", message: "Expected number, received string" }],
      } as never);
    });
    const engine = new SystemAgentChatEngine({
      runAgentTurn: async () => {
        throw new SystemAgentInferenceUnavailableError("agent-turn");
      },
      planWithAssistant: async () => null,
      deps: { runConfigSet: runInvalidConfigSet, loadOverview: fakeOverviewLoader() },
    });
    engine.propose({ kind: "config-set", path: "gateway.port", value: "banana" });

    const reply = await engine.handle("yes");

    expect(runInvalidConfigSet).toHaveBeenCalledOnce();
    expect(reply.text).toContain("failed validation");
    expect(reply.text).toContain("The write was applied");
    expect(reply.text).toContain("openclaw doctor --fix");
  });

  it("warns when an applied write leaves no config to verify", async () => {
    useTempStateDir();
    const runConfigSet = vi.fn(async () => {
      mocks.readConfigFileSnapshot.mockResolvedValue({
        exists: false,
        valid: true,
        path: "/tmp/openclaw.json",
        hash: null,
        config: {},
        sourceConfig: {},
        issues: [],
      } as never);
    });
    const engine = new SystemAgentChatEngine({ deps: { runConfigSet } });
    engine.propose({ kind: "config-set", path: "gateway.port", value: "18789" });

    const reply = await engine.handle("yes");

    expect(runConfigSet).toHaveBeenCalledOnce();
    expect(reply.text).toContain("The write was applied");
    expect(reply.text).toContain("post-write verification is unavailable");
    expect(reply.text).toContain("openclaw.json was not found");
    expect(reply.text).toContain("openclaw doctor --fix");
  });

  it("warns when the applied write cannot be read back for verification", async () => {
    useTempStateDir();
    const validSnapshot = {
      exists: true,
      valid: true,
      path: "/tmp/openclaw.json",
      hash: "h",
      config: {},
      sourceConfig: {},
      issues: [],
    } as never;
    mocks.readConfigFileSnapshot
      .mockResolvedValueOnce(validSnapshot)
      .mockResolvedValueOnce(validSnapshot)
      .mockRejectedValueOnce(new Error("snapshot read failed"));
    const runConfigSet = vi.fn(async () => {});
    const engine = new SystemAgentChatEngine({ deps: { runConfigSet } });
    engine.propose({ kind: "config-set", path: "gateway.port", value: "18789" });

    const reply = await engine.handle("yes");

    expect(runConfigSet).toHaveBeenCalledOnce();
    expect(reply.text).toContain("The write was applied");
    expect(reply.text).toContain("post-write verification is unavailable");
    expect(reply.text).toContain("openclaw.json could not be read");
    expect(reply.text).toContain("openclaw doctor --fix");
  });

  it("stays quiet when the post-write validation passes", async () => {
    useTempStateDir();
    const runConfigSet = vi.fn(async () => {});
    const planner = vi.fn(async () => null);
    const engine = new SystemAgentChatEngine({
      runAgentTurn: async () => null,
      planWithAssistant: planner as never,
      deps: { runConfigSet, loadOverview: fakeOverviewLoader() },
    });
    engine.propose({ kind: "config-set", path: "gateway.port", value: "18789" });

    const reply = await engine.handle("yes");

    expect(reply.text).not.toContain("failed validation");
    expect(planner).not.toHaveBeenCalled();
  });

  it("fails closed when neither inference path is usable", async () => {
    const planner = vi.fn(async () => null);
    const engine = new SystemAgentChatEngine({
      runAgentTurn: async () => null,
      planWithAssistant: planner,
      deps: { loadOverview: fakeOverviewLoader() },
    });

    await expect(engine.handle("please make everything nice")).rejects.toBeInstanceOf(
      SystemAgentInferenceUnavailableError,
    );
  });
});

describe("OpenClaw agent loop backends", () => {
  it("runs a configured claude-cli model through the CLI loop with the ring-zero MCP tool", async () => {
    useTempStateDir();
    const config = {
      agents: {
        defaults: {
          model: { primary: "claude-cli/claude-opus-4-8" },
        },
      },
    } satisfies OpenClawConfig;
    const snapshot = configSnapshot(config);
    const inference = await createCliVerifiedBinding(config);
    const inferenceDeps = {
      ...inference.deps,
      readConfigFileSnapshot: (async () => snapshot) as never,
    };
    const runCliAgent = vi.fn(async (_params: Record<string, unknown>) => ({
      payloads: [{ text: "*click* CLI loop checked your shell." }],
      meta: { agentMeta: { cliSessionBinding: { sessionId: "native-1" } } },
    }));
    const planner = vi.fn(async () => null);
    const engine = new SystemAgentChatEngine({
      verifiedInference: inference.binding,
      runAgentTurn: (params) =>
        runSystemAgentTurnWithDeps(params, {
          ...inferenceDeps,
          runCliAgent: runCliAgent as never,
        }),
      planWithAssistant: planner,
      deps: {
        ...inferenceDeps,
        loadOverview: fakeOverviewLoader({ defaultModel: "claude-cli/claude-opus-4-8" }),
      },
    });

    const reply = await engine.handle("how is my setup looking?");

    expect(reply.text).toContain("CLI loop checked your shell");
    expect(planner).not.toHaveBeenCalled();
    const call = expectDefined(
      runCliAgent.mock.calls[0],
      "runCliAgent.mock.calls[0] test invariant",
    )[0];
    expect(call.provider).toBe("claude-cli");
    expect(call.model).toBe("claude-opus-4-8");
    expect(call.systemAgentTool).toEqual({
      surface: "cli",
      approvalArmed: false,
      proposalRef: {},
      directiveRef: {},
    });
    // CLI harnesses reject toolsAllow; the restriction rides on the MCP config.
    expect(call.toolsAllow).toBeUndefined();
    expect(call.cliSessionBinding).toBeUndefined();
    expect(call.cleanupCliLiveSessionOnRunEnd).toBe(true);

    // The captured native CLI session resumes on the next turn.
    await engine.handle("and the gateway?");
    expect(
      expectDefined(runCliAgent.mock.calls[1], "runCliAgent.mock.calls[1] test invariant")[0]
        .cliSessionBinding,
    ).toEqual({ sessionId: "native-1" });
  });

  it("falls back to the single-turn planner when the CLI loop fails", async () => {
    useTempStateDir();
    const config = {
      agents: {
        defaults: {
          model: { primary: "claude-cli/claude-opus-4-8" },
        },
      },
    } satisfies OpenClawConfig;
    const snapshot = configSnapshot(config);
    const inference = await createCliVerifiedBinding(config);
    const inferenceDeps = {
      ...inference.deps,
      readConfigFileSnapshot: (async () => snapshot) as never,
    };
    const runCliAgent = vi.fn(async () => {
      throw new Error("claude exploded");
    });
    const planner = vi.fn(async () => ({ reply: "planner fallback reply" }));
    const engine = new SystemAgentChatEngine({
      verifiedInference: inference.binding,
      runAgentTurn: (params) =>
        runSystemAgentTurnWithDeps(params, {
          ...inferenceDeps,
          runCliAgent: runCliAgent as never,
        }),
      planWithAssistant: planner,
      deps: {
        ...inferenceDeps,
        loadOverview: fakeOverviewLoader({ defaultModel: "claude-cli/claude-opus-4-8" }),
      },
    });

    const reply = await engine.handle("do a health check");

    expect(runCliAgent).toHaveBeenCalledOnce();
    expect(reply.text).toContain("planner fallback reply");
  });
});

function fakeOverviewLoader(
  overrides: { defaultModel?: string; claudeFound?: boolean; codexFound?: boolean } = {},
) {
  return async () =>
    ({
      config: { path: "/tmp/openclaw.json", exists: false, valid: true, issues: [], hash: null },
      agents: [],
      defaultAgentId: "main",
      defaultModel: overrides.defaultModel,
      tools: {
        codex: { command: "codex", found: overrides.codexFound ?? false },
        claude: { command: "claude", found: overrides.claudeFound ?? false },
        gemini: { command: "gemini", found: false },
        apiKeys: { openai: false, anthropic: false },
      },
      gateway: { url: "ws://127.0.0.1:18789", source: "local", reachable: false },
      references: {
        docsUrl: "https://docs.openclaw.ai",
        sourceUrl: "https://github.com/openclaw/openclaw",
      },
    }) as never;
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
