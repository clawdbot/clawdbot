// Agents add tests cover agent creation, workspace setup, channel binding, and onboarding integration.
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AUTH_STORE_VERSION } from "../agents/auth-profiles/constants.js";
import { loadPersistedAuthProfileStore } from "../agents/auth-profiles/persisted.js";
import { resolveAuthProfileDatabasePath } from "../agents/auth-profiles/sqlite.js";
import { saveAuthProfileStore } from "../agents/auth-profiles/store-runtime.js";
import type { AuthProfileCredential, AuthProfileStore } from "../agents/auth-profiles/types.js";
import type { ChannelOnboardingPostWriteHook } from "../channels/plugins/setup-wizard-types.js";
import { formatCliCommand } from "../cli/command-format.js";
import { writeConfigMachineState } from "../state/config-machine-state-write.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { createSuiteTempRootTracker } from "../test-helpers/temp-dir.js";
import { withEnvAsync } from "../test-utils/env.js";
import { createQueuedWizardPrompter } from "../test-utils/plugin-setup-wizard.js";
import { createAgentForAddCommandTest } from "./agents.add.test-fixtures.js";
import { committedConfigFiles as configFiles } from "./committed-config.test-support.js";
import { baseConfigSnapshot, createTestRuntime } from "./test-runtime-config-helpers.js";

type SetupChannels = typeof import("./onboard-channels.js").setupChannels;
type EnsureWorkspaceAndSessions = typeof import("./onboard-helpers.js").ensureWorkspaceAndSessions;
type PrepareAuthChoice = typeof import("./auth-choice.js").prepareAuthChoice;

const readConfigFileSnapshotMock = vi.hoisted(() => vi.fn());
const writeConfigFileMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const replaceConfigFileMock = vi.hoisted(() =>
  vi.fn(async (params: { nextConfig: unknown }) => await writeConfigFileMock(params.nextConfig)),
);
const createAgentMock = vi.hoisted(() => vi.fn());
const checkAgentCreationGateMock = vi.hoisted(() => vi.fn());
const commitConfigWithPendingPluginInstallsMock = vi.hoisted(() =>
  vi.fn(async (params: { sourceConfig: Record<string, unknown> }) => {
    await writeConfigFileMock(params.sourceConfig);
    return configFiles.write(params.sourceConfig);
  }),
);
const transformConfigWithPendingPluginInstallsMock = vi.hoisted(() =>
  vi.fn(
    async (params: {
      transform: (
        config: Record<string, unknown>,
        context: {
          snapshot: Record<string, unknown>;
          previousHash: string | null;
          attempt: number;
        },
      ) =>
        | Promise<{ nextConfig: unknown; result?: unknown }>
        | { nextConfig: unknown; result?: unknown };
    }) => {
      const snapshot = (await readConfigFileSnapshotMock()) as {
        path?: string;
        hash?: string;
        config?: Record<string, unknown>;
        sourceConfig?: Record<string, unknown>;
      };
      const transformed = await params.transform(snapshot.sourceConfig ?? snapshot.config ?? {}, {
        snapshot,
        previousHash: snapshot.hash ?? null,
        attempt: 0,
      });
      await writeConfigFileMock(transformed.nextConfig);
      return {
        path: snapshot.path ?? "/tmp/openclaw.json",
        previousHash: snapshot.hash ?? null,
        persistedHash: "persisted-hash",
        snapshot,
        nextConfig: transformed.nextConfig,
        result: transformed.result,
        attempts: 1,
        afterWrite: { mode: "auto" },
        followUp: { mode: "auto", requiresRestart: false },
      };
    },
  ),
);

const wizardMocks = vi.hoisted(() => ({
  createClackPrompter: vi.fn(),
}));
const pluginLifecycleMocks = vi.hoisted(() => {
  const state = { active: false };
  return {
    state,
    withPluginLifecycleLease: vi.fn(async (_options, run: () => Promise<unknown>) => {
      state.active = true;
      try {
        return await run();
      } finally {
        state.active = false;
      }
    }),
  };
});
const terminalMocks = vi.hoisted(() => ({
  isTerminalInteractive: vi.fn(() => true),
}));
const authChoiceMocks = vi.hoisted(() => ({
  prepareAuthChoice: vi.fn<PrepareAuthChoice>(),
  warnIfModelConfigLooksOff: vi.fn(async () => {}),
}));
const authProfileMocks = vi.hoisted(() => ({
  persistBatch: vi.fn(),
}));
const authPromptMocks = vi.hoisted(() => ({
  promptAuthChoiceGrouped: vi.fn(async () => "fixture-auth"),
}));
const onboardChannelsMocks = vi.hoisted(() => ({
  setupChannels: vi.fn<SetupChannels>(async (config) => config),
}));
const onboardHelpersMocks = vi.hoisted(() => ({
  ensureWorkspaceAndSessions: vi.fn<EnsureWorkspaceAndSessions>(async () => ({
    bootstrapPending: false,
  })),
}));

vi.mock("../config/config.js", async () => ({
  ...(await vi.importActual<typeof import("../config/config.js")>("../config/config.js")),
  readConfigFileSnapshot: readConfigFileSnapshotMock,
  readConfigFileSnapshotForWrite: async () => {
    const snapshot = await readConfigFileSnapshotMock();
    return {
      snapshot: { ...snapshot, sourceConfig: snapshot.sourceConfig ?? snapshot.config },
      writeOptions: {},
    };
  },
  writeConfigFile: writeConfigFileMock,
  replaceConfigFile: replaceConfigFileMock,
}));

