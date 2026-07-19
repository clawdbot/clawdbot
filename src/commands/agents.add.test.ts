// Agents add tests cover agent creation, workspace setup, channel binding, and onboarding integration.
import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AUTH_STORE_VERSION } from "../agents/auth-profiles/constants.js";
import { resolveAuthProfileOrder } from "../agents/auth-profiles/order.js";
import { loadPersistedAuthProfileStore } from "../agents/auth-profiles/persisted.js";
import { saveAuthProfileStore } from "../agents/auth-profiles/store.js";
import { formatCliCommand } from "../cli/command-format.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { createSuiteTempRootTracker } from "../test-helpers/temp-dir.js";
import { withEnvAsync } from "../test-utils/env.js";
import { baseConfigSnapshot, createTestRuntime } from "./test-runtime-config-helpers.js";

const readConfigFileSnapshotMock = vi.hoisted(() => vi.fn());
const writeConfigFileMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const replaceConfigFileMock = vi.hoisted(() =>
  vi.fn(async (params: { nextConfig: unknown }) => await writeConfigFileMock(params.nextConfig)),
);
const createAgentMock = vi.hoisted(() => vi.fn());
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
const authChoiceMocks = vi.hoisted(() => ({
  applyAuthChoice: vi.fn(),
  warnIfModelConfigLooksOff: vi.fn(async () => {}),
}));
const onboardChannelsMocks = vi.hoisted(() => ({
  setupChannels: vi.fn(async (config: Record<string, unknown>) => config),
}));
const onboardHelpersMocks = vi.hoisted(() => ({
  ensureWorkspaceAndSessions: vi.fn(async () => {}),
}));

vi.mock("../config/config.js", async () => ({
  ...(await vi.importActual<typeof import("../config/config.js")>("../config/config.js")),
  readConfigFileSnapshot: readConfigFileSnapshotMock,
  writeConfigFile: writeConfigFileMock,
  replaceConfigFile: replaceConfigFileMock,
}));

