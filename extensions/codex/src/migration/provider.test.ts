// Codex tests cover provider plugin behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  loadAuthProfileStoreForSecretsRuntime,
} from "openclaw/plugin-sdk/agent-runtime";
import type { MigrationProviderContext } from "openclaw/plugin-sdk/plugin-entry";
import { upsertAuthProfile } from "openclaw/plugin-sdk/provider-auth";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultCodexAppInventoryCache } from "../app-server/app-inventory-cache.js";
import { CODEX_PLUGINS_MARKETPLACE_NAME } from "../app-server/config.js";
import { buildCodexPluginAppCacheKey } from "../app-server/plugin-app-cache-key.js";
import type { CodexGetAccountResponse, v2 } from "../app-server/protocol.js";
import { buildCodexMigrationProvider } from "./provider.js";

const appServerRequest = vi.hoisted(() => vi.fn());

vi.mock("../app-server/request.js", () => ({
  requestCodexAppServerJson: appServerRequest,
}));

const tempRoots = new Set<string>();

const logger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
};

async function makeTempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-migrate-codex-"));
  tempRoots.add(root);
  return root;
}

async function writeFile(filePath: string, content = ""): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf8");
}

function makeContext(params: {
  source: string;
  stateDir: string;
  workspaceDir: string;
  overwrite?: boolean;
  includeSecrets?: boolean;
  targetAgentId?: string;
  itemKinds?: readonly string[];
  verifyPluginApps?: boolean;
  providerOptions?: MigrationProviderContext["providerOptions"];
  reportDir?: string;
  config?: MigrationProviderContext["config"];
  runtime?: MigrationProviderContext["runtime"];
}): MigrationProviderContext {
  return {
    config:
      params.config ??
      ({
        agents: {
          defaults: {
            workspace: params.workspaceDir,
          },
        },
      } as MigrationProviderContext["config"]),
    runtime: params.runtime,
    source: params.source,
    stateDir: params.stateDir,
    includeSecrets: params.includeSecrets,
    targetAgentId: params.targetAgentId,
    itemKinds: params.itemKinds,
    overwrite: params.overwrite,
    providerOptions:
      params.providerOptions ?? (params.verifyPluginApps ? { verifyPluginApps: true } : undefined),
    reportDir: params.reportDir,
    logger,
  };
}

function findItem(items: readonly { id?: string }[], id: string) {
  const item = items.find((entry) => entry.id === id);
  if (!item) {
    throw new Error(`Expected migration item ${id}`);
  }
  return item as Record<string, unknown>;
}

function findItemByReason(items: readonly { reason?: string }[], reason: string) {
  const item = items.find((entry) => entry.reason === reason);
  if (!item) {
    throw new Error(`Expected migration item reason ${reason}`);
  }
  return item as Record<string, unknown>;
}

function expectRecordFields(record: unknown, expected: Record<string, unknown>) {
  if (!record || typeof record !== "object") {
    throw new Error("Expected record");
  }
  const actual = record as Record<string, unknown>;
  for (const [key, value] of Object.entries(expected)) {
    expect(actual[key]).toEqual(value);
  }
  return actual;
}

function fakeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.signature`;
}

function mockCallArg(mock: ReturnType<typeof vi.fn>, callIndex = 0, argIndex = 0) {
  const call = mock.mock.calls[callIndex];
  if (!call) {
    throw new Error(`Expected mock call ${callIndex}`);
  }
  return call[argIndex];
}

function targetAgentDir(fixture: { stateDir: string }): string {
  return path.join(fixture.stateDir, "agents", "main", "agent");
}

function loadTargetAuthStore(fixture: { stateDir: string }) {
  return loadAuthProfileStoreForSecretsRuntime(targetAgentDir(fixture));
}

async function createCodexFixture(): Promise<{
  root: string;
  homeDir: string;
  codexHome: string;
  stateDir: string;
  workspaceDir: string;
}> {
  const root = await makeTempRoot();
  const homeDir = path.join(root, "home");
  const codexHome = path.join(root, ".codex");
  const stateDir = path.join(root, "state");
  const workspaceDir = path.join(root, "workspace");
  vi.stubEnv("HOME", homeDir);
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  vi.stubEnv("OPENCLAW_AGENT_DIR", "");
  await writeFile(path.join(codexHome, "skills", "tweet-helper", "SKILL.md"), "# Tweet helper\n");
  await writeFile(path.join(codexHome, "skills", ".system", "system-skill", "SKILL.md"));
  await writeFile(path.join(homeDir, ".agents", "skills", "personal-style", "SKILL.md"));
  await writeFile(
    path.join(
      codexHome,
      "plugins",
      "cache",
      "openai-primary-runtime",
      "documents",
      "1.0.0",
      ".codex-plugin",
      "plugin.json",
    ),
    JSON.stringify({ name: "documents" }),
  );
  await writeFile(path.join(codexHome, "config.toml"), 'model = "gpt-5.5"\n');
  await writeFile(path.join(codexHome, "hooks", "hooks.json"), "{}\n");
  return { root, homeDir, codexHome, stateDir, workspaceDir };
}

function sourceAppCacheKey(fixture: { codexHome: string }): string {
  return buildCodexPluginAppCacheKey({
    appServer: {
      start: {
        transport: "stdio",
        command: "codex",
        commandSource: "managed",
        managedCommandOrder: "desktop-first",
        args: ["app-server", "--listen", "stdio://"],
        headers: {},
        env: {
          CODEX_HOME: fixture.codexHome,
          HOME: path.dirname(fixture.codexHome),
        },
      },
    },
  });
}

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  clearRuntimeAuthProfileStoreSnapshots();
  appServerRequest.mockReset();
  defaultCodexAppInventoryCache.clear();
  for (const root of tempRoots) {
    await fs.rm(root, { recursive: true, force: true });
  }
  tempRoots.clear();
});

describe("buildCodexMigrationProvider", () => {
  beforeEach(() => {
    appServerRequest.mockRejectedValue(new Error("codex app-server unavailable"));
  });

  it("plans and imports only consolidated Codex memory into the selected agent", async () => {
    const fixture = await createCodexFixture();
    const targetWorkspace = path.join(fixture.root, "workspace-research");
    const reportDir = path.join(fixture.root, "report");
    await writeFile(path.join(fixture.codexHome, "memories", "MEMORY.md"), "# Memory\n");
    await writeFile(path.join(fixture.codexHome, "memories", "memory_summary.md"), "# Summary\n");
    await writeFile(
      path.join(fixture.codexHome, "memories", "rollout_summaries", "private.md"),
      "# Raw rollout\n",
    );
    const config = {
      agents: {
        defaults: { workspace: fixture.workspaceDir },
        list: [
          { id: "main", default: true },
          { id: "research", workspace: targetWorkspace },
        ],
      },
    } as MigrationProviderContext["config"];
    const context = makeContext({
      source: fixture.codexHome,
      stateDir: fixture.stateDir,
      workspaceDir: fixture.workspaceDir,
      reportDir,
      config,
      targetAgentId: "research",
      itemKinds: ["memory"],
      verifyPluginApps: true,
    });
    const provider = buildCodexMigrationProvider();

    const plan = await provider.plan(context);

    expect(appServerRequest).not.toHaveBeenCalled();
    expect(plan.items.map((item) => item.id)).toEqual([
      "memory:codex:MEMORY.md",
      "memory:codex:memory_summary.md",
    ]);
    expect(plan.items.every((item) => item.kind === "memory")).toBe(true);
    expect(plan.items.every((item) => item.target?.startsWith(targetWorkspace))).toBe(true);

    const result = await provider.apply(context, plan);

    expect(result.summary).toMatchObject({ migrated: 2, errors: 0, conflicts: 0 });
    await expect(
      fs.readFile(path.join(targetWorkspace, "memory", "imports", "codex", "MEMORY.md"), "utf8"),
    ).resolves.toBe("# Memory\n");
    await expect(
      fs.access(path.join(targetWorkspace, "memory", "imports", "codex", "private.md")),
    ).rejects.toThrow();
  });

  it("skips unrelated Codex app-server preparation for memory-only imports", async () => {
    const fixture = await createCodexFixture();
    const provider = buildCodexMigrationProvider();
    const preparation = provider.prepareApply?.(
      makeContext({
        source: fixture.codexHome,
        stateDir: fixture.stateDir,
        workspaceDir: fixture.workspaceDir,
        itemKinds: ["memory"],
      }),
    );

    expect(preparation).toBeUndefined();
  });

  it("rejects non-file Codex consolidated memory candidates", async () => {
    const fixture = await createCodexFixture();
    await fs.mkdir(path.join(fixture.codexHome, "memories", "MEMORY.md"), {
      recursive: true,
    });
    const provider = buildCodexMigrationProvider();

    await expect(
      provider.plan(
        makeContext({
          source: fixture.codexHome,
          stateDir: fixture.stateDir,
          workspaceDir: fixture.workspaceDir,
          itemKinds: ["memory"],
        }),
      ),
    ).rejects.toThrow("must be a regular file");
  });

  it.runIf(process.platform !== "win32")(
    "rejects symlinked Codex consolidated memory candidates",
    async () => {
      const fixture = await createCodexFixture();
      const actualMemory = path.join(fixture.root, "actual-memory.md");
      const memoryPath = path.join(fixture.codexHome, "memories", "MEMORY.md");
      await writeFile(actualMemory, "# Memory\n");
      await fs.mkdir(path.dirname(memoryPath), { recursive: true });
      await fs.symlink(actualMemory, memoryPath);
      const provider = buildCodexMigrationProvider();

      await expect(
        provider.plan(
          makeContext({
            source: fixture.codexHome,
            stateDir: fixture.stateDir,
            workspaceDir: fixture.workspaceDir,
            itemKinds: ["memory"],
          }),
        ),
      ).rejects.toThrow("must not be a symbolic link");
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects a symlinked import destination that resolves into Codex memory",
    async () => {
      const fixture = await createCodexFixture();
      const memoryDir = path.join(fixture.codexHome, "memories");
      await writeFile(path.join(memoryDir, "MEMORY.md"), "# Memory\n");
      await fs.mkdir(fixture.workspaceDir, { recursive: true });
      await fs.symlink(memoryDir, path.join(fixture.workspaceDir, "memory"));
      const provider = buildCodexMigrationProvider();

      await expect(
        provider.plan(
          makeContext({
            source: fixture.codexHome,
            stateDir: fixture.stateDir,
            workspaceDir: fixture.workspaceDir,
            itemKinds: ["memory"],
          }),
        ),
      ).rejects.toThrow("destination must stay in the selected workspace");
    },
  );

  it("plans Codex skills while keeping plugins and native config explicit", async () => {
    const fixture = await createCodexFixture();
    const provider = buildCodexMigrationProvider();

    const plan = await provider.plan(
      makeContext({
        source: fixture.codexHome,
        stateDir: fixture.stateDir,
        workspaceDir: fixture.workspaceDir,
        verifyPluginApps: true,
      }),
    );

    expect(plan.providerId).toBe("codex");
    expect(plan.source).toBe(fixture.codexHome);
    expectRecordFields(findItem(plan.items, "skill:tweet-helper"), {
      kind: "skill",
      action: "copy",
      status: "planned",
      target: path.join(fixture.workspaceDir, "skills", "tweet-helper"),
    });
    expectRecordFields(findItem(plan.items, "skill:personal-style"), {
      kind: "skill",
      action: "copy",
      status: "planned",
      target: path.join(fixture.workspaceDir, "skills", "personal-style"),
    });
    expectRecordFields(findItem(plan.items, "plugin:documents:1"), {
      kind: "manual",
      action: "manual",
      status: "skipped",
    });
    expectRecordFields(findItem(plan.items, "archive:config.toml"), {
      kind: "archive",
      action: "archive",
      status: "planned",
    });
    expectRecordFields(findItem(plan.items, "archive:hooks/hooks.json"), {
      kind: "archive",
      action: "archive",
      status: "planned",
    });
    expect(plan.items.some((item) => item.id === "skill:system-skill")).toBe(false);
  });

  it("plans source-installed curated plugins without installing during dry-run", async () => {
    const fixture = await createCodexFixture();
    appServerRequest.mockImplementation(async ({ method }: { method: string }) => {
      if (method === "plugin/list") {
        return pluginList([pluginSummary("google-calendar", { installed: true, enabled: true })]);
      }
      if (method === "plugin/read") {
        return pluginRead("google-calendar");
      }
      throw new Error(`unexpected request ${method}`);
    });
    const provider = buildCodexMigrationProvider();

    const plan = await provider.plan(
      makeContext({
        source: fixture.codexHome,
        stateDir: fixture.stateDir,
        workspaceDir: fixture.workspaceDir,
        verifyPluginApps: true,
      }),
    );

    expect(appServerRequest).toHaveBeenCalledTimes(2);
    expectRecordFields(mockCallArg(appServerRequest), {
      method: "plugin/list",
      requestParams: { cwds: [] },
    });
    expectRecordFields((mockCallArg(appServerRequest) as { startOptions?: unknown }).startOptions, {
      command: "codex",
      commandSource: "managed",
      managedCommandOrder: "desktop-first",
      env: {
        CODEX_HOME: fixture.codexHome,
        HOME: path.dirname(fixture.codexHome),
      },
    });
    expect(
      appServerRequest.mock.calls.some(
        ([arg]) => (arg as { method?: string }).method === "plugin/install",
      ),
    ).toBe(false);
    const pluginItem = findItem(plan.items, "plugin:google-calendar");
    expectRecordFields(pluginItem, {
      kind: "plugin",
      action: "install",
      status: "planned",
    });
    expectRecordFields(pluginItem.details, {
      configKey: "google-calendar",
      marketplaceName: CODEX_PLUGINS_MARKETPLACE_NAME,
      pluginName: "google-calendar",
    });
    expectRecordFields(findItem(plan.items, "config:codex-plugins"), {
      kind: "config",
      action: "merge",
      status: "planned",
    });
  });

  it("imports Codex auth.json OAuth and seeds cached OpenAI Codex models", async () => {
    const fixture = await createCodexFixture();
    const reportDir = path.join(fixture.root, "report");
    const configState: MigrationProviderContext["config"] = {
      agents: {
        defaults: {
          model: { fallbacks: [] },
          workspace: fixture.workspaceDir,
        },
      },
    } as MigrationProviderContext["config"];
    const accessToken = fakeJwt({
      exp: Math.floor(Date.now() / 1000) + 3600,
      "https://api.openai.com/profile": { email: "codex@example.test" },
      "https://api.openai.com/auth": {
        chatgpt_account_id: "acct_test",
        chatgpt_plan_type: "plus",
      },
    });
    await writeFile(
      path.join(fixture.codexHome, "auth.json"),
      JSON.stringify({
        auth_mode: "chatgpt",
        tokens: {
          access_token: accessToken,
          refresh_token: "refresh-test-token",
          id_token: "id-test-token",
          account_id: "acct_test",
        },
      }),
    );
    await writeFile(
      path.join(fixture.codexHome, "models_cache.json"),
      JSON.stringify({ models: [{ slug: "gpt-5.5" }, { slug: "gpt-5.4-mini" }] }),
    );
    const provider = buildCodexMigrationProvider();

    const skippedPlan = await provider.plan(
      makeContext({
        source: fixture.codexHome,
        stateDir: fixture.stateDir,
        workspaceDir: fixture.workspaceDir,
      }),
    );
    expectRecordFields(findItem(skippedPlan.items, "auth:openai"), {
      kind: "auth",
      status: "skipped",
      sensitive: true,
    });

    const ctx = makeContext({
      source: fixture.codexHome,
      stateDir: fixture.stateDir,
      workspaceDir: fixture.workspaceDir,
      config: configState,
      runtime: createConfigRuntime(configState),
      reportDir,
      includeSecrets: true,
    });
    const plan = await provider.plan(ctx);
    expectRecordFields(findItem(plan.items, "auth:openai"), {
      kind: "auth",
      status: "planned",
      sensitive: true,
    });

    const result = await provider.apply(ctx, plan);

    expectRecordFields(findItem(result.items, "auth:openai"), { status: "migrated" });
    const authStore = loadTargetAuthStore(fixture);
    expect(authStore.profiles?.["openai:account-acct_test"]).toEqual(
      expect.objectContaining({
        type: "oauth",
        provider: "openai",
        access: accessToken,
        refresh: "refresh-test-token",
      }),
    );
    expect(configState.auth?.profiles?.["openai:account-acct_test"]).toEqual(
      expect.objectContaining({
        provider: "openai",
        mode: "oauth",
      }),
    );
    expect(configState.agents?.defaults?.models?.["openai/gpt-5.4-mini"]).toEqual({});
    expect(configState.agents?.defaults?.models?.["openai/gpt-5.5"]).toEqual({});
    expect(configState.agents?.defaults?.models?.["openai/gpt-5.6-sol"]).toEqual({});
    expect(configState.agents?.defaults?.model).toEqual({
      fallbacks: [],
      primary: "openai/gpt-5.6-sol",
    });
  });

  it("reports Codex OAuth config auth profile conflicts during planning", async () => {
    const fixture = await createCodexFixture();
    const accessToken = fakeJwt({
      "https://api.openai.com/auth": {
        chatgpt_account_id: "acct_conflict",
        chatgpt_plan_type: "plus",
      },
      "https://api.openai.com/profile": {
        email: "codex@example.test",
      },
    });
    await writeFile(
      path.join(fixture.codexHome, "auth.json"),
      JSON.stringify({
        auth_mode: "chatgpt",
        tokens: {
          access_token: accessToken,
          refresh_token: "refresh-conflict-token",
          account_id: "acct_conflict",
        },
      }),
    );
    const configState: MigrationProviderContext["config"] = {
      agents: {
        defaults: {
          workspace: fixture.workspaceDir,
        },
      },
      auth: {
        profiles: {
          "openai:account-acct_conflict": {
            provider: "openai",
            mode: "api_key",
          },
        },
      },
    };
    const provider = buildCodexMigrationProvider();

    const plan = await provider.plan(
      makeContext({
        source: fixture.codexHome,
        stateDir: fixture.stateDir,
        workspaceDir: fixture.workspaceDir,
        config: configState,
        includeSecrets: true,
      }),
    );

    expect(findItem(plan.items, "auth:openai")).toEqual(
      expect.objectContaining({
        status: "conflict",
        reason: "auth profile exists",
        details: expect.objectContaining({
          profileId: "openai:account-acct_conflict",
        }),
      }),
    );
  });

  it("reports late-created Codex API key config auth profile conflicts before writing", async () => {
    const fixture = await createCodexFixture();
    const reportDir = path.join(fixture.root, "report");
    await writeFile(
      path.join(fixture.codexHome, "auth.json"),
      JSON.stringify({ OPENAI_API_KEY: "sk-codex" }),
    );
    const configState: MigrationProviderContext["config"] = {
      agents: {
        defaults: {
          workspace: fixture.workspaceDir,
        },
      },
    };
    const provider = buildCodexMigrationProvider();
    const ctx = makeContext({
      source: fixture.codexHome,
      stateDir: fixture.stateDir,
      workspaceDir: fixture.workspaceDir,
      config: configState,
      runtime: createConfigRuntime(configState),
      reportDir,
      includeSecrets: true,
    });
    const plan = await provider.plan(ctx);
    configState.auth = {
      profiles: {
        "openai:codex-import": {
          provider: "anthropic",
          mode: "api_key",
        },
      },
    };

    const result = await provider.apply(ctx, plan);

    expect(findItem(result.items, "auth:openai")).toEqual(
      expect.objectContaining({
        status: "conflict",
        reason: "auth profile exists",
      }),
    );
    expect(loadTargetAuthStore(fixture).profiles["openai:codex-import"]).toBeUndefined();
  });

  it("skips Codex OAuth import when the source account changes after planning", async () => {
    const fixture = await createCodexFixture();
    const reportDir = path.join(fixture.root, "report");
    const plannedAccessToken = fakeJwt({
      "https://api.openai.com/auth": {
        chatgpt_account_id: "acct_planned",
      },
      "https://api.openai.com/profile": {
        email: "planned@example.test",
      },
    });
    const changedAccessToken = fakeJwt({
      "https://api.openai.com/auth": {
        chatgpt_account_id: "acct_changed",
      },
      "https://api.openai.com/profile": {
        email: "changed@example.test",
      },
    });
    await writeFile(
      path.join(fixture.codexHome, "auth.json"),
      JSON.stringify({
        auth_mode: "chatgpt",
        tokens: {
          access_token: plannedAccessToken,
          refresh_token: "refresh-planned-token",
          account_id: "acct_planned",
        },
      }),
    );
    const configState: MigrationProviderContext["config"] = {
      agents: {
        defaults: {
          workspace: fixture.workspaceDir,
        },
      },
    };
    const provider = buildCodexMigrationProvider();
    const ctx = makeContext({
      source: fixture.codexHome,
      stateDir: fixture.stateDir,
      workspaceDir: fixture.workspaceDir,
      config: configState,
      runtime: createConfigRuntime(configState),
      reportDir,
      includeSecrets: true,
    });
    const plan = await provider.plan(ctx);
    expect(findItem(plan.items, "auth:openai").details).toEqual(
      expect.objectContaining({
        profileId: "openai:account-acct_planned",
        sourceProfileId: "openai:account-acct_planned",
      }),
    );
    await writeFile(
      path.join(fixture.codexHome, "auth.json"),
      JSON.stringify({
        auth_mode: "chatgpt",
        tokens: {
          access_token: changedAccessToken,
          refresh_token: "refresh-changed-token",
          account_id: "acct_changed",
        },
      }),
    );

    const result = await provider.apply(ctx, plan);

    expect(findItem(result.items, "auth:openai")).toEqual(
      expect.objectContaining({
        status: "skipped",
        reason: "auth credential no longer present",
      }),
    );
    const authStore = loadTargetAuthStore(fixture);
    expect(authStore.profiles["openai:account-acct_planned"]).toBeUndefined();
    expect(authStore.profiles["openai:account-acct_changed"]).toBeUndefined();
    expect(configState.auth).toBeUndefined();
  });

  it("does not collapse Codex OAuth accounts that share an email", async () => {
    const fixture = await createCodexFixture();
    const reportDir = path.join(fixture.root, "report");
    const sharedEmail = "shared@example.com";
    const accessToken = fakeJwt({
      "https://api.openai.com/auth": {
        chatgpt_account_id: "acct_new",
        chatgpt_plan_type: "plus",
      },
      "https://api.openai.com/profile": {
        email: sharedEmail,
      },
    });
    await writeFile(
      path.join(fixture.codexHome, "auth.json"),
      JSON.stringify({
        auth_mode: "chatgpt",
        tokens: {
          access_token: accessToken,
          refresh_token: "refresh-new-token",
          account_id: "acct_new",
        },
      }),
    );
    upsertAuthProfile({
      agentDir: targetAgentDir(fixture),
      profileId: "openai:account-acct_old",
      credential: {
        type: "oauth",
        provider: "openai",
        access: "old-access-token",
        refresh: "old-refresh-token",
        expires: Date.now() + 60_000,
        accountId: "acct_old",
        email: sharedEmail,
      },
    });
    const configState: MigrationProviderContext["config"] = {
      agents: {
        defaults: {
          workspace: fixture.workspaceDir,
        },
      },
    };
    const provider = buildCodexMigrationProvider();
    const ctx = makeContext({
      source: fixture.codexHome,
      stateDir: fixture.stateDir,
      workspaceDir: fixture.workspaceDir,
      config: configState,
      runtime: createConfigRuntime(configState),
      reportDir,
      includeSecrets: true,
    });

    const plan = await provider.plan(ctx);
    expectRecordFields(findItem(plan.items, "auth:openai"), {
      status: "planned",
    });
    expect(findItem(plan.items, "auth:openai").details).toEqual(
      expect.objectContaining({
        profileId: "openai:account-acct_new",
      }),
    );

    const result = await provider.apply(ctx, plan);

    expectRecordFields(findItem(result.items, "auth:openai"), { status: "migrated" });
    const authStore = loadTargetAuthStore(fixture);
    expect(authStore.profiles?.["openai:account-acct_old"]).toEqual(
      expect.objectContaining({
        access: "old-access-token",
        accountId: "acct_old",
        email: sharedEmail,
      }),
    );
    expect(authStore.profiles?.["openai:account-acct_new"]).toEqual(
      expect.objectContaining({
        access: accessToken,
        accountId: "acct_new",
        email: sharedEmail,
      }),
    );
  });

  it("reports Codex auth import when config update fails after profile write", async () => {
    const fixture = await createCodexFixture();
    const reportDir = path.join(fixture.root, "report");
    const accessToken = fakeJwt({
      "https://api.openai.com/auth": {
        chatgpt_account_id: "acct_test",
      },
      "https://api.openai.com/profile": {
        email: "codex@example.test",
      },
    });
    await writeFile(
      path.join(fixture.codexHome, "auth.json"),
      JSON.stringify({
        auth_mode: "chatgpt",
        tokens: {
          access_token: accessToken,
          refresh_token: "refresh-test-token",
          account_id: "acct_test",
        },
      }),
    );
    const configState: MigrationProviderContext["config"] = {
      agents: {
        defaults: {
          workspace: fixture.workspaceDir,
        },
      },
    };
    const provider = buildCodexMigrationProvider();
    const ctx = makeContext({
      source: fixture.codexHome,
      stateDir: fixture.stateDir,
      workspaceDir: fixture.workspaceDir,
      config: configState,
      runtime: createFailingConfigRuntime(configState),
      reportDir,
      includeSecrets: true,
    });
    const plan = await provider.plan(ctx);

    const result = await provider.apply(ctx, plan);

    expectRecordFields(findItem(result.items, "auth:openai"), { status: "migrated" });
    expect(findItem(result.items, "auth:openai").details).toEqual(
      expect.objectContaining({
        configUpdated: false,
      }),
    );
    const authStore = loadTargetAuthStore(fixture);
    expect(authStore.profiles?.["openai:account-acct_test"]).toEqual(
      expect.objectContaining({
        type: "oauth",
        provider: "openai",
        access: accessToken,
      }),
    );
  });

  it("returns Codex auth config patches without direct config writes in return mode", async () => {
    const fixture = await createCodexFixture();
    const reportDir = path.join(fixture.root, "report");
    const accessToken = fakeJwt({
      "https://api.openai.com/auth": {
        chatgpt_account_id: "acct_test",
      },
      "https://api.openai.com/profile": {
        email: "codex@example.test",
      },
    });
    await writeFile(
      path.join(fixture.codexHome, "auth.json"),
      JSON.stringify({
        auth_mode: "chatgpt",
        tokens: {
          access_token: accessToken,
          refresh_token: "refresh-test-token",
          account_id: "acct_test",
        },
      }),
    );
    await writeFile(
      path.join(fixture.codexHome, "models_cache.json"),
      JSON.stringify({ models: [{ slug: "gpt-5.5" }, { slug: "gpt-5.4-mini" }] }),
    );
    const configState: MigrationProviderContext["config"] = {
      agents: {
        defaults: {
          workspace: fixture.workspaceDir,
        },
      },
    };
    const provider = buildCodexMigrationProvider();
    const ctx = makeContext({
      source: fixture.codexHome,
      stateDir: fixture.stateDir,
      workspaceDir: fixture.workspaceDir,
      config: configState,
      runtime: createFailingConfigRuntime(configState),
      reportDir,
      includeSecrets: true,
      providerOptions: { configPatchMode: "return" },
    });
    const plan = await provider.plan(ctx);

    const result = await provider.apply(ctx, plan);

    expect(findItem(result.items, "auth:openai").details).toEqual(
      expect.objectContaining({
        configUpdated: false,
        configPatchReturned: true,
      }),
    );
    expect(findItem(result.items, "auth:openai:config:auth")).toEqual(
      expect.objectContaining({
        kind: "config",
        action: "merge",
        status: "migrated",
        details: expect.objectContaining({
          path: ["auth"],
          value: expect.objectContaining({
            profiles: expect.objectContaining({
              "openai:account-acct_test": expect.objectContaining({
                provider: "openai",
                mode: "oauth",
              }),
            }),
          }),
        }),
      }),
    );
    expect(findItem(result.items, "auth:openai:config:agents-defaults")).toEqual(
      expect.objectContaining({
        kind: "config",
        action: "merge",
        status: "migrated",
        details: expect.objectContaining({
          path: ["agents", "defaults"],
          value: expect.objectContaining({
            model: { primary: "openai/gpt-5.6-sol" },
            models: expect.objectContaining({
              "openai/gpt-5.4-mini": {},
              "openai/gpt-5.5": {},
              "openai/gpt-5.6-sol": {},
            }),
          }),
        }),
      }),
    );
    expect(configState.auth).toBeUndefined();
    expect(configState.agents?.defaults?.model).toBeUndefined();
  });

  it("skips source-installed plugins whose owned apps are inaccessible", async () => {
    const fixture = await createCodexFixture();
    appServerRequest.mockImplementation(
      async ({ method, requestParams }: { method: string; requestParams?: unknown }) => {
        if (method === "plugin/list") {
          return pluginList([pluginSummary("readwise", { installed: true, enabled: true })]);
        }
        if (method === "plugin/read") {
          return pluginRead("readwise", [
            pluginApp("asdk_app_readwise", { name: "Readwise", needsAuth: false }),
          ]);
        }
        if (method === "account/read") {
          return chatGptAccount();
        }
        if (method === "app/list") {
          expectRecordFields(requestParams, { forceRefetch: true });
          return appsList([
            appInfo("asdk_app_readwise", {
              name: "Readwise",
              isAccessible: false,
              isEnabled: true,
            }),
          ]);
        }
        throw new Error(`unexpected request ${method}`);
      },
    );
    const provider = buildCodexMigrationProvider();

    const plan = await provider.plan(
      makeContext({
        source: fixture.codexHome,
        stateDir: fixture.stateDir,
        workspaceDir: fixture.workspaceDir,
        verifyPluginApps: true,
      }),
    );

    expect(plan.items.some((item) => item.id === "plugin:readwise")).toBe(false);
    expect(plan.items.some((item) => item.id === "config:codex-plugins")).toBe(false);
    const manualItem = findItemByReason(plan.items, "app_inaccessible");
    expectRecordFields(manualItem, {
      kind: "manual",
      action: "manual",
      status: "skipped",
      reason: "app_inaccessible",
    });
    const details = expectRecordFields(manualItem.details, {
      pluginName: "readwise",
      marketplaceName: CODEX_PLUGINS_MARKETPLACE_NAME,
    });
    expect(details).not.toHaveProperty("code");
    expect(details.apps).toEqual([
      {
        id: "asdk_app_readwise",
        name: "Readwise",
        isAccessible: false,
        isEnabled: true,
        needsAuth: false,
      },
    ]);
    expect(appServerRequest.mock.calls.filter(([arg]) => arg.method === "app/list")).toHaveLength(
      1,
    );
  });

  it("plans app-backed plugins without source app/list by default", async () => {
    const fixture = await createCodexFixture();
    appServerRequest.mockImplementation(async ({ method }: { method: string }) => {
      if (method === "plugin/list") {
        return pluginList([pluginSummary("gmail", { installed: true, enabled: true })]);
      }
      if (method === "plugin/read") {
        return pluginRead("gmail", [pluginApp("app-gmail", { name: "Gmail", needsAuth: true })]);
      }
      if (method === "account/read") {
        return chatGptAccount();
      }
      throw new Error(`unexpected request ${method}`);
    });
    const provider = buildCodexMigrationProvider();

    const plan = await provider.plan(
      makeContext({
        source: fixture.codexHome,
        stateDir: fixture.stateDir,
        workspaceDir: fixture.workspaceDir,
      }),
    );

    expectRecordFields(findItem(plan.items, "plugin:gmail"), {
      kind: "plugin",
      action: "install",
      status: "planned",
    });
    expectRecordFields(findItem(plan.items, "config:codex-plugins"), {
      kind: "config",
      action: "merge",
      status: "planned",
    });
    expect(plan.warnings).toEqual([]);
    expect(appServerRequest.mock.calls.filter(([arg]) => arg.method === "app/list")).toHaveLength(
      0,
    );
  });

  it("warns and skips app-backed plugins when source Codex account is not ChatGPT subscription auth", async () => {
    const fixture = await createCodexFixture();
    appServerRequest.mockImplementation(async ({ method }: { method: string }) => {
      if (method === "plugin/list") {
        return pluginList([pluginSummary("gmail", { installed: true, enabled: true })]);
      }
      if (method === "plugin/read") {
        return pluginRead("gmail", [pluginApp("app-gmail", { name: "Gmail", needsAuth: true })]);
      }
      if (method === "account/read") {
        return {
          account: { type: "apiKey" },
          requiresOpenaiAuth: true,
        } satisfies CodexGetAccountResponse;
      }
      throw new Error(`unexpected request ${method}`);
    });
    const provider = buildCodexMigrationProvider();

    const plan = await provider.plan(
      makeContext({
        source: fixture.codexHome,
        stateDir: fixture.stateDir,
        workspaceDir: fixture.workspaceDir,
      }),
    );

    expect(plan.items.some((item) => item.id === "plugin:gmail")).toBe(false);
    expect(plan.items.some((item) => item.id === "config:codex-plugins")).toBe(false);
    const manualItem = findItemByReason(plan.items, "codex_subscription_required");
    expectRecordFields(manualItem, {
      kind: "manual",
      action: "manual",
      status: "skipped",
      reason: "codex_subscription_required",
    });
    const details = expectRecordFields(manualItem.details, {
      pluginName: "gmail",
      marketplaceName: CODEX_PLUGINS_MARKETPLACE_NAME,
    });
    expect(details).not.toHaveProperty("code");
    expect(details.apps).toEqual([
      {
        id: "app-gmail",
        name: "Gmail",
        needsAuth: true,
      },
    ]);
    expect(plan.warnings).toEqual([
      "Codex app-backed plugin migration requires the Codex app-server source account to be logged in with a ChatGPT subscription account. Log in to the Codex app with subscription auth; OpenClaw auth or API-key auth does not satisfy Codex app connector access.",
    ]);
    expect(appServerRequest.mock.calls.filter(([arg]) => arg.method === "app/list")).toHaveLength(
      0,
    );
  });

  it("warns and skips app-backed plugins when source Codex account is missing", async () => {
    const fixture = await createCodexFixture();
    appServerRequest.mockImplementation(async ({ method }: { method: string }) => {
      if (method === "plugin/list") {
        return pluginList([pluginSummary("gmail", { installed: true, enabled: true })]);
      }
      if (method === "plugin/read") {
        return pluginRead("gmail", [pluginApp("app-gmail", { name: "Gmail", needsAuth: true })]);
      }
      if (method === "account/read") {
        return {
          account: null,
          requiresOpenaiAuth: true,
        } satisfies CodexGetAccountResponse;
      }
      throw new Error(`unexpected request ${method}`);
    });
    const provider = buildCodexMigrationProvider();

    const plan = await provider.plan(
      makeContext({
        source: fixture.codexHome,
        stateDir: fixture.stateDir,
        workspaceDir: fixture.workspaceDir,
      }),
    );

    expect(plan.items.some((item) => item.id === "plugin:gmail")).toBe(false);
    expect(plan.items.some((item) => item.id === "config:codex-plugins")).toBe(false);
    expectRecordFields(findItemByReason(plan.items, "codex_subscription_required"), {
      reason: "codex_subscription_required",
      status: "skipped",
    });
    expect(appServerRequest.mock.calls.filter(([arg]) => arg.method === "app/list")).toHaveLength(
      0,
    );
  });

  it("falls through to app inventory when source account read fails and app verification is requested", async () => {
    const fixture = await createCodexFixture();
    appServerRequest.mockImplementation(async ({ method }: { method: string }) => {
      if (method === "plugin/list") {
        return pluginList([pluginSummary("gmail", { installed: true, enabled: true })]);
      }
      if (method === "plugin/read") {
        return pluginRead("gmail", [pluginApp("app-gmail", { name: "Gmail", needsAuth: true })]);
      }
      if (method === "account/read") {
        throw new Error("account unavailable");
      }
      if (method === "app/list") {
        return appsList([appInfo("app-gmail")]);
      }
      throw new Error(`unexpected request ${method}`);
    });
    const provider = buildCodexMigrationProvider();

    const plan = await provider.plan(
      makeContext({
        source: fixture.codexHome,
        stateDir: fixture.stateDir,
        workspaceDir: fixture.workspaceDir,
        verifyPluginApps: true,
      }),
    );

    expectRecordFields(findItem(plan.items, "plugin:gmail"), {
      kind: "plugin",
      action: "install",
      status: "planned",
    });
    expect(appServerRequest.mock.calls.filter(([arg]) => arg.method === "app/list")).toHaveLength(
      1,
    );
  });

  it("skips app-backed plugins by default when source account read fails", async () => {
    const fixture = await createCodexFixture();
    appServerRequest.mockImplementation(async ({ method }: { method: string }) => {
      if (method === "plugin/list") {
        return pluginList([pluginSummary("gmail", { installed: true, enabled: true })]);
      }
      if (method === "plugin/read") {
        return pluginRead("gmail", [pluginApp("app-gmail", { name: "Gmail", needsAuth: true })]);
      }
      if (method === "account/read") {
        throw new Error("account unavailable");
      }
      throw new Error(`unexpected request ${method}`);
    });
    const provider = buildCodexMigrationProvider();

    const plan = await provider.plan(
      makeContext({
        source: fixture.codexHome,
        stateDir: fixture.stateDir,
        workspaceDir: fixture.workspaceDir,
      }),
    );

    expect(plan.items.some((item) => item.id === "plugin:gmail")).toBe(false);
    expect(plan.items.some((item) => item.id === "config:codex-plugins")).toBe(false);
    const manualItem = findItemByReason(plan.items, "codex_account_unavailable");
    expectRecordFields(manualItem, {
      kind: "manual",
      action: "manual",
      reason: "codex_account_unavailable",
      status: "skipped",
    });
    expectRecordFields(manualItem.details, { error: "account unavailable" });
    expect(appServerRequest.mock.calls.filter(([arg]) => arg.method === "app/list")).toHaveLength(
      0,
    );
  });

  it("reads source plugin readiness with native source auth instead of target agent auth", async () => {
    const fixture = await createCodexFixture();
    appServerRequest.mockImplementation(async ({ method }: { method: string }) => {
      if (method === "plugin/list") {
        return pluginList([pluginSummary("google-calendar", { installed: true, enabled: true })]);
      }
      if (method === "plugin/read") {
        return pluginRead("google-calendar", [
          pluginApp("app-google-calendar", { name: "Google Calendar", needsAuth: false }),
        ]);
      }
      if (method === "account/read") {
        return chatGptAccount();
      }
      if (method === "app/list") {
        return appsList([appInfo("app-google-calendar")]);
      }
      throw new Error(`unexpected request ${method}`);
    });
    const provider = buildCodexMigrationProvider();

    await provider.plan(
      makeContext({
        source: fixture.codexHome,
        stateDir: fixture.stateDir,
        workspaceDir: fixture.workspaceDir,
        verifyPluginApps: true,
        config: {
          agents: {
            defaults: {
              workspace: fixture.workspaceDir,
            },
          },
          auth: {
            order: {
              openai: ["openai:target"],
            },
          },
        } as MigrationProviderContext["config"],
      }),
    );

    expect(appServerRequest).toHaveBeenCalledTimes(4);
    for (const [arg] of appServerRequest.mock.calls) {
      expect(arg.authProfileId).toBeNull();
      expect(arg.isolated).toBe(true);
      expect(arg.startOptions?.env).toEqual({
        CODEX_HOME: fixture.codexHome,
        HOME: path.dirname(fixture.codexHome),
      });
      expect(arg).not.toHaveProperty("agentDir");
      expect(arg).not.toHaveProperty("config");
    }
  });

  it("reports inaccessible before missing when multiple owned apps are blocked", async () => {
    const fixture = await createCodexFixture();
    appServerRequest.mockImplementation(async ({ method }: { method: string }) => {
      if (method === "plugin/list") {
        return pluginList([pluginSummary("readwise", { installed: true, enabled: true })]);
      }
      if (method === "plugin/read") {
        return pluginRead("readwise", [
          pluginApp("asdk_app_readwise", { name: "Readwise", needsAuth: false }),
          pluginApp("asdk_app_reader", { name: "Reader", needsAuth: false }),
        ]);
      }
      if (method === "account/read") {
        return chatGptAccount();
      }
      if (method === "app/list") {
        return appsList([
          appInfo("asdk_app_readwise", {
            name: "Readwise",
            isAccessible: false,
            isEnabled: true,
          }),
        ]);
      }
      throw new Error(`unexpected request ${method}`);
    });
    const provider = buildCodexMigrationProvider();

    const plan = await provider.plan(
      makeContext({
        source: fixture.codexHome,
        stateDir: fixture.stateDir,
        workspaceDir: fixture.workspaceDir,
        verifyPluginApps: true,
      }),
    );

    const manualItem = findItemByReason(plan.items, "app_inaccessible");
    expectRecordFields(manualItem, {
      reason: "app_inaccessible",
      status: "skipped",
    });
    const details = expectRecordFields(manualItem.details, {
      pluginName: "readwise",
      marketplaceName: CODEX_PLUGINS_MARKETPLACE_NAME,
    });
    expect(details).not.toHaveProperty("code");
    expect(details.apps).toEqual([
      {
        id: "asdk_app_reader",
        name: "Reader",
        needsAuth: false,
      },
      {
        id: "asdk_app_readwise",
        name: "Readwise",
        isAccessible: false,
        isEnabled: true,
        needsAuth: false,
      },
    ]);
  });

  it("force-refreshes source app inventory once for app-backed plugins sharing a cache key", async () => {
    const fixture = await createCodexFixture();
    await defaultCodexAppInventoryCache.refreshNow({
      key: sourceAppCacheKey(fixture),
      request: async () => appsList([appInfo("app-google-calendar", { isAccessible: false })]),
    });
    appServerRequest.mockImplementation(
      async ({ method, requestParams }: { method: string; requestParams?: unknown }) => {
        if (method === "plugin/list") {
          return pluginList([
            pluginSummary("google-calendar", { installed: true, enabled: true }),
            pluginSummary("gmail", { installed: true, enabled: true }),
          ]);
        }
        if (method === "plugin/read") {
          const pluginName = (requestParams as v2.PluginReadParams).pluginName;
          return pluginRead(pluginName, [pluginApp(`app-${pluginName}`)]);
        }
        if (method === "account/read") {
          return chatGptAccount();
        }
        if (method === "app/list") {
          expectRecordFields(requestParams, { forceRefetch: true });
          return appsList([appInfo("app-google-calendar"), appInfo("app-gmail")]);
        }
        throw new Error(`unexpected request ${method}`);
      },
    );
    const provider = buildCodexMigrationProvider();

    const plan = await provider.plan(
      makeContext({
        source: fixture.codexHome,
        stateDir: fixture.stateDir,
        workspaceDir: fixture.workspaceDir,
        verifyPluginApps: true,
      }),
    );

    expectRecordFields(findItem(plan.items, "plugin:google-calendar"), { status: "planned" });
    expectRecordFields(findItem(plan.items, "plugin:gmail"), { status: "planned" });
    expect(appServerRequest.mock.calls.filter(([arg]) => arg.method === "app/list")).toHaveLength(
      1,
    );
  });

  it("fails closed for disabled plugins and plugin/read failures", async () => {
    const fixture = await createCodexFixture();
    appServerRequest.mockImplementation(
      async ({ method, requestParams }: { method: string; requestParams?: unknown }) => {
        if (method === "plugin/list") {
          return pluginList([
            pluginSummary("readwise", { installed: true, enabled: false }),
            pluginSummary("gmail", { installed: true, enabled: true }),
          ]);
        }
        if (method === "plugin/read") {
          expectRecordFields(requestParams, { pluginName: "gmail" });
          throw new Error("detail unavailable");
        }
        throw new Error(`unexpected request ${method}`);
      },
    );
    const provider = buildCodexMigrationProvider();

    const plan = await provider.plan(
      makeContext({
        source: fixture.codexHome,
        stateDir: fixture.stateDir,
        workspaceDir: fixture.workspaceDir,
        verifyPluginApps: true,
      }),
    );

    expectRecordFields(findItemByReason(plan.items, "plugin_disabled"), {
      reason: "plugin_disabled",
      status: "skipped",
    });
    expectRecordFields(findItemByReason(plan.items, "plugin_read_unavailable"), {
      reason: "plugin_read_unavailable",
      status: "skipped",
    });
    expect(plan.items.some((item) => item.id === "config:codex-plugins")).toBe(false);
    expect(appServerRequest.mock.calls.filter(([arg]) => arg.method === "app/list")).toHaveLength(
      0,
    );
  });

  it("fails closed when app inventory refresh fails for app-backed plugins", async () => {
    const fixture = await createCodexFixture();
    appServerRequest.mockImplementation(async ({ method }: { method: string }) => {
      if (method === "plugin/list") {
        return pluginList([pluginSummary("readwise", { installed: true, enabled: true })]);
      }
      if (method === "plugin/read") {
        return pluginRead("readwise", [pluginApp("asdk_app_readwise", { name: "Readwise" })]);
      }
      if (method === "account/read") {
        return chatGptAccount();
      }
      if (method === "app/list") {
        throw new Error("app inventory unavailable");
      }
      throw new Error(`unexpected request ${method}`);
    });
    const provider = buildCodexMigrationProvider();

    const plan = await provider.plan(
      makeContext({
        source: fixture.codexHome,
        stateDir: fixture.stateDir,
        workspaceDir: fixture.workspaceDir,
        verifyPluginApps: true,
      }),
    );

    expectRecordFields(findItemByReason(plan.items, "app_inventory_unavailable"), {
      reason: "app_inventory_unavailable",
      status: "skipped",
    });
    expect(plan.items.some((item) => item.id === "plugin:readwise")).toBe(false);
  });

  it("treats auth-required source apps as ready when app inventory says they are accessible", async () => {
    const fixture = await createCodexFixture();
    appServerRequest.mockImplementation(async ({ method }: { method: string }) => {
      if (method === "plugin/list") {
        return pluginList([pluginSummary("reader", { installed: true, enabled: true })]);
      }
      if (method === "plugin/read") {
        return pluginRead("reader", [
          pluginApp("ready-app", { name: "Ready App", needsAuth: false }),
          pluginApp("auth-app", { name: "Auth App", needsAuth: true }),
        ]);
      }
      if (method === "account/read") {
        return chatGptAccount();
      }
      if (method === "app/list") {
        return appsList([appInfo("ready-app"), appInfo("auth-app")]);
      }
      throw new Error(`unexpected request ${method}`);
    });
    const provider = buildCodexMigrationProvider();

    const plan = await provider.plan(
      makeContext({
        source: fixture.codexHome,
        stateDir: fixture.stateDir,
        workspaceDir: fixture.workspaceDir,
        verifyPluginApps: true,
      }),
    );

    const pluginItem = findItem(plan.items, "plugin:reader");
    expectRecordFields(pluginItem, {
      kind: "plugin",
      action: "install",
      status: "planned",
    });
    expectRecordFields(pluginItem.details, {
      configKey: "reader",
      pluginName: "reader",
      marketplaceName: CODEX_PLUGINS_MARKETPLACE_NAME,
    });
  });

  it("copies planned skills and archives native config during apply", async () => {
    const fixture = await createCodexFixture();
    const reportDir = path.join(fixture.root, "report");
    const provider = buildCodexMigrationProvider();

    const result = await provider.apply(
      makeContext({
        source: fixture.codexHome,
        stateDir: fixture.stateDir,
        workspaceDir: fixture.workspaceDir,
        reportDir,
      }),
    );

    await expect(
      fs.access(path.join(fixture.workspaceDir, "skills", "tweet-helper", "SKILL.md")),
    ).resolves.toBeUndefined();
    await expect(
      fs.access(path.join(fixture.workspaceDir, "skills", "personal-style", "SKILL.md")),
    ).resolves.toBeUndefined();
    await expect(
      fs.access(path.join(reportDir, "archive", "config.toml")),
    ).resolves.toBeUndefined();
    expectRecordFields(findItem(result.items, "plugin:documents:1"), { status: "skipped" });
    expectRecordFields(findItem(result.items, "skill:tweet-helper"), { status: "migrated" });
    expectRecordFields(findItem(result.items, "archive:config.toml"), { status: "migrated" });
    await expect(fs.access(path.join(reportDir, "report.json"))).resolves.toBeUndefined();
  });

  it("installs selected curated plugins during apply and writes codexPlugins config", async () => {
    const fixture = await createCodexFixture();
    const reportDir = path.join(fixture.root, "report");
    const configState: MigrationProviderContext["config"] = {
      plugins: {
        entries: {
          codex: {
            enabled: true,
            config: {
              appServer: { sandbox: "workspace-write" },
            },
          },
        },
      },
      agents: { defaults: { workspace: fixture.workspaceDir } },
    } as MigrationProviderContext["config"];
    let targetPluginListCalls = 0;
    let targetPluginListCallsAtInstall = 0;
    appServerRequest.mockImplementation(
      async ({ method, agentDir }: { method: string; agentDir?: string }) => {
        const isTarget = typeof agentDir === "string";
        if (method === "plugin/list" && !isTarget) {
          return pluginList([pluginSummary("google-calendar", { installed: true, enabled: true })]);
        }
        if (method === "plugin/list" && isTarget) {
          targetPluginListCalls += 1;
          if (targetPluginListCalls === 1) {
            return { marketplaces: [], marketplaceLoadErrors: [], featuredPluginIds: [] };
          }
          return pluginList([pluginSummary("google-calendar", { installed: true, enabled: true })]);
        }
        if (method === "plugin/read") {
          return pluginRead("google-calendar");
        }
        if (method === "plugin/install") {
          targetPluginListCallsAtInstall = targetPluginListCalls;
          return { authPolicy: "ON_USE", appsNeedingAuth: [] } satisfies v2.PluginInstallResponse;
        }
        if (method === "skills/list") {
          return { data: [] } satisfies v2.SkillsListResponse;
        }
        if (method === "hooks/list") {
          return { data: [] } satisfies v2.HooksListResponse;
        }
        if (method === "config/mcpServer/reload") {
          return {};
        }
        if (method === "app/list") {
          return appsList([]);
        }
        throw new Error(`unexpected request ${method}`);
      },
    );
    const provider = buildCodexMigrationProvider({
      runtime: createConfigRuntime(configState),
    });

    const result = await provider.apply(
      makeContext({
        source: fixture.codexHome,
        stateDir: fixture.stateDir,
        workspaceDir: fixture.workspaceDir,
        reportDir,
        config: configState,
      }),
    );

    const installCall = appServerRequest.mock.calls.find(
      ([arg]) => (arg as { method?: string }).method === "plugin/install",
    )?.[0] as Record<string, unknown>;
    expect(targetPluginListCallsAtInstall).toBe(2);
    expectRecordFields(installCall, {
      method: "plugin/install",
      requestParams: {
        marketplacePath: "/marketplaces/openai-curated",
        pluginName: "google-calendar",
      },
    });
    const pluginItem = findItem(result.items, "plugin:google-calendar");
    expectRecordFields(pluginItem, {
      status: "migrated",
      reason: "already active",
    });
    expectRecordFields(pluginItem.details, {
      code: "already_active",
      installAttempted: true,
    });
    expectRecordFields(findItem(result.items, "config:codex-plugins"), {
      status: "migrated",
    });
    expect(configState.plugins?.entries?.codex?.enabled).toBe(true);
    expect(configState.plugins?.entries?.codex?.config?.appServer).toEqual({
      sandbox: "workspace-write",
    });
    expect(configState.plugins?.entries?.codex?.config?.codexPlugins).toEqual({
      enabled: true,
      allow_destructive_actions: true,
      plugins: {
        "google-calendar": {
          enabled: true,
          marketplaceName: CODEX_PLUGINS_MARKETPLACE_NAME,
          pluginName: "google-calendar",
        },
      },
    });
    expect(configState.plugins?.entries?.codex?.config?.codexPlugins).not.toHaveProperty("*");
  });

  it("leaves selected Codex plugins as warnings when target curated plugins never load", async () => {
    vi.stubEnv("OPENCLAW_CODEX_MIGRATION_PLUGIN_LIST_TIMEOUT_MS", "1");
    const fixture = await createCodexFixture();
    const configState: MigrationProviderContext["config"] = {
      agents: { defaults: { workspace: fixture.workspaceDir } },
    } as MigrationProviderContext["config"];
    appServerRequest.mockImplementation(
      async ({ method, agentDir }: { method: string; agentDir?: string }) => {
        const isTarget = typeof agentDir === "string";
        if (method === "plugin/list" && !isTarget) {
          return pluginList([pluginSummary("google-calendar", { installed: true, enabled: true })]);
        }
        if (method === "plugin/read" && !isTarget) {
          return pluginRead("google-calendar");
        }
        if (method === "plugin/list" && isTarget) {
          return {
            marketplaces: [],
            marketplaceLoadErrors: [],
            featuredPluginIds: [],
          } satisfies v2.PluginListResponse;
        }
        if (method === "skills/list") {
          return { data: [] } satisfies v2.SkillsListResponse;
        }
        if (method === "hooks/list") {
          return { data: [] } satisfies v2.HooksListResponse;
        }
        if (method === "config/mcpServer/reload") {
          return {};
        }
        if (method === "app/list") {
          return appsList([]);
        }
        throw new Error(`unexpected request ${method}`);
      },
    );
    const provider = buildCodexMigrationProvider({
      runtime: createConfigRuntime(configState),
    });

    const result = await provider.apply(
      makeContext({
        source: fixture.codexHome,
        stateDir: fixture.stateDir,
        workspaceDir: fixture.workspaceDir,
        config: configState,
      }),
    );

    expect(
      appServerRequest.mock.calls.some(
        ([arg]) => (arg as { method?: string }).method === "plugin/install",
      ),
    ).toBe(false);
    expectRecordFields(findItem(result.items, "plugin:google-calendar"), {
      kind: "plugin",
      action: "install",
      status: "warning",
      reason: "marketplace_missing",
    });
    expect(result.warnings).toContain(
      "Some Codex plugins could not be migrated. Run `openclaw migrate codex` after onboarding.",
    );
    expect(result.nextSteps).toContain(
      "Some Codex plugins could not be migrated. Run `openclaw migrate codex` after onboarding.",
    );
    expect(configState.plugins?.entries?.codex?.config?.codexPlugins).toBeUndefined();
  });

  it("leaves selected Codex plugins as warnings when target inventory times out", async () => {
    const fixture = await createCodexFixture();
    const configState: MigrationProviderContext["config"] = {
      agents: { defaults: { workspace: fixture.workspaceDir } },
    } as MigrationProviderContext["config"];
    appServerRequest.mockImplementation(
      async ({ method, agentDir }: { method: string; agentDir?: string }) => {
        const isTarget = typeof agentDir === "string";
        if (method === "plugin/list" && !isTarget) {
          return pluginList([pluginSummary("google-calendar", { installed: true, enabled: true })]);
        }
        if (method === "plugin/read" && !isTarget) {
          return pluginRead("google-calendar");
        }
        if (method === "plugin/list" && isTarget) {
          throw new Error("codex app-server plugin/list timed out");
        }
        if (method === "skills/list") {
          return { data: [] } satisfies v2.SkillsListResponse;
        }
        if (method === "hooks/list") {
          return { data: [] } satisfies v2.HooksListResponse;
        }
        if (method === "config/mcpServer/reload") {
          return {};
        }
        if (method === "app/list") {
          return appsList([]);
        }
        throw new Error(`unexpected request ${method}`);
      },
    );
    const provider = buildCodexMigrationProvider({
      runtime: createConfigRuntime(configState),
    });

    const result = await provider.apply(
      makeContext({
        source: fixture.codexHome,
        stateDir: fixture.stateDir,
        workspaceDir: fixture.workspaceDir,
        config: configState,
      }),
    );

    expectRecordFields(findItem(result.items, "plugin:google-calendar"), {
      kind: "plugin",
      action: "install",
      status: "warning",
      reason: "plugin_inventory_unavailable",
      message: 'Codex plugin "google-calendar" could not be migrated automatically',
    });
    expect(result.warnings).toContain(
      "Some Codex plugins could not be migrated. Run `openclaw migrate codex` after onboarding.",
    );
    expect(result.nextSteps).toContain(
      "Some Codex plugins could not be migrated. Run `openclaw migrate codex` after onboarding.",
    );
    expect(result.summary.errors).toBe(0);
    expect(configState.plugins?.entries?.codex?.config?.codexPlugins).toBeUndefined();
  });

  it("plans already configured target Codex plugins as plugin-level conflicts", async () => {
    const fixture = await createCodexFixture();
    const configState: MigrationProviderContext["config"] = {
      plugins: {
        entries: {
          codex: {
            enabled: true,
            config: {
              codexPlugins: {
                enabled: true,
                allow_destructive_actions: false,
                plugins: {
                  "google-calendar": {
                    enabled: true,
                    marketplaceName: CODEX_PLUGINS_MARKETPLACE_NAME,
                    pluginName: "google-calendar",
                  },
                },
              },
            },
          },
        },
      },
      agents: { defaults: { workspace: fixture.workspaceDir } },
    } as MigrationProviderContext["config"];
    appServerRequest.mockImplementation(async ({ method }: { method: string }) => {
      if (method === "plugin/list") {
        return pluginList([
          pluginSummary("google-calendar", { installed: true, enabled: true }),
          pluginSummary("gmail", { installed: true, enabled: true }),
        ]);
      }
      if (method === "plugin/read") {
        return pluginRead("google-calendar");
      }
      throw new Error(`unexpected request ${method}`);
    });
    const provider = buildCodexMigrationProvider();

    const result = await provider.plan(
      makeContext({
        source: fixture.codexHome,
        stateDir: fixture.stateDir,
        workspaceDir: fixture.workspaceDir,
        config: configState,
      }),
    );

    expectRecordFields(findItem(result.items, "plugin:google-calendar"), {
      status: "conflict",
      reason: "plugin exists",
    });
    expectRecordFields(findItem(result.items, "plugin:gmail"), { status: "planned" });
    expectRecordFields(findItem(result.items, "config:codex-plugins"), { status: "planned" });
  });

  it("preserves explicit app-server settings during plugin migration", async () => {
    const fixture = await createCodexFixture();
    const configState: MigrationProviderContext["config"] = {
      plugins: {
        entries: {
          codex: {
            enabled: true,
            config: {
              appServer: { sandbox: "workspace-write" },
            },
          },
        },
      },
      agents: { defaults: { workspace: fixture.workspaceDir } },
    } as MigrationProviderContext["config"];
    appServerRequest.mockImplementation(async ({ method }: { method: string }) => {
      if (method === "plugin/list") {
        return pluginList([pluginSummary("google-calendar", { installed: true, enabled: true })]);
      }
      if (method === "plugin/read") {
        return pluginRead("google-calendar");
      }
      if (method === "plugin/install") {
        return { authPolicy: "ON_USE", appsNeedingAuth: [] } satisfies v2.PluginInstallResponse;
      }
      if (method === "skills/list") {
        return { data: [] } satisfies v2.SkillsListResponse;
      }
      if (method === "hooks/list") {
        return { data: [] } satisfies v2.HooksListResponse;
      }
      if (method === "config/mcpServer/reload") {
        return {};
      }
      if (method === "app/list") {
        return appsList([]);
      }
      throw new Error(`unexpected request ${method}`);
    });
    const provider = buildCodexMigrationProvider({
      runtime: createConfigRuntime(configState),
    });

    await provider.apply(
      makeContext({
        source: fixture.codexHome,
        stateDir: fixture.stateDir,
        workspaceDir: fixture.workspaceDir,
        config: configState,
      }),
    );

    expect(configState.plugins?.entries?.codex?.config?.appServer).toEqual({
      sandbox: "workspace-write",
    });
  });

  it("returns Codex plugin config patches without mutating config in return mode", async () => {
    const fixture = await createCodexFixture();
    const configState: MigrationProviderContext["config"] = {
      plugins: {
        entries: {
          codex: {
            enabled: true,
            config: {
              appServer: { sandbox: "workspace-write" },
            },
          },
        },
      },
      agents: { defaults: { workspace: fixture.workspaceDir } },
    } as MigrationProviderContext["config"];
    appServerRequest.mockImplementation(async ({ method }: { method: string }) => {
      if (method === "plugin/list") {
        return pluginList([pluginSummary("google-calendar", { installed: true, enabled: true })]);
      }
      if (method === "plugin/read") {
        return pluginRead("google-calendar");
      }
      if (method === "plugin/install") {
        return { authPolicy: "ON_USE", appsNeedingAuth: [] } satisfies v2.PluginInstallResponse;
      }
      if (method === "skills/list") {
        return { data: [] } satisfies v2.SkillsListResponse;
      }
      if (method === "hooks/list") {
        return { data: [] } satisfies v2.HooksListResponse;
      }
      if (method === "config/mcpServer/reload") {
        return {};
      }
      if (method === "app/list") {
        return appsList([]);
      }
      throw new Error(`unexpected request ${method}`);
    });
    const mutateConfigFile = vi.fn(async () => {
      throw new Error("mutateConfigFile should not be called in return mode");
    });
    const provider = buildCodexMigrationProvider({
      runtime: {
        config: {
          current: () => configState,
          mutateConfigFile,
        },
      } as unknown as MigrationProviderContext["runtime"],
    });

    const result = await provider.apply(
      makeContext({
        source: fixture.codexHome,
        stateDir: fixture.stateDir,
        workspaceDir: fixture.workspaceDir,
        config: configState,
        providerOptions: { configPatchMode: "return" },
      }),
    );

    expect(mutateConfigFile).not.toHaveBeenCalled();
    expect(configState.plugins?.entries?.codex?.config?.codexPlugins).toBeUndefined();
    const configItem = findItem(result.items, "config:codex-plugins");
    expectRecordFields(configItem, { status: "migrated" });
    const configDetails = configItem.details as Record<string, unknown>;
    expectRecordFields(configDetails, {
      path: ["plugins", "entries", "codex"],
    });
    expect(configDetails.value).toEqual({
      enabled: true,
      config: {
        codexPlugins: {
          enabled: true,
          allow_destructive_actions: true,
          plugins: {
            "google-calendar": {
              enabled: true,
              marketplaceName: CODEX_PLUGINS_MARKETPLACE_NAME,
              pluginName: "google-calendar",
            },
          },
        },
      },
    });
  });

  it("merges migrated plugin config with existing Codex plugins when entries do not conflict", async () => {
    const fixture = await createCodexFixture();
    const sourceKey = sourceAppCacheKey(fixture);
    await defaultCodexAppInventoryCache.refreshNow({
      key: sourceKey,
      request: async () => appsList([appInfo("source-only-app")]),
    });
    const configState: MigrationProviderContext["config"] = {
      plugins: {
        entries: {
          codex: {
            enabled: true,
            config: {
              codexPlugins: {
                enabled: true,
                allow_destructive_actions: true,
                plugins: {
                  slack: {
                    enabled: true,
                    marketplaceName: CODEX_PLUGINS_MARKETPLACE_NAME,
                    pluginName: "slack",
                    allow_destructive_actions: "on-request",
                  },
                },
              },
            },
          },
        },
      },
      agents: { defaults: { workspace: fixture.workspaceDir } },
    } as MigrationProviderContext["config"];
    appServerRequest.mockImplementation(async ({ method }: { method: string }) => {
      if (method === "plugin/list") {
        return pluginList([pluginSummary("google-calendar", { installed: true, enabled: true })]);
      }
      if (method === "plugin/read") {
        return pluginRead("google-calendar");
      }
      if (method === "plugin/install") {
        return { authPolicy: "ON_USE", appsNeedingAuth: [] } satisfies v2.PluginInstallResponse;
      }
      if (method === "skills/list") {
        return { data: [] } satisfies v2.SkillsListResponse;
      }
      if (method === "hooks/list") {
        return { data: [] } satisfies v2.HooksListResponse;
      }
      if (method === "config/mcpServer/reload") {
        return {};
      }
      if (method === "app/list") {
        return appsList([]);
      }
      throw new Error(`unexpected request ${method}`);
    });
    const provider = buildCodexMigrationProvider({
      runtime: createConfigRuntime(configState),
    });

    const result = await provider.apply(
      makeContext({
        source: fixture.codexHome,
        stateDir: fixture.stateDir,
        workspaceDir: fixture.workspaceDir,
        config: configState,
      }),
    );

    expectRecordFields(findItem(result.items, "config:codex-plugins"), { status: "migrated" });
    const sourceCacheRead = defaultCodexAppInventoryCache.read({
      key: sourceKey,
      request: async () => {
        throw new Error("source app cache was cleared");
      },
    });
    expect(sourceCacheRead.state).toBe("fresh");
    expect(sourceCacheRead.snapshot?.apps.map((app) => app.id)).toEqual(["source-only-app"]);
    expect(configState.plugins?.entries?.codex?.config?.codexPlugins).toEqual({
      allow_destructive_actions: true,
      plugins: {
        "google-calendar": {
          enabled: true,
          marketplaceName: CODEX_PLUGINS_MARKETPLACE_NAME,
          pluginName: "google-calendar",
        },
        slack: {
          enabled: true,
          marketplaceName: CODEX_PLUGINS_MARKETPLACE_NAME,
          pluginName: "slack",
          allow_destructive_actions: "auto",
        },
      },
      enabled: true,
    });
  });

  it("preserves existing destructive plugin policy when overwrite is explicit", async () => {
    const fixture = await createCodexFixture();
    const configState: MigrationProviderContext["config"] = {
      plugins: {
        entries: {
          codex: {
            enabled: true,
            config: {
              codexPlugins: {
                enabled: true,
                allow_destructive_actions: true,
                plugins: {},
              },
            },
          },
        },
      },
      agents: { defaults: { workspace: fixture.workspaceDir } },
    } as MigrationProviderContext["config"];
    appServerRequest.mockImplementation(async ({ method }: { method: string }) => {
      if (method === "plugin/list") {
        return pluginList([pluginSummary("google-calendar", { installed: true, enabled: true })]);
      }
      if (method === "plugin/read") {
        return pluginRead("google-calendar");
      }
      if (method === "plugin/install") {
        return { authPolicy: "ON_USE", appsNeedingAuth: [] } satisfies v2.PluginInstallResponse;
      }
      if (method === "skills/list") {
        return { data: [] } satisfies v2.SkillsListResponse;
      }
      if (method === "hooks/list") {
        return { data: [] } satisfies v2.HooksListResponse;
      }
      if (method === "config/mcpServer/reload") {
        return {};
      }
      if (method === "app/list") {
        return appsList([]);
      }
      throw new Error(`unexpected request ${method}`);
    });
    const provider = buildCodexMigrationProvider({
      runtime: createConfigRuntime(configState),
    });

    const result = await provider.apply(
      makeContext({
        source: fixture.codexHome,
        stateDir: fixture.stateDir,
        workspaceDir: fixture.workspaceDir,
        config: configState,
      }),
    );

    expectRecordFields(findItem(result.items, "config:codex-plugins"), { status: "migrated" });
    expect(configState.plugins?.entries?.codex?.config?.codexPlugins).toEqual({
      enabled: true,
      allow_destructive_actions: true,
      plugins: {
        "google-calendar": {
          enabled: true,
          marketplaceName: CODEX_PLUGINS_MARKETPLACE_NAME,
          pluginName: "google-calendar",
        },
      },
    });
  });

  it("repairs old approval-routed destructive plugin policy during migration", async () => {
    const fixture = await createCodexFixture();
    const configState: MigrationProviderContext["config"] = {
      plugins: {
        entries: {
          codex: {
            enabled: true,
            config: {
              codexPlugins: {
                enabled: true,
                allow_destructive_actions: "on-request",
                plugins: {
                  "google-calendar": {
                    enabled: true,
                    marketplaceName: CODEX_PLUGINS_MARKETPLACE_NAME,
                    pluginName: "google-calendar",
                    allow_destructive_actions: "on-request",
                  },
                },
              },
            },
          },
        },
      },
      agents: { defaults: { workspace: fixture.workspaceDir } },
    } as MigrationProviderContext["config"];
    appServerRequest.mockImplementation(async ({ method }: { method: string }) => {
      if (method === "plugin/list") {
        return pluginList([pluginSummary("google-calendar", { installed: true, enabled: true })]);
      }
      if (method === "plugin/read") {
        return pluginRead("google-calendar");
      }
      if (method === "plugin/install") {
        return { authPolicy: "ON_USE", appsNeedingAuth: [] } satisfies v2.PluginInstallResponse;
      }
      if (method === "skills/list") {
        return { data: [] } satisfies v2.SkillsListResponse;
      }
      if (method === "hooks/list") {
        return { data: [] } satisfies v2.HooksListResponse;
      }
      if (method === "config/mcpServer/reload") {
        return {};
      }
      if (method === "app/list") {
        return appsList([]);
      }
      throw new Error(`unexpected request ${method}`);
    });
    const provider = buildCodexMigrationProvider({
      runtime: createConfigRuntime(configState),
    });

    const result = await provider.apply(
      makeContext({
        source: fixture.codexHome,
        stateDir: fixture.stateDir,
        workspaceDir: fixture.workspaceDir,
        config: configState,
      }),
    );

    expectRecordFields(findItem(result.items, "config:codex-plugins"), { status: "migrated" });
    expect(configState.plugins?.entries?.codex?.config?.codexPlugins).toEqual({
      enabled: true,
      allow_destructive_actions: "auto",
      plugins: {
        "google-calendar": {
          enabled: true,
          marketplaceName: CODEX_PLUGINS_MARKETPLACE_NAME,
          pluginName: "google-calendar",
          allow_destructive_actions: "auto",
        },
      },
    });
  });

  it("preserves global ask destructive plugin policy during migration", async () => {
    const fixture = await createCodexFixture();
    const configState: MigrationProviderContext["config"] = {
      plugins: {
        entries: {
          codex: {
            enabled: true,
            config: {
              codexPlugins: {
                enabled: true,
                allow_destructive_actions: "ask",
                plugins: {},
              },
            },
          },
        },
      },
      agents: { defaults: { workspace: fixture.workspaceDir } },
    } as MigrationProviderContext["config"];
    appServerRequest.mockImplementation(async ({ method }: { method: string }) => {
      if (method === "plugin/list") {
        return pluginList([pluginSummary("google-calendar", { installed: true, enabled: true })]);
      }
      if (method === "plugin/read") {
        return pluginRead("google-calendar");
      }
      if (method === "plugin/install") {
        return { authPolicy: "ON_USE", appsNeedingAuth: [] } satisfies v2.PluginInstallResponse;
      }
      if (method === "skills/list") {
        return { data: [] } satisfies v2.SkillsListResponse;
      }
      if (method === "hooks/list") {
        return { data: [] } satisfies v2.HooksListResponse;
      }
      if (method === "config/mcpServer/reload") {
        return {};
      }
      if (method === "app/list") {
        return appsList([]);
      }
      throw new Error(`unexpected request ${method}`);
    });
    const provider = buildCodexMigrationProvider({
      runtime: createConfigRuntime(configState),
    });

    const result = await provider.apply(
      makeContext({
        source: fixture.codexHome,
        stateDir: fixture.stateDir,
        workspaceDir: fixture.workspaceDir,
        config: configState,
      }),
    );

    expectRecordFields(findItem(result.items, "config:codex-plugins"), { status: "migrated" });
    expect(configState.plugins?.entries?.codex?.config?.codexPlugins).toEqual({
      enabled: true,
      allow_destructive_actions: "ask",
      plugins: {
        "google-calendar": {
          enabled: true,
          marketplaceName: CODEX_PLUGINS_MARKETPLACE_NAME,
          pluginName: "google-calendar",
        },
      },
    });
  });

  it("records auth-required plugin installs as disabled explicit config entries", async () => {
    const fixture = await createCodexFixture();
    const configState: MigrationProviderContext["config"] = {
      agents: { defaults: { workspace: fixture.workspaceDir } },
    } as MigrationProviderContext["config"];
    appServerRequest.mockImplementation(async ({ method }: { method: string }) => {
      if (method === "plugin/list") {
        return pluginList([pluginSummary("google-calendar", { installed: true, enabled: true })]);
      }
      if (method === "plugin/read") {
        return pluginRead("google-calendar");
      }
      if (method === "plugin/install") {
        return {
          authPolicy: "ON_USE",
          appsNeedingAuth: [
            {
              id: "google-calendar",
              name: "Google Calendar",
              description: "Calendar",
              installUrl: "https://example.invalid/auth",
              needsAuth: true,
            },
          ],
        } satisfies v2.PluginInstallResponse;
      }
      if (method === "skills/list") {
        return { data: [] } satisfies v2.SkillsListResponse;
      }
      if (method === "hooks/list") {
        return { data: [] } satisfies v2.HooksListResponse;
      }
      if (method === "config/mcpServer/reload") {
        return {};
      }
      if (method === "app/list") {
        return appsList([]);
      }
      throw new Error(`unexpected request ${method}`);
    });
    const provider = buildCodexMigrationProvider({
      runtime: createConfigRuntime(configState),
    });

    const result = await provider.apply(
      makeContext({
        source: fixture.codexHome,
        stateDir: fixture.stateDir,
        workspaceDir: fixture.workspaceDir,
        config: configState,
      }),
    );

    const pluginItem = findItem(result.items, "plugin:google-calendar");
    expectRecordFields(pluginItem, {
      status: "skipped",
      reason: "auth_required",
    });
    expectRecordFields(pluginItem.details, {
      code: "auth_required",
      appsNeedingAuth: [
        {
          id: "google-calendar",
          name: "Google Calendar",
          needsAuth: true,
        },
      ],
    });
    expect(configState.plugins?.entries?.codex?.config?.codexPlugins).toEqual({
      enabled: true,
      allow_destructive_actions: true,
      plugins: {
        "google-calendar": {
          enabled: false,
          marketplaceName: CODEX_PLUGINS_MARKETPLACE_NAME,
          pluginName: "google-calendar",
        },
      },
    });
  });

  it("does not write config entries for failed plugin installs", async () => {
    const fixture = await createCodexFixture();
    const configState: MigrationProviderContext["config"] = {
      agents: { defaults: { workspace: fixture.workspaceDir } },
    } as MigrationProviderContext["config"];
    appServerRequest.mockImplementation(async ({ method }: { method: string }) => {
      if (method === "plugin/list") {
        return pluginList([pluginSummary("google-calendar", { installed: true, enabled: true })]);
      }
      if (method === "plugin/read") {
        return pluginRead("google-calendar");
      }
      if (method === "plugin/install") {
        throw new Error("install failed");
      }
      if (method === "skills/list") {
        return { data: [] } satisfies v2.SkillsListResponse;
      }
      if (method === "hooks/list") {
        return { data: [] } satisfies v2.HooksListResponse;
      }
      throw new Error(`unexpected request ${method}`);
    });
    const provider = buildCodexMigrationProvider({
      runtime: createConfigRuntime(configState),
    });

    const result = await provider.apply(
      makeContext({
        source: fixture.codexHome,
        stateDir: fixture.stateDir,
        workspaceDir: fixture.workspaceDir,
        config: configState,
      }),
    );

    expectRecordFields(findItem(result.items, "plugin:google-calendar"), {
      status: "error",
      reason: "install failed",
    });
    expectRecordFields(findItem(result.items, "config:codex-plugins"), {
      status: "skipped",
      reason: "no selected Codex plugins",
    });
    expect(configState.plugins?.entries?.codex?.config?.codexPlugins).toBeUndefined();
  });

  it("reports existing skill targets as conflicts unless overwrite is set", async () => {
    const fixture = await createCodexFixture();
    await writeFile(path.join(fixture.workspaceDir, "skills", "tweet-helper", "SKILL.md"));
    const provider = buildCodexMigrationProvider();

    const plan = await provider.plan(
      makeContext({
        source: fixture.codexHome,
        stateDir: fixture.stateDir,
        workspaceDir: fixture.workspaceDir,
      }),
    );
    const overwritePlan = await provider.plan(
      makeContext({
        source: fixture.codexHome,
        stateDir: fixture.stateDir,
        workspaceDir: fixture.workspaceDir,
        overwrite: true,
      }),
    );

    expectRecordFields(findItem(plan.items, "skill:tweet-helper"), { status: "conflict" });
    expectRecordFields(findItem(overwritePlan.items, "skill:tweet-helper"), {
      status: "planned",
    });
  });
});

function createConfigRuntime(
  configState: MigrationProviderContext["config"],
): MigrationProviderContext["runtime"] {
  type Runtime = NonNullable<MigrationProviderContext["runtime"]>;
  type MutateConfigFileParams = Parameters<Runtime["config"]["mutateConfigFile"]>[0];
  type MutateConfigFileResult = Awaited<ReturnType<Runtime["config"]["mutateConfigFile"]>>;
  return {
    config: {
      current: () => configState,
      mutateConfigFile: async (params: MutateConfigFileParams): Promise<MutateConfigFileResult> => {
        const result = await params.mutate(configState, {
          snapshot: {} as never,
          previousHash: null,
        });
        return {
          path: "/tmp/openclaw.json",
          previousHash: null,
          persistedHash: "test-persisted-hash",
          snapshot: {} as never,
          nextConfig: configState,
          afterWrite: { mode: "auto" },
          followUp: { mode: "auto", requiresRestart: false },
          result,
        };
      },
    },
  } as unknown as MigrationProviderContext["runtime"];
}

function pluginList(plugins: v2.PluginSummary[]): v2.PluginListResponse {
  return {
    marketplaces: [
      {
        name: CODEX_PLUGINS_MARKETPLACE_NAME,
        path: "/marketplaces/openai-curated",
        interface: null,
        plugins,
      },
    ],
    marketplaceLoadErrors: [],
    featuredPluginIds: [],
  };
}

function pluginRead(pluginName: string, apps: v2.AppSummary[] = []): v2.PluginReadResponse {
  return {
    plugin: {
      marketplaceName: CODEX_PLUGINS_MARKETPLACE_NAME,
      marketplacePath: "/marketplaces/openai-curated",
      summary: pluginSummary(pluginName, { installed: true, enabled: true }),
      description: null,
      skills: [],
      apps,
      mcpServers: [],
    },
  };
}

function createFailingConfigRuntime(
  configState: MigrationProviderContext["config"],
): MigrationProviderContext["runtime"] {
  type Runtime = NonNullable<MigrationProviderContext["runtime"]>;
  type MutateConfigFileParams = Parameters<Runtime["config"]["mutateConfigFile"]>[0];
  return {
    config: {
      current: () => configState,
      mutateConfigFile: async (_params: MutateConfigFileParams): Promise<never> => {
        throw new Error("config write failed");
      },
    },
  } as unknown as MigrationProviderContext["runtime"];
}

function pluginApp(id: string, overrides: Partial<v2.AppSummary> = {}): v2.AppSummary {
  return {
    id,
    name: id,
    description: null,
    installUrl: null,
    needsAuth: false,
    ...overrides,
  };
}

function appInfo(id: string, overrides: Partial<v2.AppInfo> = {}): v2.AppInfo {
  return {
    id,
    name: id,
    description: null,
    logoUrl: null,
    logoUrlDark: null,
    distributionChannel: null,
    branding: null,
    appMetadata: null,
    labels: null,
    installUrl: null,
    isAccessible: true,
    isEnabled: true,
    pluginDisplayNames: [],
    ...overrides,
  };
}

function appsList(apps: v2.AppInfo[]): v2.AppsListResponse {
  return { data: apps, nextCursor: null };
}

function chatGptAccount(): CodexGetAccountResponse {
  return {
    account: { type: "chatgpt", email: "codex@example.test", planType: "plus" },
    requiresOpenaiAuth: false,
  };
}

function pluginSummary(id: string, overrides: Partial<v2.PluginSummary> = {}): v2.PluginSummary {
  return {
    id,
    name: id,
    source: { type: "remote" },
    installed: false,
    enabled: false,
    installPolicy: "AVAILABLE",
    authPolicy: "ON_USE",
    availability: "AVAILABLE",
    interface: null,
    ...overrides,
  };
}