vi.mock("../agents/agent-create.js", async () => ({
  ...(await vi.importActual<typeof import("../agents/agent-create.js")>(
    "../agents/agent-create.js",
  )),
  checkAgentCreationGate: checkAgentCreationGateMock,
  createAgent: createAgentMock,
}));

vi.mock("../plugins/install-record-commit.js", async () => ({
  ...(await vi.importActual<typeof import("../plugins/install-record-commit.js")>(
    "../plugins/install-record-commit.js",
  )),
  commitConfigWithPendingPluginInstalls: commitConfigWithPendingPluginInstallsMock,
  transformConfigWithPendingPluginInstalls: transformConfigWithPendingPluginInstallsMock,
}));

vi.mock("../wizard/clack-prompter.js", () => ({
  createClackPrompter: wizardMocks.createClackPrompter,
}));

vi.mock("../plugins/plugin-lifecycle-lease.js", () => ({
  withPluginLifecycleLease: pluginLifecycleMocks.withPluginLifecycleLease,
}));

vi.mock("../cli/terminal-interactivity.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../cli/terminal-interactivity.js")>()),
  isTerminalInteractive: terminalMocks.isTerminalInteractive,
}));

vi.mock("./auth-choice.js", () => ({
  prepareAuthChoice: authChoiceMocks.prepareAuthChoice,
  warnIfModelConfigLooksOff: authChoiceMocks.warnIfModelConfigLooksOff,
}));

vi.mock("./auth-choice-prompt.js", () => ({
  promptAuthChoiceGrouped: authPromptMocks.promptAuthChoiceGrouped,
}));

vi.mock("../agents/auth-profiles/upsert-with-lock.js", () => ({
  persistAuthProfileBatch: authProfileMocks.persistBatch,
}));

vi.mock("./onboard-channels.js", () => ({
  setupChannels: onboardChannelsMocks.setupChannels,
}));

vi.mock("./onboard-helpers.js", () => ({
  ensureWorkspaceAndSessions: onboardHelpersMocks.ensureWorkspaceAndSessions,
}));

import { WizardCancelledError } from "../wizard/prompts.js";
import { agentsAddCommand } from "./agents.commands.add.js";

const { persistAuthProfileBatch } = await vi.importActual<
  typeof import("../agents/auth-profiles/upsert-with-lock.js")
>("../agents/auth-profiles/upsert-with-lock.js");

const runtime = createTestRuntime();
const RESERVED_SYSTEM_AGENT_IDS_FOR_TEST = ["openclaw", "crestodian"] as const; // reserved ids

