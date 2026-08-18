// Agents add tests cover agent creation, workspace setup, channel binding, and onboarding integration.
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AUTH_STORE_VERSION } from "../agents/auth-profiles/constants.js";
import { loadPersistedAuthProfileStore } from "../agents/auth-profiles/persisted.js";
import { resolveAuthProfileDatabasePath } from "../agents/auth-profiles/sqlite.js";
import { saveAuthProfileStore } from "../agents/auth-profiles/store.js";
import type { AuthProfileStore } from "../agents/auth-profiles/types.js";
import type { ChannelOnboardingPostWriteHook } from "../channels/plugins/setup-wizard-types.js";
import { formatCliCommand } from "../cli/command-format.js";
import { writeConfigMachineState } from "../state/config-machine-state.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { createSuiteTempRootTracker } from "../test-helpers/temp-dir.js";
import { withEnvAsync } from "../test-utils/env.js";
import { createQueuedWizardPrompter } from "../test-utils/plugin-setup-wizard.js";
import { baseConfigSnapshot, createTestRuntime } from "./test-runtime-config-helpers.js";

type SetupChannels = typeof import("./onboard-channels.js").setupChannels;
type EnsureWorkspaceAndSessions = typeof import("./onboard-helpers.js").ensureWorkspaceAndSessions;
type ApplyAuthChoice = typeof import("./auth-choice.js").applyAuthChoice;