vi.mock("../agents/agent-create.js", () => ({ createAgent: createAgentMock }));

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
import { agentsAddCommand, testing } from "./agents.commands.add.js";

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
    createAgentMock.mockReset();
    createAgentMock.mockImplementation(
      async (params: { name: string; workspace: string; bindingSpecs?: string[] }) => {
        const agentId = params.name.toLowerCase();
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
          name: params.name,
          workspace: params.workspace,
          agentDir: `/tmp/agent-${agentId}`,
          bootstrapPending: true,
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

  it("requires --workspace when flags are present", async () => {
    readConfigFileSnapshotMock.mockResolvedValue({ ...baseConfigSnapshot });

    await agentsAddCommand({ name: "Work" }, runtime, { hasFlags: true });

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
      hasFlags: false,
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

      await agentsAddCommand({ name, workspace: "/tmp/reserved" }, runtime, { hasFlags: true });

      expect(runtime.error).toHaveBeenCalledWith(
        `"${name}" is reserved. Choose another name, or run ${formatCliCommand("openclaw agents list")} to inspect configured agents.`,
      );
      expect(runtime.exit).toHaveBeenCalledWith(1);
      expect(writeConfigFileMock).not.toHaveBeenCalled();
    },
  );

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

  it("skips catalog validation when checking the interactive wizard model config", async () => {
    readConfigFileSnapshotMock.mockResolvedValue({
      ...baseConfigSnapshot,
      config: { agents: { list: [] } },
      sourceConfig: { agents: { list: [] } },
    });
    wizardMocks.createClackPrompter.mockReturnValue({
      intro: vi.fn(),
      text: vi.fn().mockResolvedValueOnce("Jon").mockResolvedValueOnce("/tmp/openclaw-jon"),
      confirm: vi.fn().mockResolvedValue(false),
      note: vi.fn(),
      outro: vi.fn(),
    });

    await agentsAddCommand({}, runtime);

    expect(authChoiceMocks.warnIfModelConfigLooksOff).toHaveBeenCalledOnce();
    expect(authChoiceMocks.warnIfModelConfigLooksOff).toHaveBeenCalledWith(
      expect.objectContaining({ agents: expect.any(Object) }),
      expect.any(Object),
      expect.objectContaining({
        agentId: "jon",
        validateCatalog: false,
      }),
    );
  });

  it("copies only portable auth profiles when seeding a new agent store", async () => {
    await withAgentsAddStateRoot("openclaw-agents-add-auth-copy-", async (root) => {
      const sourceAgentDir = path.join(root, "main", "agent");
      const destAgentDir = path.join(root, "work", "agent");
      await fs.mkdir(sourceAgentDir, { recursive: true });
      saveAuthProfileStore(
        {
          version: AUTH_STORE_VERSION,
          profiles: {
            "openai:default": {
              type: "api_key",
              provider: "openai",
              key: "sk-test",
            },
            "openai:backup": {
              type: "api_key",
              provider: "openai",
              key: "sk-backup",
            },
            "github-copilot:default": {
              type: "token",
              provider: "github-copilot",
              token: "gho-test",
            },
            "openai:oauth": {
              type: "oauth",
              provider: "openai",
              access: "codex-access",
              refresh: "codex-refresh",
              expires: Date.now() + 60_000,
            },
          },
          order: {
            openai: ["openai:oauth", "openai:backup", "openai:default"],
            "github-copilot": ["github-copilot:default"],
          },
          lastGood: { openai: "openai:default" },
          usageStats: { "openai:default": { lastUsed: 1_000 } },
        },
        sourceAgentDir,
      );

      const result = await testing.copyPortableAuthProfiles({
        sourceAgentDir,
        destAgentDir,
      });

      expect(result).toEqual({ copied: 3, skipped: 1 });
      const copied = loadPersistedAuthProfileStore(destAgentDir);
      expect(Object.keys(copied?.profiles ?? {}).toSorted()).toEqual([
        "github-copilot:default",
        "openai:backup",
        "openai:default",
      ]);
      expect(copied?.order).toEqual({
        openai: ["openai:backup", "openai:default"],
        "github-copilot": ["github-copilot:default"],
      });
      expect(copied?.lastGood).toBeUndefined();
      expect(copied?.usageStats).toBeUndefined();
      expect(resolveAuthProfileOrder({ store: copied!, provider: "openai" })).toEqual([
        "openai:backup",
        "openai:default",
      ]);
    });
  });

  it("copies portable Codex OAuth profiles inline", async () => {
    await withAgentsAddStateRoot("openclaw-agents-add-oauth-copy-", async (root) => {
      const sourceAgentDir = path.join(root, "main", "agent");
      const destAgentDir = path.join(root, "work", "agent");
      const expires = Date.now() + 60_000;
      await fs.mkdir(sourceAgentDir, { recursive: true });
      saveAuthProfileStore(
        {
          version: AUTH_STORE_VERSION,
          profiles: {
            "openai:oauth": {
              type: "oauth",
              provider: "openai",
              access: "codex-copy-access-token",
              refresh: "codex-copy-refresh-token",
              expires,
              copyToAgents: true,
            },
          },
        },
        sourceAgentDir,
      );

      const result = await testing.copyPortableAuthProfiles({
        sourceAgentDir,
        destAgentDir,
      });

      expect(result).toEqual({ copied: 1, skipped: 0 });
      const copied = loadPersistedAuthProfileStore(destAgentDir);
      const credential = copied?.profiles["openai:oauth"];
      expect(credential).toStrictEqual({
        type: "oauth",
        provider: "openai",
        access: "codex-copy-access-token",
        refresh: "codex-copy-refresh-token",
        expires,
        copyToAgents: true,
      });
    });
  });

  it("skips unresolved OAuth profiles when seeding a new agent store", async () => {
    await withAgentsAddStateRoot("openclaw-agents-add-oauth-ref-skip-", async (root) => {
      const sourceAgentDir = path.join(root, "main", "agent");
      const destAgentDir = path.join(root, "work", "agent");
      const profileId = "openai:oauth";
      const ref = {
        source: "openclaw-credentials" as const,
        provider: "openai" as const,
        id: "0123456789abcdef0123456789abcdef",
      };
      await fs.mkdir(sourceAgentDir, { recursive: true });
      saveAuthProfileStore(
        {
          version: AUTH_STORE_VERSION,
          profiles: {
            [profileId]: {
              type: "oauth",
              provider: "openai",
              copyToAgents: true,
              expires: Date.now() + 60_000,
              oauthRef: ref,
            },
          },
        } as never,
        sourceAgentDir,
      );
      const result = await testing.copyPortableAuthProfiles({
        sourceAgentDir,
        destAgentDir,
      });

      expect(result).toEqual({ copied: 0, skipped: 1 });
      expect(loadPersistedAuthProfileStore(destAgentDir)).toBeNull();
    });
  });

  it("does not claim skipped OAuth profiles stay shared from a non-main source agent", () => {
    expect(
      testing.formatSkippedOAuthProfilesMessage({
        sourceAgentId: "default-work",
        sourceIsInheritedMain: false,
      }),
    ).toBe(
      'OAuth profiles were not copied from "default-work"; sign in separately for this agent.',
    );
    expect(
      testing.formatSkippedOAuthProfilesMessage({
        sourceAgentId: "main",
        sourceIsInheritedMain: true,
      }),
    ).toBe('OAuth profiles stay shared from "main" unless this agent signs in separately.');
  });

  describe("non-interactive config mutation", () => {
    it("delegates creation to the canonical service", async () => {
      readConfigFileSnapshotMock.mockResolvedValue({
        ...baseConfigSnapshot,
        config: { agents: { list: [] } },
        sourceConfig: { agents: { list: [] } },
      });

      await agentsAddCommand({ name: "Work", workspace: "/tmp/work" }, runtime, {
        hasFlags: true,
      });

      expect(createAgentMock).toHaveBeenCalledWith({
        name: "Work",
        workspace: "/tmp/work",
        transformConfig: transformConfigWithPendingPluginInstallsMock,
      });
      expect(transformConfigWithPendingPluginInstallsMock).not.toHaveBeenCalled();
      expect(runtime.exit).not.toHaveBeenCalled();
      expect(runtime.error).not.toHaveBeenCalled();
    });

    it("reports a duplicate rejected by the canonical service", async () => {
      readConfigFileSnapshotMock.mockResolvedValue({
        ...baseConfigSnapshot,
        config: { agents: { list: [] } },
        sourceConfig: { agents: { list: [] } },
      });
      createAgentMock.mockResolvedValueOnce({
        status: "error",
        reason: "already-exists",
        agentId: "work",
        message: 'agent "work" already exists',
      });

      await agentsAddCommand({ name: "Work", workspace: "/tmp/work" }, runtime, {
        hasFlags: true,
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
          config: { agents: { list: [] } },
          sourceConfig: { agents: { list: [] } },
        })
        .mockResolvedValueOnce({
          ...baseConfigSnapshot,
          hash: "hash-2",
          config: {
            agents: { list: [{ id: "other-agent" }] },
            bindings: [{ type: "route", agentId: "other-agent", match: { channel: "telegram" } }],
          },
          sourceConfig: {
            agents: { list: [{ id: "other-agent" }] },
            bindings: [{ type: "route", agentId: "other-agent", match: { channel: "telegram" } }],
          },
        });

      await agentsAddCommand(
        { name: "Work", workspace: "/tmp/work", bind: ["telegram"], json: true },
        runtime,
        { hasFlags: true },
      );

      const payload = JSON.parse(String(runtime.log.mock.calls.at(-1)?.[0])) as {
        bindings: { added: string[]; conflicts: string[] };
      };
      expect(payload.bindings.added).toEqual([]);
      expect(payload.bindings.conflicts).toEqual(["telegram (agent=other-agent)"]);
    });
  });
});