describe("agents add command", () => {
  const suiteTempDirs = createSuiteTempRootTracker({ prefix: "openclaw-agents-add-" });

  beforeAll(async () => {
    await suiteTempDirs.setup();
  });

  afterAll(async () => {
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    await suiteTempDirs.cleanup();
  });

  beforeEach(() => {
    configFiles.clear();
    readConfigFileSnapshotMock.mockClear();
    writeConfigFileMock.mockClear();
    replaceConfigFileMock.mockClear();
    commitConfigWithPendingPluginInstallsMock.mockClear();
    transformConfigWithPendingPluginInstallsMock.mockClear();
    checkAgentCreationGateMock.mockReset().mockResolvedValue(undefined);
    createAgentMock.mockReset();
    createAgentMock.mockImplementation(createAgentForAddCommandTest);
    wizardMocks.createClackPrompter.mockClear();
    pluginLifecycleMocks.withPluginLifecycleLease.mockClear();
    pluginLifecycleMocks.state.active = false;
    terminalMocks.isTerminalInteractive.mockReset().mockReturnValue(true);
    authChoiceMocks.prepareAuthChoice.mockReset();
    authChoiceMocks.warnIfModelConfigLooksOff.mockClear();
    authPromptMocks.promptAuthChoiceGrouped.mockClear();
    authProfileMocks.persistBatch.mockReset().mockImplementation(persistAuthProfileBatch);
    onboardChannelsMocks.setupChannels.mockClear();
    onboardHelpersMocks.ensureWorkspaceAndSessions.mockClear();
    runtime.log.mockClear();
    runtime.error.mockClear();
    runtime.exit.mockClear();
  });

  async function withAgentsAddStateRoot(
    prefix: string,
    run: (root: string) => Promise<void>,
  ): Promise<void> {
    const root = await suiteTempDirs.make(prefix);
    await withEnvAsync({ OPENCLAW_STATE_DIR: root }, async () => await run(root));
  }

  async function seedAgentAuthStore(
    root: string,
    agentId: string,
    store: AuthProfileStore,
  ): Promise<string> {
    const agentDir = path.join(root, "agents", agentId, "agent");
    await fs.mkdir(agentDir, { recursive: true });
    saveAuthProfileStore(store, agentDir);
    return agentDir;
  }

  function setConfigSnapshot(config: Record<string, unknown>): void {
    readConfigFileSnapshotMock.mockResolvedValue({
      ...baseConfigSnapshot,
      config,
      sourceConfig: config,
    });
  }

  function useFreshAgentWizard(params: { workspaceDir: string; confirmValues?: boolean[] }) {
    const wizard = createQueuedWizardPrompter({
      textValues: ["work", params.workspaceDir],
      confirmValues: params.confirmValues,
    });
    wizardMocks.createClackPrompter.mockReturnValue(wizard.prompter);
    return wizard;
  }

  function useExistingAgentWizard(workspaceDir = "/tmp/workspace-work") {
    const wizard = createQueuedWizardPrompter({
      textValues: [workspaceDir],
      confirmValues: [true, false],
    });
    wizardMocks.createClackPrompter.mockReturnValue(wizard.prompter);
    return wizard;
  }

  function stageGuidedAuth(
    profiles: Array<{ profileId: string; credential: AuthProfileCredential }> = [
      {
        profileId: "openai:primary",
        credential: { type: "api_key", provider: "openai", key: "sk-primary" },
      },
    ],
  ): void {
    authChoiceMocks.prepareAuthChoice.mockImplementationOnce(async ({ config }) => ({
      config: {
        ...config,
        auth: { profiles: { "openai:primary": { provider: "openai", mode: "api_key" } } },
      },
      authProfiles: profiles,
      persistAuthProfiles: async () => {},
    }));
  }

  function stageChannelPostWriteHook(run: ChannelOnboardingPostWriteHook["run"]): void {
    onboardChannelsMocks.setupChannels.mockImplementationOnce(
      async (config, _runtime, _prompter, options) => {
        options?.onPostWriteHook?.({ channel: "matrix", accountId: "ops", run });
        return config;
      },
    );
  }

  it.each([
    {
      name: "a missing workspace with automation flags",
      options: { name: "Work" },
      flags: { hasAutomationFlags: true },
      message: `Non-interactive agent creation requires --workspace. Re-run ${formatCliCommand("openclaw agents add <id> --workspace <path>")} or omit flags to use the wizard.`,
    },
    {
      name: "a missing workspace with explicit non-interactive mode",
      options: { name: "Work", nonInteractive: true },
      flags: { hasAutomationFlags: false },
      message: `Non-interactive agent creation requires --workspace. Re-run ${formatCliCommand("openclaw agents add <id> --workspace <path>")} or omit flags to use the wizard.`,
    },
    {
      name: "a missing name after a valid workspace",
      options: { workspace: "/tmp/work" },
      flags: { hasAutomationFlags: true },
      message: `Agent name is required in non-interactive mode. Run ${formatCliCommand("openclaw agents add <id> --workspace <path>")}.`,
    },
    {
      name: "an unrepresentable non-interactive name",
      options: { name: "агент✨", workspace: "/tmp/work" },
      flags: { hasAutomationFlags: true },
      message:
        'Agent name "агент✨" has no valid id characters. Use at least one letter a-z or digit.',
    },
    ...RESERVED_SYSTEM_AGENT_IDS_FOR_TEST.map((agentId) => ({
      name: `reserved system-agent id ${agentId}`,
      options: { name: agentId, workspace: "/tmp/reserved" },
      flags: { hasAutomationFlags: true },
      message: `"${agentId}" is reserved. Choose another name, or run ${formatCliCommand("openclaw agents list")} to inspect configured agents.`,
    })),
  ])("rejects $name through the root failure owner before mutation", async (testCase) => {
    readConfigFileSnapshotMock.mockResolvedValue({ ...baseConfigSnapshot });

    await expect(agentsAddCommand(testCase.options, runtime, testCase.flags)).rejects.toMatchObject(
      {
        name: "ExpectedCliError",
        message: testCase.message,
        humanOutput: testCase.message,
        machineOutput: testCase.message,
      },
    );

    expect(runtime.error).not.toHaveBeenCalled();
    expect(runtime.exit).not.toHaveBeenCalled();
    expect(createAgentMock).not.toHaveBeenCalled();
    expect(writeConfigFileMock).not.toHaveBeenCalled();
  });

  it("rejects an unrepresentable positional name before targeting an existing agent", async () => {
    setConfigSnapshot({ agents: { entries: { main: {} } } });
    const prompter = {
      intro: vi.fn(),
      text: vi.fn(),
      confirm: vi.fn(),
      note: vi.fn(),
      outro: vi.fn(),
    };
    wizardMocks.createClackPrompter.mockReturnValue(prompter);

    await agentsAddCommand({ name: "агент✨" }, runtime);

    expect(prompter.outro).toHaveBeenCalledWith(
      'Agent name "агент✨" has no valid id characters. Use at least one letter a-z or digit.',
    );
    expect(prompter.confirm).not.toHaveBeenCalled();
    expect(prompter.note).not.toHaveBeenCalled();
    expect(checkAgentCreationGateMock).not.toHaveBeenCalled();
    expect(createAgentMock).not.toHaveBeenCalled();
    expect(writeConfigFileMock).not.toHaveBeenCalled();
  });

  it.each(RESERVED_SYSTEM_AGENT_IDS_FOR_TEST)(
    "rejects reserved system-agent id %s from an interactive positional argument",
    async (name) => {
      readConfigFileSnapshotMock.mockResolvedValue({ ...baseConfigSnapshot });
      const prompter = {
        intro: vi.fn(),
        text: vi.fn(),
        confirm: vi.fn(),
        note: vi.fn(),
        outro: vi.fn(),
      };
      wizardMocks.createClackPrompter.mockReturnValue(prompter);

      await agentsAddCommand({ name }, runtime);

      expect(prompter.outro).toHaveBeenCalledWith(`"${name}" is reserved. Choose another name.`);
      expect(prompter.text).not.toHaveBeenCalled();
      expect(writeConfigFileMock).not.toHaveBeenCalled();
    },
  );

  it("exits with code 1 when the interactive wizard is cancelled", async () => {
    readConfigFileSnapshotMock.mockResolvedValue({ ...baseConfigSnapshot });
    wizardMocks.createClackPrompter.mockReturnValue({
      intro: vi.fn().mockRejectedValue(new WizardCancelledError()),
      text: vi.fn(),
      confirm: vi.fn(),
      note: vi.fn(),
      outro: vi.fn(),
    });

    await agentsAddCommand({}, runtime);

    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(writeConfigFileMock).not.toHaveBeenCalled();
  });

  it.each([
    { json: false, output: process.stdout },
    { json: true, output: process.stderr },
  ])(
    "refuses the interactive wizard without a usable terminal (json=$json)",
    async ({ json, output }) => {
      readConfigFileSnapshotMock.mockResolvedValue({ ...baseConfigSnapshot });
      terminalMocks.isTerminalInteractive.mockReturnValue(false);
      wizardMocks.createClackPrompter.mockReturnValue({
        intro: vi.fn(),
        text: vi.fn().mockRejectedValue(new WizardCancelledError()),
        confirm: vi.fn(),
        note: vi.fn(),
        outro: vi.fn(),
      });

      const message =
        "Agent creation needs an interactive TTY. Use `openclaw agents add <id> --non-interactive --workspace <dir>` for automation.";
      await expect(agentsAddCommand({ json }, runtime)).rejects.toMatchObject({
        name: "ExpectedCliError",
        message,
        humanOutput: message,
        machineOutput: message,
      });

      expect(runtime.error).not.toHaveBeenCalled();
      expect(runtime.exit).not.toHaveBeenCalled();
      expect(runtime.log).not.toHaveBeenCalled();
      expect(terminalMocks.isTerminalInteractive).toHaveBeenCalledWith(output);
      expect(readConfigFileSnapshotMock).not.toHaveBeenCalled();
      expect(wizardMocks.createClackPrompter).not.toHaveBeenCalled();
      expect(createAgentMock).not.toHaveBeenCalled();
      expect(writeConfigFileMock).not.toHaveBeenCalled();
    },
  );

  it("uses the explicit agent target and skips catalog validation", async () => {
    setConfigSnapshot({ agents: { list: [{ id: "main", default: true }] } });
    const prompter = {
      intro: vi.fn(),
      text: vi.fn().mockResolvedValueOnce("Jon").mockResolvedValueOnce("/tmp/openclaw-jon"),
      confirm: vi.fn().mockResolvedValue(false),
      note: vi.fn(),
      outro: vi.fn(),
    };
    wizardMocks.createClackPrompter.mockReturnValue(prompter);

    await agentsAddCommand({}, runtime);

    expect(terminalMocks.isTerminalInteractive).toHaveBeenCalledOnce();
    expect(terminalMocks.isTerminalInteractive).toHaveBeenCalledWith(process.stdout);
    expect(wizardMocks.createClackPrompter).toHaveBeenCalledWith(process.stdout);
    expect(prompter.intro).toHaveBeenCalledWith("Add OpenClaw agent");
    expect(authChoiceMocks.warnIfModelConfigLooksOff).toHaveBeenCalledOnce();
    expect(authChoiceMocks.warnIfModelConfigLooksOff).toHaveBeenCalledWith(
      expect.objectContaining({ agents: expect.any(Object) }),
      expect.any(Object),
      expect.objectContaining({
        agentId: "jon",
        validateCatalog: false,
      }),
    );
    expect(checkAgentCreationGateMock).toHaveBeenCalledWith("jon");
    expect(createAgentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        entry: expect.objectContaining({ id: "jon", workspace: "/tmp/openclaw-jon" }),
        stagedConfig: expect.any(Object),
        transformConfig: transformConfigWithPendingPluginInstallsMock,
      }),
    );
  });

  it("keeps guided JSON stdout isolated while wizard logs and UI use stderr", async () => {
    const config = { agents: { entries: { work: { id: "work" } } } };
    setConfigSnapshot(config);
    useExistingAgentWizard();
    onboardChannelsMocks.setupChannels.mockImplementationOnce(
      async (nextConfig, wizardRuntime, _prompter, options) => {
        wizardRuntime.log("channel log");
        options?.onPostWriteHook?.({
          channel: "matrix",
          accountId: "ops",
          run: async ({ runtime: hookRuntime }) => hookRuntime.log("hook log"),
        });
        return nextConfig;
      },
    );
    onboardHelpersMocks.ensureWorkspaceAndSessions.mockImplementationOnce(
      async (_workspace, workspaceRuntime) => {
        workspaceRuntime.log("workspace log");
        return { bootstrapPending: false };
      },
    );

    await agentsAddCommand({ name: "work", json: true }, runtime);

    expect(terminalMocks.isTerminalInteractive).toHaveBeenCalledWith(process.stderr);
    expect(wizardMocks.createClackPrompter).toHaveBeenCalledWith(process.stderr);
    expect(runtime.error.mock.calls.map(([message]) => message)).toEqual([
      "channel log",
      "workspace log",
      "hook log",
    ]);
    expect(runtime.log).toHaveBeenCalledOnce();
    expect(JSON.parse(String(runtime.log.mock.calls[0]?.[0]))).toEqual({
      agentId: "work",
      name: "work",
      workspace: "/tmp/workspace-work",
      agentDir: expect.stringContaining("/agents/work/agent"),
    });
  });

  it("surfaces the canonical main gate before guided auth or workspace side effects", async () => {
    setConfigSnapshot({ agents: { entries: { robby: { id: "robby" } } } });
    const prompter = {
      intro: vi.fn(),
      text: vi.fn(),
      confirm: vi.fn(),
      note: vi.fn(),
      outro: vi.fn(),
    };
    wizardMocks.createClackPrompter.mockReturnValue(prompter);
    checkAgentCreationGateMock.mockResolvedValueOnce({
      status: "error",
      reason: "legacy-session-migration-required",
      agentId: "main",
      message: "Run openclaw doctor --fix, then retry.",
    });

    await agentsAddCommand({ name: "main" }, runtime);

    expect(checkAgentCreationGateMock).toHaveBeenCalledWith("main");
    expect(prompter.outro).toHaveBeenCalledWith("Run openclaw doctor --fix, then retry.");
    expect(prompter.text).not.toHaveBeenCalled();
    expect(authChoiceMocks.prepareAuthChoice).not.toHaveBeenCalled();
    expect(createAgentMock).not.toHaveBeenCalled();
  });

  it.each(["legacy-main", "state-db"] as const)(
    "reports only auth profiles persisted to the new agent store with %s shared auth",
    async (location) => {
      await withAgentsAddStateRoot("openclaw-agents-add-auth-copy-", async (root) => {
        const destAgentDir = path.join(root, "agents", "work", "agent");
        const workspaceDir = path.join(root, "workspace-work");
        const sourceStore: AuthProfileStore = {
          version: AUTH_STORE_VERSION,
          profiles: {
            "openai:api-key": {
              type: "api_key",
              provider: "openai",
              key: "sk-test",
            },
            "openai:oauth": {
              type: "oauth",
              provider: "openai",
              access: "codex-copy-access-token",
              refresh: "codex-copy-refresh-token",
              expires: Date.now() + 60_000,
              copyToAgents: true,
            },
          },
        };
        if (location === "state-db") {
          writeConfigMachineState("auth.sharedStore", { location: "state-db" });
          saveAuthProfileStore(sourceStore);
        } else {
          await seedAgentAuthStore(root, "main", sourceStore);
        }
        setConfigSnapshot({ agents: { list: [{ id: "main", default: true }] } });
        const wizard = useFreshAgentWizard({ workspaceDir, confirmValues: [true, false] });

        await agentsAddCommand({}, runtime);

        expect(Object.keys(loadPersistedAuthProfileStore(destAgentDir)?.profiles ?? {})).toEqual([
          "openai:api-key",
        ]);
        expect(wizard.note).toHaveBeenCalledWith(
          'Copied 1 portable auth profile from "main". OAuth profiles stay shared from "main" unless this agent signs in separately.',
          "Auth profiles",
        );
      });
    },
  );

  it.each([
    { source: "__skip__", copy: false, systemAgent: undefined },
    { source: "ops", copy: true, systemAgent: { agentId: "main" } },
    { source: "ops", copy: false, systemAgent: undefined },
  ])("adds to an explicit fleet with optional auth copy: %j", async (testCase) => {
    await withAgentsAddStateRoot("openclaw-agents-add-explicit-", async (root) => {
      const workspaceDir = path.join(root, "workspace-work");
      const sourceAgentDir = await seedAgentAuthStore(root, "ops", {
        version: AUTH_STORE_VERSION,
        profiles: {
          "openai:portable": { type: "api_key", provider: "openai", key: "fixture-only-key" },
        },
      });
      setConfigSnapshot({
        agents: {
          ownership: "explicit",
          defaults: { systemAgent: testCase.systemAgent },
          entries: { main: {}, ops: { agentDir: sourceAgentDir } },
        },
      });
      const wizard = createQueuedWizardPrompter({
        textValues: ["work", workspaceDir],
        selectValues: [testCase.source],
        confirmValues: testCase.source === "__skip__" ? [false] : [testCase.copy, false],
      });
      wizardMocks.createClackPrompter.mockReturnValue(wizard.prompter);

      await agentsAddCommand({}, runtime);

      expect(wizard.outro).toHaveBeenCalledWith('Agent "work" ready.');
      const copied = loadPersistedAuthProfileStore(path.join(root, "agents", "work", "agent"));
      expect(copied?.profiles["openai:portable"] !== undefined).toBe(testCase.copy);
      expect(onboardChannelsMocks.setupChannels).toHaveBeenCalledWith(
        expect.any(Object),
        runtime,
        wizard.prompter,
        expect.objectContaining({ workspaceDir, deferStatusUntilSelection: true }),
      );
    });
  });

  it("fails before config mutation when the source auth store is unreadable", async () => {
    await withAgentsAddStateRoot("openclaw-agents-add-auth-unreadable-", async (root) => {
      const sourceAgentDir = path.join(root, "agents", "main", "agent");
      const workspaceDir = path.join(root, "workspace-work");
      await fs.mkdir(sourceAgentDir, { recursive: true });
      const database = new DatabaseSync(resolveAuthProfileDatabasePath(sourceAgentDir));
      database.exec(
        "CREATE VIEW auth_profile_store AS SELECT 'primary' AS store_key, '{}' AS store_json;",
      );
      database.close();
      setConfigSnapshot({ agents: { list: [{ id: "main", default: true }] } });
      const wizard = useFreshAgentWizard({ workspaceDir });

      await expect(agentsAddCommand({}, runtime)).rejects.toThrow(
        /auth profile store .* is unreadable; run .*doctor --fix/i,
      );

      expect(writeConfigFileMock).not.toHaveBeenCalled();
      expect(wizard.outro).not.toHaveBeenCalled();
    });
  });

  it("does not copy accepted portable auth when the guided wizard is cancelled", async () => {
    await withAgentsAddStateRoot("openclaw-agents-add-auth-cancel-", async (root) => {
      const destAgentDir = path.join(root, "agents", "work", "agent");
      const workspaceDir = path.join(root, "workspace-work");
      await seedAgentAuthStore(root, "main", {
        version: AUTH_STORE_VERSION,
        profiles: {
          "openai:api-key": { type: "api_key", provider: "openai", key: "sk-test" },
        },
      });
      setConfigSnapshot({ agents: { list: [{ id: "main", default: true }] } });
      const wizard = useFreshAgentWizard({ workspaceDir });
      wizard.confirm.mockResolvedValueOnce(true).mockRejectedValueOnce(new WizardCancelledError());

      await agentsAddCommand({}, runtime);

      await expect(fs.stat(destAgentDir)).rejects.toMatchObject({ code: "ENOENT" });
      expect(createAgentMock).not.toHaveBeenCalled();
      expect(runtime.exit).toHaveBeenCalledWith(1);
    });
  });

  it("does not persist prepared provider auth when a later prompt is cancelled", async () => {
    await withAgentsAddStateRoot("openclaw-agents-add-auth-cancel-provider-", async (root) => {
      const agentDir = path.join(root, "agents", "work", "agent");
      const workspaceDir = path.join(root, "workspace-work");
      setConfigSnapshot({ agents: { list: [{ id: "main", default: true }] } });
      useFreshAgentWizard({ workspaceDir, confirmValues: [true] });
      stageGuidedAuth();
      authChoiceMocks.warnIfModelConfigLooksOff.mockRejectedValueOnce(new WizardCancelledError());

      await agentsAddCommand({}, runtime);

      expect(loadPersistedAuthProfileStore(agentDir)).toBeNull();
      expect(authProfileMocks.persistBatch).not.toHaveBeenCalled();
      expect(createAgentMock).not.toHaveBeenCalled();
      expect(runtime.exit).toHaveBeenCalledWith(1);
    });
  });

  it("keeps guided auth while applying portable profiles without overwriting", async () => {
    await withAgentsAddStateRoot("openclaw-agents-add-auth-guided-", async (root) => {
      const destAgentDir = path.join(root, "agents", "work", "agent");
      const workspaceDir = path.join(root, "workspace-work");
      await seedAgentAuthStore(root, "main", {
        version: AUTH_STORE_VERSION,
        profiles: {
          "openai:api-key": {
            type: "api_key",
            provider: "openai",
            key: "portable-conflict",
          },
          "openai:portable": {
            type: "api_key",
            provider: "openai",
            key: "portable-retained",
          },
        },
        order: { openai: ["openai:api-key", "openai:portable"] },
      });
      setConfigSnapshot({ agents: { list: [{ id: "main", default: true }] } });
      const wizard = createQueuedWizardPrompter({
        textValues: ["work", workspaceDir],
        confirmValues: [true, true],
        selectValues: ["openai", "openai-api-key"],
      });
      wizardMocks.createClackPrompter.mockReturnValue(wizard.prompter);
      stageGuidedAuth([
        {
          profileId: "openai:api-key",
          credential: { type: "api_key", provider: "openai", key: "guided-wins" },
        },
        {
          profileId: "openai:guided",
          credential: { type: "api_key", provider: "openai", key: "guided-retained" },
        },
      ]);

      await agentsAddCommand({}, runtime);

      const persisted = loadPersistedAuthProfileStore(destAgentDir);
      expect(persisted?.profiles).toMatchObject({
        "openai:api-key": { key: "guided-wins" },
        "openai:portable": { key: "portable-retained" },
        "openai:guided": { key: "guided-retained" },
      });
      expect(persisted?.order?.openai).toEqual(["openai:api-key", "openai:portable"]);
      expect(wizard.note).toHaveBeenCalledWith(
        'Copied 2 portable auth profiles from "main".',
        "Auth profiles",
      );
    });
  });

  it("persists staged provider auth only at the agent config commit edge", async () => {
    await withAgentsAddStateRoot("openclaw-agents-add-auth-create-", async (root) => {
      const agentDir = path.join(root, "agents", "work", "agent");
      const workspaceDir = path.join(root, "workspace-work");
      setConfigSnapshot({ agents: { list: [{ id: "main", default: true }] } });
      useFreshAgentWizard({ workspaceDir, confirmValues: [true] });
      stageGuidedAuth();
      const create = createAgentMock.getMockImplementation()!;
      createAgentMock.mockImplementationOnce(async (params) => {
        expect(pluginLifecycleMocks.state.active).toBe(true);
        expect(authProfileMocks.persistBatch).not.toHaveBeenCalled();
        return await create(params);
      });

      await agentsAddCommand({}, runtime);

      expect(loadPersistedAuthProfileStore(agentDir)?.profiles["openai:primary"]).toMatchObject({
        key: "sk-primary",
      });
      expect(authProfileMocks.persistBatch).toHaveBeenCalledOnce();
      expect(authChoiceMocks.warnIfModelConfigLooksOff).toHaveBeenCalledWith(
        expect.any(Object),
        expect.any(Object),
        expect.objectContaining({
          pendingAuthProfiles: [expect.objectContaining({ profileId: "openai:primary" })],
        }),
      );
      expect(createAgentMock).toHaveBeenCalledWith(
        expect.objectContaining({
          stagedConfig: expect.objectContaining({
            config: expect.objectContaining({ auth: expect.any(Object) }),
            writeSnapshot: expect.any(Object),
          }),
          prepareConfigCommit: expect.any(Function),
        }),
      );
    });
  });

  it("publishes no agent when staged provider auth cannot persist atomically", async () => {
    await withAgentsAddStateRoot("openclaw-agents-add-auth-persist-failure-", async (root) => {
      const agentDir = path.join(root, "agents", "work", "agent");
      const workspaceDir = path.join(root, "workspace-work");
      const profiles = ["first", "second"].map((name) => ({
        profileId: `openai:${name}`,
        credential: { type: "api_key" as const, provider: "openai", key: `sk-${name}` },
      }));
      setConfigSnapshot({ agents: { list: [{ id: "main", default: true }] } });
      useFreshAgentWizard({ workspaceDir, confirmValues: [true] });
      stageGuidedAuth(profiles);
      authProfileMocks.persistBatch.mockRejectedValueOnce(
        new Error("injected auth batch persistence failure"),
      );

      await expect(agentsAddCommand({}, runtime)).rejects.toThrow(
        "injected auth batch persistence failure",
      );

      expect(loadPersistedAuthProfileStore(agentDir)).toBeNull();
      expect(createAgentMock).toHaveBeenCalledOnce();
      expect(commitConfigWithPendingPluginInstallsMock).not.toHaveBeenCalled();
      expect(writeConfigFileMock).not.toHaveBeenCalled();
    });
  });

  it("retains existing-agent auth after config publication when later output fails", async () => {
    await withAgentsAddStateRoot("openclaw-agents-add-auth-existing-", async (root) => {
      const agentDir = path.join(root, "agents", "work", "agent");
      const workspaceDir = path.join(root, "workspace-work");
      setConfigSnapshot({
        agents: { entries: { work: { id: "work", workspace: workspaceDir, agentDir } } },
      });
      const wizard = createQueuedWizardPrompter({
        textValues: [workspaceDir],
        confirmValues: [true, true],
      });
      wizardMocks.createClackPrompter.mockReturnValue(wizard.prompter);
      stageGuidedAuth();
      wizard.outro.mockRejectedValueOnce(new Error("injected late failure"));

      await expect(agentsAddCommand({ name: "work" }, runtime)).rejects.toThrow(
        "injected late failure",
      );

      expect(loadPersistedAuthProfileStore(agentDir)?.profiles["openai:primary"]).toMatchObject({
        key: "sk-primary",
      });
      expect(commitConfigWithPendingPluginInstallsMock).toHaveBeenCalledWith(
        expect.objectContaining({
          sourceConfig: expect.objectContaining({ auth: expect.any(Object) }),
        }),
      );
      expect(createAgentMock).not.toHaveBeenCalled();
    });
  });

  it("rolls existing-agent auth back when config publication fails", async () => {
    await withAgentsAddStateRoot("openclaw-agents-add-auth-existing-rollback-", async (root) => {
      const agentDir = path.join(root, "agents", "work", "agent");
      const workspaceDir = path.join(root, "workspace-work");
      setConfigSnapshot({
        agents: { entries: { work: { id: "work", workspace: workspaceDir, agentDir } } },
      });
      const wizard = createQueuedWizardPrompter({
        textValues: [workspaceDir],
        confirmValues: [true, true],
      });
      wizardMocks.createClackPrompter.mockReturnValue(wizard.prompter);
      stageGuidedAuth();
      commitConfigWithPendingPluginInstallsMock.mockRejectedValueOnce(
        new Error("injected config publication failure"),
      );

      await expect(agentsAddCommand({ name: "work" }, runtime)).rejects.toThrow(
        "injected config publication failure",
      );

      expect(loadPersistedAuthProfileStore(agentDir)).toBeNull();
      expect(createAgentMock).not.toHaveBeenCalled();
    });
  });

  it("runs channel post-write hooks only after fresh agent creation", async () => {
    const hook = vi.fn(async () => {});
    setConfigSnapshot({ agents: { list: [{ id: "main", default: true }] } });
    useFreshAgentWizard({ workspaceDir: "/tmp/workspace-work", confirmValues: [false] });
    stageChannelPostWriteHook(hook);

    await agentsAddCommand({}, runtime);

    expect(hook).toHaveBeenCalledOnce();
    expect(createAgentMock.mock.invocationCallOrder[0]!).toBeLessThan(
      hook.mock.invocationCallOrder[0]!,
    );
  });

  it("passes canonical created config to fresh-agent post-write hooks", async () => {
    const persistedConfig = {
      agents: { entries: { work: { id: "work", workspace: "/tmp/canonical-workspace" } } },
      plugins: { installs: {} },
    };
    const hook = vi.fn(async () => {});
    setConfigSnapshot({ agents: { list: [{ id: "main", default: true }] } });
    useFreshAgentWizard({ workspaceDir: "/tmp/staged-workspace", confirmValues: [false] });
    stageChannelPostWriteHook(hook);
    createAgentMock.mockResolvedValueOnce({
      status: "created",
      agentId: "work",
      name: "work",
      workspace: "/tmp/canonical-workspace",
      agentDir: "/tmp/agent-work",
      bootstrapPending: true,
      config: persistedConfig,
      configPath: configFiles.write(persistedConfig).path,
    });

    await agentsAddCommand({}, runtime);

    expect(hook).toHaveBeenCalledWith(expect.objectContaining({ cfg: persistedConfig }));
  });

  it("does not run channel post-write hooks when fresh agent creation fails", async () => {
    const hook = vi.fn(async () => {});
    setConfigSnapshot({ agents: { list: [{ id: "main", default: true }] } });
    useFreshAgentWizard({ workspaceDir: "/tmp/workspace-work", confirmValues: [false] });
    stageChannelPostWriteHook(hook);
    createAgentMock.mockResolvedValueOnce({
      status: "error",
      reason: "write-failed",
      agentId: "work",
      message: "controlled create failure",
    });

    await agentsAddCommand({}, runtime);

    expect(hook).not.toHaveBeenCalled();
  });

  it("provisions an existing agent workspace before committing its update and running hooks", async () => {
    const config = { agents: { entries: { work: { id: "work" } } } };
    const hook = vi.fn(async () => {});
    setConfigSnapshot(config);
    useExistingAgentWizard();
    stageChannelPostWriteHook(hook);

    await agentsAddCommand({ name: "work" }, runtime);

    expect(
      onboardHelpersMocks.ensureWorkspaceAndSessions.mock.invocationCallOrder[0]!,
    ).toBeLessThan(commitConfigWithPendingPluginInstallsMock.mock.invocationCallOrder[0]!);
    expect(commitConfigWithPendingPluginInstallsMock.mock.invocationCallOrder[0]!).toBeLessThan(
      hook.mock.invocationCallOrder[0]!,
    );
  });

  it("does not commit an existing-agent update when workspace provisioning fails", async () => {
    const config = { agents: { entries: { work: { id: "work" } } } };
    setConfigSnapshot(config);
    useExistingAgentWizard();
    onboardHelpersMocks.ensureWorkspaceAndSessions.mockRejectedValueOnce(
      new Error("controlled mkdir failure"),
    );

    await expect(agentsAddCommand({ name: "work" }, runtime)).rejects.toThrow(
      /workspace provisioning.*agent "work".*controlled mkdir failure/i,
    );

    expect(commitConfigWithPendingPluginInstallsMock).not.toHaveBeenCalled();
    expect(writeConfigFileMock).not.toHaveBeenCalled();
  });

  describe("non-interactive config mutation", () => {
    it("creates with explicit non-interactive inputs without a usable terminal", async () => {
      setConfigSnapshot({ agents: { list: [{ id: "main", default: true }] } });
      terminalMocks.isTerminalInteractive.mockReturnValue(false);

      await agentsAddCommand(
        { name: "Work", workspace: "/tmp/work", nonInteractive: true },
        runtime,
        { hasAutomationFlags: false },
      );

      expect(createAgentMock).toHaveBeenCalledWith({
        name: "Work",
        workspace: "/tmp/work",
        transformConfig: transformConfigWithPendingPluginInstallsMock,
      });
      expect(transformConfigWithPendingPluginInstallsMock).not.toHaveBeenCalled();
      expect(runtime.exit).not.toHaveBeenCalled();
      expect(runtime.error).not.toHaveBeenCalled();
      expect(terminalMocks.isTerminalInteractive).not.toHaveBeenCalled();
    });

    it.each([
      {
        name: "a duplicate agent",
        result: {
          status: "error" as const,
          reason: "already-exists",
          agentId: "work",
          message: 'agent "work" already exists',
        },
        message: 'Agent "work" already exists.',
      },
      {
        name: "a rejected binding",
        result: {
          status: "error" as const,
          reason: "invalid-bindings",
          agentId: "work",
          message: 'Invalid binding "telegram:". Account id is empty.',
        },
        message: 'Invalid binding "telegram:". Account id is empty.',
      },
    ])("reports $name through the root failure owner", async (testCase) => {
      setConfigSnapshot({ agents: { list: [{ id: "main", default: true }] } });
      createAgentMock.mockResolvedValueOnce(testCase.result);

      await expect(
        agentsAddCommand({ name: "Work", workspace: "/tmp/work" }, runtime, {
          hasAutomationFlags: true,
        }),
      ).rejects.toMatchObject({
        name: "ExpectedCliError",
        message: testCase.message,
        humanOutput: testCase.message,
        machineOutput: testCase.message,
      });

      expect(writeConfigFileMock).not.toHaveBeenCalled();
      expect(runtime.error).not.toHaveBeenCalled();
      expect(runtime.exit).not.toHaveBeenCalled();
    });

    it("reports binding conflicts from the committed mutation", async () => {
      readConfigFileSnapshotMock
        .mockResolvedValueOnce({
          ...baseConfigSnapshot,
          hash: "hash-1",
          config: { agents: { list: [{ id: "main", default: true }] } },
          sourceConfig: { agents: { list: [{ id: "main", default: true }] } },
        })
        .mockResolvedValueOnce({
          ...baseConfigSnapshot,
          hash: "hash-2",
          config: {
            agents: { list: [{ id: "other-agent", default: true }] },
            bindings: [{ type: "route", agentId: "other-agent", match: { channel: "telegram" } }],
          },
          sourceConfig: {
            agents: { list: [{ id: "other-agent", default: true }] },
            bindings: [{ type: "route", agentId: "other-agent", match: { channel: "telegram" } }],
          },
        });

      await agentsAddCommand(
        { name: "Work", workspace: "/tmp/work", bind: ["telegram"], json: true },
        runtime,
        { hasAutomationFlags: true },
      );

      const payload = JSON.parse(String(runtime.log.mock.calls.at(-1)?.[0])) as {
        bindings: { added: string[]; conflicts: string[] };
      };
      expect(payload.bindings.added).toEqual([]);
      expect(payload.bindings.conflicts).toEqual(["telegram (agent=other-agent)"]);
    });
  });
});