const readConfigFileSnapshotMock = vi.hoisted(() => vi.fn());
const writeConfigFileMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const replaceConfigFileMock = vi.hoisted(() =>
  vi.fn(async (params: { nextConfig: unknown }) => await writeConfigFileMock(params.nextConfig)),
);
const createAgentMock = vi.hoisted(() => vi.fn());
const checkAgentCreationGateMock = vi.hoisted(() => vi.fn());
const commitConfigWithPendingPluginInstallsMock = vi.hoisted(() =>
  vi.fn(async (params: { nextConfig: Record<string, unknown> }) => {
    await writeConfigFileMock(params.nextConfig);
    return { config: params.nextConfig };
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
const terminalMocks = vi.hoisted(() => ({
  isTerminalInteractive: vi.fn(() => true),
}));
const authChoiceMocks = vi.hoisted(() => ({
  applyAuthChoice: vi.fn<ApplyAuthChoice>(),
  warnIfModelConfigLooksOff: vi.fn(async () => {}),
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

vi.mock("../cli/terminal-interactivity.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../cli/terminal-interactivity.js")>()),
  isTerminalInteractive: terminalMocks.isTerminalInteractive,
}));

vi.mock("./auth-choice.js", () => ({
  applyAuthChoice: authChoiceMocks.applyAuthChoice,
  warnIfModelConfigLooksOff: authChoiceMocks.warnIfModelConfigLooksOff,
}));

vi.mock("./onboard-channels.js", () => ({
  setupChannels: onboardChannelsMocks.setupChannels,
}));

vi.mock("./onboard-helpers.js", () => ({
  ensureWorkspaceAndSessions: onboardHelpersMocks.ensureWorkspaceAndSessions,
}));

import { WizardCancelledError } from "../wizard/prompts.js";
import { agentsAddCommand } from "./agents.commands.add.js";

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
    readConfigFileSnapshotMock.mockClear();
    writeConfigFileMock.mockClear();
    replaceConfigFileMock.mockClear();
    commitConfigWithPendingPluginInstallsMock.mockClear();
    transformConfigWithPendingPluginInstallsMock.mockClear();
    checkAgentCreationGateMock.mockReset().mockResolvedValue(undefined);
    createAgentMock.mockReset();
    createAgentMock.mockImplementation(
      async (params: {
        name?: string;
        workspace?: string;
        entry?: { id: string; name?: string; workspace?: string; agentDir?: string };
        bindingSpecs?: string[];
        stagedConfig?: Record<string, unknown>;
      }) => {
        const name = params.name ?? params.entry?.name ?? params.entry?.id ?? "";
        const agentId = (params.entry?.id ?? name).toLowerCase();
        if (agentId === "openclaw" || agentId === "crestodian") {
          return { status: "error", reason: "reserved-id", agentId };
        }
        const binding = params.bindingSpecs?.[0]
          ? {
              type: "route",
              agentId,
              match: { channel: params.bindingSpecs[0].split(":")[0] },
            }
          : undefined;
        return {
          status: "created" as const,
          agentId,
          name,
          workspace: params.workspace ?? params.entry?.workspace ?? `/tmp/workspace-${agentId}`,
          agentDir: params.entry?.agentDir ?? `/tmp/agent-${agentId}`,
          bootstrapPending: true,
          config: params.stagedConfig ?? {},
          ...(binding
            ? {
                bindingResult: {
                  config: {},
                  added: [],
                  updated: [],
                  skipped: [],
                  conflicts: [{ binding, existingAgentId: "other-agent" }],
                },
              }
            : {}),
        };
      },
    );
    wizardMocks.createClackPrompter.mockClear();
    terminalMocks.isTerminalInteractive.mockReset().mockReturnValue(true);
    authChoiceMocks.applyAuthChoice.mockClear();
    authChoiceMocks.warnIfModelConfigLooksOff.mockClear();
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

  function stageChannelPostWriteHook(run: ChannelOnboardingPostWriteHook["run"]): void {
    onboardChannelsMocks.setupChannels.mockImplementationOnce(
      async (config, _runtime, _prompter, options) => {
        options?.onPostWriteHook?.({ channel: "matrix", accountId: "ops", run });
        return config;
      },
    );
  }

  it("requires --workspace when flags are present", async () => {
    readConfigFileSnapshotMock.mockResolvedValue({ ...baseConfigSnapshot });

    await agentsAddCommand({ name: "Work" }, runtime, { hasAutomationFlags: true });

    expect(runtime.error).toHaveBeenCalledOnce();
    expect(runtime.error).toHaveBeenCalledWith(
      `Non-interactive agent creation requires --workspace. Re-run ${formatCliCommand("openclaw agents add <id> --workspace <path>")} or omit flags to use the wizard.`,
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(writeConfigFileMock).not.toHaveBeenCalled();
  });

  it("requires --workspace in non-interactive mode", async () => {
    readConfigFileSnapshotMock.mockResolvedValue({ ...baseConfigSnapshot });

    await agentsAddCommand({ name: "Work", nonInteractive: true }, runtime, {
      hasAutomationFlags: false,
    });

    expect(runtime.error).toHaveBeenCalledOnce();
    expect(runtime.error).toHaveBeenCalledWith(
      `Non-interactive agent creation requires --workspace. Re-run ${formatCliCommand("openclaw agents add <id> --workspace <path>")} or omit flags to use the wizard.`,
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(writeConfigFileMock).not.toHaveBeenCalled();
  });

  it.each(RESERVED_SYSTEM_AGENT_IDS_FOR_TEST)(
    "rejects reserved system-agent id %s",
    async (name) => {
      readConfigFileSnapshotMock.mockResolvedValue({ ...baseConfigSnapshot });

      await agentsAddCommand({ name, workspace: "/tmp/reserved" }, runtime, {
        hasAutomationFlags: true,
      });

      expect(runtime.error).toHaveBeenCalledWith(
        `"${name}" is reserved. Choose another name, or run ${formatCliCommand("openclaw agents list")} to inspect configured agents.`,
      );
      expect(runtime.exit).toHaveBeenCalledWith(1);
      expect(writeConfigFileMock).not.toHaveBeenCalled();
    },
  );

  it("rejects an unrepresentable positional name before targeting an existing agent", async () => {
    readConfigFileSnapshotMock.mockResolvedValue({
      ...baseConfigSnapshot,
      config: { agents: { entries: { main: {} } } },
      sourceConfig: { agents: { entries: { main: {} } } },
    });
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

      await agentsAddCommand({ json }, runtime);

      expect(runtime.error).toHaveBeenCalledWith(
        "Agent creation needs an interactive TTY. Use `openclaw agents add <id> --non-interactive --workspace <dir>` for automation.",
      );
      expect(runtime.exit).toHaveBeenCalledWith(1);
      expect(runtime.log).not.toHaveBeenCalled();
      expect(terminalMocks.isTerminalInteractive).toHaveBeenCalledWith(output);
      expect(wizardMocks.createClackPrompter).not.toHaveBeenCalled();
      expect(createAgentMock).not.toHaveBeenCalled();
      expect(writeConfigFileMock).not.toHaveBeenCalled();
    },
  );

  it("uses the explicit agent target and skips catalog validation", async () => {
    readConfigFileSnapshotMock.mockResolvedValue({
      ...baseConfigSnapshot,
      config: { agents: { list: [{ id: "main", default: true }] } },
      sourceConfig: { agents: { list: [{ id: "main", default: true }] } },
    });
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
    const wizard = createQueuedWizardPrompter({
      textValues: ["/tmp/workspace-work"],
      confirmValues: [true, false],
    });
    wizardMocks.createClackPrompter.mockReturnValue(wizard.prompter);
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
    readConfigFileSnapshotMock.mockResolvedValue({
      ...baseConfigSnapshot,
      config: { agents: { entries: { robby: { id: "robby" } } } },
      sourceConfig: { agents: { entries: { robby: { id: "robby" } } } },
    });
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
    expect(authChoiceMocks.applyAuthChoice).not.toHaveBeenCalled();
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
      readConfigFileSnapshotMock.mockResolvedValue({
        ...baseConfigSnapshot,
        config: { agents: { list: [{ id: "main", default: true }] } },
        sourceConfig: { agents: { list: [{ id: "main", default: true }] } },
      });
      const prompter = {
        intro: vi.fn(),
        text: vi.fn().mockResolvedValueOnce("work").mockResolvedValueOnce(workspaceDir),
        confirm: vi.fn().mockResolvedValue(false),
        note: vi.fn(),
        outro: vi.fn(),
      };
      wizardMocks.createClackPrompter.mockReturnValue(prompter);

      await expect(agentsAddCommand({}, runtime)).rejects.toThrow(
        /auth profile store .* is unreadable; run .*doctor --fix/i,
      );

      expect(writeConfigFileMock).not.toHaveBeenCalled();
      expect(prompter.outro).not.toHaveBeenCalled();
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

  it("keeps guided auth written after portable copy acceptance when finalizing the copy", async () => {
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
      authChoiceMocks.applyAuthChoice.mockImplementationOnce(async ({ config, agentDir }) => {
        saveAuthProfileStore(
          {
            version: AUTH_STORE_VERSION,
            profiles: {
              "openai:api-key": {
                type: "api_key",
                provider: "openai",
                key: "guided-wins",
              },
              "openai:guided": {
                type: "api_key",
                provider: "openai",
                key: "guided-retained",
              },
            },
            order: { openai: ["openai:guided", "openai:api-key"] },
          },
          agentDir,
        );
        return { config, retrySelection: false };
      });

      await agentsAddCommand({}, runtime);

      const persisted = loadPersistedAuthProfileStore(destAgentDir);
      expect(persisted?.profiles).toMatchObject({
        "openai:api-key": { key: "guided-wins" },
        "openai:portable": { key: "portable-retained" },
        "openai:guided": { key: "guided-retained" },
      });
      expect(persisted?.order?.openai).toEqual(["openai:guided", "openai:api-key"]);
      expect(wizard.note).toHaveBeenCalledWith(
        'Copied 2 portable auth profiles from "main".',
        "Auth profiles",
      );
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
      readConfigFileSnapshotMock.mockResolvedValue({
        ...baseConfigSnapshot,
        config: { agents: { list: [{ id: "main", default: true }] } },
        sourceConfig: { agents: { list: [{ id: "main", default: true }] } },
      });
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

    it("reports a duplicate rejected by the canonical service", async () => {
      readConfigFileSnapshotMock.mockResolvedValue({
        ...baseConfigSnapshot,
        config: { agents: { list: [{ id: "main", default: true }] } },
        sourceConfig: { agents: { list: [{ id: "main", default: true }] } },
      });
      createAgentMock.mockResolvedValueOnce({
        status: "error",
        reason: "already-exists",
        agentId: "work",
        message: 'agent "work" already exists',
      });

      await agentsAddCommand({ name: "Work", workspace: "/tmp/work" }, runtime, {
        hasAutomationFlags: true,
      });

      expect(writeConfigFileMock).not.toHaveBeenCalled();
      expect(runtime.error).toHaveBeenCalledWith('Agent "work" already exists.');
      expect(runtime.exit).toHaveBeenCalledWith(1);
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
