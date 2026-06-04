import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AUTH_STORE_VERSION } from "../agents/auth-profiles/constants.js";
import { loadPersistedAuthProfileStore } from "../agents/auth-profiles/persisted.js";
import { saveAuthProfileStore } from "../agents/auth-profiles/store.js";
import { formatCliCommand } from "../cli/command-format.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { baseConfigSnapshot, createTestRuntime } from "./test-runtime-config-helpers.js";

const readConfigFileSnapshotMock = vi.hoisted(() => vi.fn());
const writeConfigFileMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const replaceConfigFileMock = vi.hoisted(() =>
  vi.fn(async (params: { nextConfig: unknown }) => await writeConfigFileMock(params.nextConfig)),
);
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

vi.mock("../cli/plugins-install-record-commit.js", async () => ({
  ...(await vi.importActual<typeof import("../cli/plugins-install-record-commit.js")>(
    "../cli/plugins-install-record-commit.js",
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

describe("agents add command", () => {
  beforeEach(() => {
    readConfigFileSnapshotMock.mockClear();
    writeConfigFileMock.mockClear();
    replaceConfigFileMock.mockClear();
    commitConfigWithPendingPluginInstallsMock.mockClear();
    transformConfigWithPendingPluginInstallsMock.mockClear();
    wizardMocks.createClackPrompter.mockClear();
    authChoiceMocks.applyAuthChoice.mockClear();
    authChoiceMocks.warnIfModelConfigLooksOff.mockClear();
    onboardChannelsMocks.setupChannels.mockClear();
    onboardHelpersMocks.ensureWorkspaceAndSessions.mockClear();
    runtime.log.mockClear();
    runtime.error.mockClear();
    runtime.exit.mockClear();
  });

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
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-agents-add-auth-copy-"));
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = root;
    try {
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
        },
        sourceAgentDir,
      );

      const result = await testing.copyPortableAuthProfiles({
        sourceAgentDir,
        destAgentDir,
      });

      expect(result).toEqual({ copied: 2, skipped: 1 });
      const copied = loadPersistedAuthProfileStore(destAgentDir);
      expect(Object.keys(copied?.profiles ?? {}).toSorted()).toEqual([
        "github-copilot:default",
        "openai:default",
      ]);
    } finally {
      closeOpenClawAgentDatabasesForTest();
      closeOpenClawStateDatabaseForTest();
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("copies portable Codex OAuth profiles inline", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-agents-add-oauth-copy-"));
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = root;
    try {
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
    } finally {
      closeOpenClawAgentDatabasesForTest();
      closeOpenClawStateDatabaseForTest();
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("skips unresolved OAuth profiles when seeding a new agent store", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-agents-add-oauth-ref-skip-"));
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = root;
    try {
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
    } finally {
      closeOpenClawAgentDatabasesForTest();
      closeOpenClawStateDatabaseForTest();
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
      await fs.rm(root, { recursive: true, force: true });
    }
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
    it("rebases agent creation on the latest config snapshot", async () => {
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
          config: { agents: { list: [{ id: "other-agent" }] } },
          sourceConfig: { agents: { list: [{ id: "other-agent" }] } },
        });

      await agentsAddCommand({ name: "Work", workspace: "/tmp/work" }, runtime, {
        hasFlags: true,
      });

      expect(transformConfigWithPendingPluginInstallsMock).toHaveBeenCalledOnce();
      expect(writeConfigFileMock).toHaveBeenCalledWith(
        expect.objectContaining({
          agents: {
            list: [
              { id: "other-agent" },
              expect.objectContaining({ id: "work", workspace: "/tmp/work" }),
            ],
          },
        }),
      );
      expect(runtime.exit).not.toHaveBeenCalled();
      expect(runtime.error).not.toHaveBeenCalled();
    });

    it("fails instead of overwriting when the same agent appears before commit", async () => {
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
          config: { agents: { list: [{ id: "work", workspace: "/tmp/other" }] } },
          sourceConfig: { agents: { list: [{ id: "work", workspace: "/tmp/other" }] } },
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
