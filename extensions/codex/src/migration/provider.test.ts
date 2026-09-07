// Codex tests cover provider plugin behavior.
import fs from "node:fs/promises";
import path from "node:path";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  loadAuthProfileStoreForSecretsRuntime,
} from "openclaw/plugin-sdk/agent-runtime";
import type { MigrationProviderContext } from "openclaw/plugin-sdk/plugin-entry";
import { upsertAuthProfile } from "openclaw/plugin-sdk/provider-auth";
import {
  resolvePreferredOpenClawTmpDir,
  tempWorkspace,
  type TempWorkspace,
} from "openclaw/plugin-sdk/temp-path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultCodexAppInventoryCache } from "../app-server/app-inventory-cache.js";
import { codexAppInventoryResponse } from "../app-server/app-inventory.test-helpers.js";
import { CODEX_PLUGINS_MARKETPLACE_NAME } from "../app-server/config.js";
import { buildCodexPluginAppCacheKey } from "../app-server/plugin-app-cache-key.js";
import type { CodexGetAccountResponse, v2 } from "../app-server/protocol.js";
import { buildCodexMigrationProvider } from "./provider.js";
import { discoverCodexSource } from "./source.js";

const appServerRequest = vi.hoisted(() => vi.fn());
const sourceAppServerClientScope = vi.hoisted(() => vi.fn());

vi.mock("../app-server/request.js", () => ({
  requestCodexAppServerJson: appServerRequest,
  withCodexAppServerJsonClient: sourceAppServerClientScope,
}));

const tempWorkspaces: TempWorkspace[] = [];

const logger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
};

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

function targetAgentDir(fixture: { stateDir: string }, agentId = "main"): string {
  return path.join(fixture.stateDir, "agents", agentId, "agent");
}

function loadTargetAuthStore(fixture: { stateDir: string }, agentId = "main") {
  return loadAuthProfileStoreForSecretsRuntime(targetAgentDir(fixture, agentId));
}

async function createCodexFixture(): Promise<{
  root: string;
  homeDir: string;
  codexHome: string;
  stateDir: string;
  workspaceDir: string;
}> {
  const workspace = await tempWorkspace({
    rootDir: resolvePreferredOpenClawTmpDir(),
    prefix: "openclaw-migrate-codex-",
  });
  tempWorkspaces.push(workspace);
  const root = workspace.dir;
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
  sourceAppServerClientScope.mockReset();
  defaultCodexAppInventoryCache.clear();
  await Promise.all(tempWorkspaces.splice(0).map((workspace) => workspace.cleanup()));
});

describe("buildCodexMigrationProvider", () => {
  beforeEach(() => {
    appServerRequest.mockRejectedValue(new Error("codex app-server unavailable"));
    sourceAppServerClientScope.mockImplementation(
      async (
        options: Record<string, unknown>,
        run: (
          request: (params: { method: string; requestParams?: unknown }) => Promise<unknown>,
        ) => Promise<unknown>,
      ) => await run(async (request) => await appServerRequest({ ...options, ...request })),
    );
  });

  it("preserves whitespace in nonempty CODEX_HOME values", async () => {
    const workspace = await tempWorkspace({
      rootDir: resolvePreferredOpenClawTmpDir(),
      prefix: "openclaw-migrate-codex-",
    });
    tempWorkspaces.push(workspace);
    const root = workspace.dir;
    const codexHome = path.join(root, " spaced ");
    await writeFile(path.join(codexHome, "memories", "MEMORY.md"), "# Memory\n");
    vi.stubEnv("CODEX_HOME", codexHome);

    const source = await discoverCodexSource({ memoryOnly: true });

    expect(source.codexHome).toBe(codexHome);
    expect(source.memoryFiles.map((entry) => entry.path)).toEqual([
      path.join(codexHome, "memories", "MEMORY.md"),
    ]);
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

  it.runIf(process.platform !== "win32")(
    "marks a dangling Codex memory destination symlink as a conflict",
    async () => {
      const fixture = await createCodexFixture();
      const target = path.join(fixture.workspaceDir, "memory", "imports", "codex", "MEMORY.md");
      await writeFile(path.join(fixture.codexHome, "memories", "MEMORY.md"), "# Memory\n");
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.symlink(path.join(fixture.root, "missing-memory.md"), target);
      const provider = buildCodexMigrationProvider();

      const plan = await provider.plan(
        makeContext({
          source: fixture.codexHome,
          stateDir: fixture.stateDir,
          workspaceDir: fixture.workspaceDir,
          itemKinds: ["memory"],
          overwrite: true,
        }),
      );

      expect(findItem(plan.items, "memory:codex:MEMORY.md")).toMatchObject({
        status: "conflict",
        reason: "target is not a regular file",
      });
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
      if (method === "plugin/installed" || method === "plugin/list") {
        return pluginMetadata(method, [
          pluginSummary("google-calendar", { installed: true, enabled: true }),
        ]);
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
    expect(sourceAppServerClientScope).toHaveBeenCalledTimes(1);
    expectRecordFields(mockCallArg(appServerRequest), {
      method: "plugin/installed",
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

  it("treats an empty installed-plugin inventory as successful source discovery", async () => {
    const fixture = await createCodexFixture();
    appServerRequest.mockImplementation(async ({ method }: { method: string }) => {
      if (method === "plugin/installed") {
        return { marketplaces: [], marketplaceLoadErrors: [] } satisfies v2.PluginInstalledResponse;
      }
      throw new Error(`unexpected request ${method}`);
    });

    const source = await discoverCodexSource({ input: fixture.codexHome });

    expect(source.pluginDiscoveryError).toBeUndefined();
    expect(source.plugins.every((plugin) => plugin.marketplaceName === undefined)).toBe(true);
    expect(sourceAppServerClientScope).toHaveBeenCalledTimes(1);
    expect(appServerRequest).toHaveBeenCalledTimes(1);
    expectRecordFields(mockCallArg(appServerRequest), {
      method: "plugin/installed",
      requestParams: { cwds: [] },
    });
  });

  it("migrates valid curated plugins when an unrelated marketplace fails", async () => {
    const fixture = await createCodexFixture();
    const installed = {
      marketplaces: pluginList([
        pluginSummary("google-calendar", { installed: true, enabled: true }),
      ]).marketplaces,
      marketplaceLoadErrors: [
        {
          marketplacePath: "/marketplaces/broken-custom/.claude-plugin/marketplace.json",
          message: "unrelated custom marketplace is unavailable",
        },
      ],
    } satisfies v2.PluginInstalledResponse;
    appServerRequest.mockImplementation(async ({ method }: { method: string }) => {
      if (method === "plugin/installed") {
        return installed;
      }
      if (method === "plugin/read") {
        return pluginRead("google-calendar");
      }
      throw new Error(`unexpected request ${method}`);
    });

    const source = await discoverCodexSource({
      input: fixture.codexHome,
      evaluatePluginMigrationEligibility: true,
    });

    expect(source.pluginDiscoveryError).toBeUndefined();
    expect(source.plugins).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          pluginName: "google-calendar",
          marketplaceName: CODEX_PLUGINS_MARKETPLACE_NAME,
          migratable: true,
        }),
      ]),
    );
    expect(sourceAppServerClientScope).toHaveBeenCalledTimes(1);
  });

  it("discovers installed plugins from the API-key curated marketplace", async () => {
    const fixture = await createCodexFixture();
    appServerRequest.mockImplementation(async ({ method }: { method: string }) => {
      if (method === "plugin/installed") {
        return {
          marketplaces: [
            {
              name: "openai-api-curated",
              path: path.join(
                fixture.codexHome,
                ".tmp/plugins/.agents/plugins/api_marketplace.json",
              ),
              interface: null,
              plugins: [
                pluginSummary("google-calendar@openai-api-curated", {
                  name: "google-calendar",
                  installed: true,
                  enabled: true,
                }),
              ],
            },
          ],
          marketplaceLoadErrors: [],
        } satisfies v2.PluginInstalledResponse;
      }
      throw new Error(`unexpected request ${method}`);
    });

    const source = await discoverCodexSource({ input: fixture.codexHome });

    expect(source.pluginDiscoveryError).toBeUndefined();
    expect(source.plugins).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          pluginName: "google-calendar",
          marketplaceName: CODEX_PLUGINS_MARKETPLACE_NAME,
          migratable: true,
        }),
      ]),
    );
  });

  it("ignores unrelated marketplace errors when no curated plugins are installed", async () => {
    const fixture = await createCodexFixture();
    appServerRequest.mockImplementation(async ({ method }: { method: string }) => {
      if (method === "plugin/installed") {
        return {
          marketplaces: [],
          marketplaceLoadErrors: [
            {
              marketplacePath: "/marketplaces/broken-custom/.agents/plugins/marketplace.json",
              message: "unrelated custom marketplace is unavailable",
            },
          ],
        } satisfies v2.PluginInstalledResponse;
      }
      throw new Error(`unexpected request ${method}`);
    });

    const source = await discoverCodexSource({ input: fixture.codexHome });

    expect(source.pluginDiscoveryError).toBeUndefined();
    expect(source.plugins.every((plugin) => plugin.marketplaceName === undefined)).toBe(true);
    expect(sourceAppServerClientScope).toHaveBeenCalledTimes(1);
    expect(appServerRequest).toHaveBeenCalledTimes(1);
  });

  // Codex reports load failures by manifest file path under the curated sync
  // root `<codexHome>/.tmp/plugins`; cover both curated manifest variants.
  it.each([[".agents/plugins/marketplace.json"], [".agents/plugins/api_marketplace.json"]])(
    "fails closed when the curated %s manifest cannot load",
    async (manifestRelativePath) => {
      const fixture = await createCodexFixture();
      appServerRequest.mockImplementation(async ({ method }: { method: string }) => {
        if (method === "plugin/installed") {
          return {
            marketplaces: [],
            marketplaceLoadErrors: [
              {
                marketplacePath: path.join(fixture.codexHome, ".tmp/plugins", manifestRelativePath),
                message: "curated marketplace is unavailable",
              },
            ],
          } satisfies v2.PluginInstalledResponse;
        }
        throw new Error(`unexpected request ${method}`);
      });

      const source = await discoverCodexSource({ input: fixture.codexHome });

      expect(source.pluginDiscoveryError).toBe("curated marketplace is unavailable");
      expect(source.plugins.some((plugin) => plugin.marketplaceName !== undefined)).toBe(false);
      expect(sourceAppServerClientScope).toHaveBeenCalledTimes(1);
    },
  );

  it("does not trust a curated marketplace that reports its own load error", async () => {
    const fixture = await createCodexFixture();
    appServerRequest.mockImplementation(async ({ method }: { method: string }) => {
      if (method === "plugin/installed") {
        return {
          marketplaces: pluginList([
            pluginSummary("google-calendar", { installed: true, enabled: true }),
          ]).marketplaces,
          marketplaceLoadErrors: [
            {
              marketplacePath: path.join(
                fixture.codexHome,
                ".tmp/plugins/.agents/plugins/marketplace.json",
              ),
              message: "curated marketplace was only partially loaded",
            },
          ],
        } satisfies v2.PluginInstalledResponse;
      }
      throw new Error(`unexpected request ${method}`);
    });

    const source = await discoverCodexSource({ input: fixture.codexHome });

    expect(source.pluginDiscoveryError).toBe("curated marketplace was only partially loaded");
    expect(source.plugins.some((plugin) => plugin.marketplaceName !== undefined)).toBe(false);
  });

  it("prefers remotely installed curated plugins and reads their opaque source id", async () => {
    const fixture = await createCodexFixture();
    const remotePluginId = "plugins~Plugin_11111111111111111111111111111111";
    const local = pluginSummary("linear@openai-curated", {
      name: "linear",
      installed: true,
      enabled: true,
    });
    const remote = pluginSummary("linear@openai-curated-remote", {
      name: "linear",
      remotePluginId,
      installed: true,
      enabled: true,
    });
    appServerRequest.mockImplementation(
      async ({ method, requestParams }: { method: string; requestParams?: unknown }) => {
        if (method === "plugin/installed") {
          return {
            marketplaces: [
              {
                name: CODEX_PLUGINS_MARKETPLACE_NAME,
                path: "/marketplaces/openai-curated",
                interface: null,
                plugins: [local],
              },
              {
                name: `${CODEX_PLUGINS_MARKETPLACE_NAME}-remote`,
                path: null,
                interface: null,
                plugins: [remote],
              },
            ],
            marketplaceLoadErrors: [],
          } satisfies v2.PluginInstalledResponse;
        }
        if (method === "plugin/read") {
          expect(requestParams).toEqual({
            remoteMarketplaceName: `${CODEX_PLUGINS_MARKETPLACE_NAME}-remote`,
            pluginName: remotePluginId,
          });
          return pluginRead("linear");
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

    expect(plan.items.filter((item) => item.id === "plugin:linear")).toHaveLength(1);
    expectRecordFields(findItem(plan.items, "plugin:linear"), {
      action: "install",
      status: "planned",
    });
    expectRecordFields(findItem(plan.items, "plugin:linear").details, {
      marketplaceName: CODEX_PLUGINS_MARKETPLACE_NAME,
      pluginName: "linear",
    });
    expect(sourceAppServerClientScope).toHaveBeenCalledTimes(1);
    expect(appServerRequest.mock.calls.map(([request]) => request.method)).toEqual([
      "plugin/installed",
      "plugin/read",
    ]);
  });

  it("fails closed when a remotely installed plugin omits its opaque source id", async () => {
    const fixture = await createCodexFixture();
    appServerRequest.mockImplementation(async ({ method }: { method: string }) => {
      if (method === "plugin/installed") {
        return {
          marketplaces: [
            {
              name: `${CODEX_PLUGINS_MARKETPLACE_NAME}-remote`,
              path: null,
              interface: null,
              plugins: [
                pluginSummary("linear@openai-curated-remote", {
                  name: "linear",
                  remotePluginId: null,
                  installed: true,
                  enabled: true,
                }),
              ],
            },
          ],
          marketplaceLoadErrors: [],
        } satisfies v2.PluginInstalledResponse;
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

    expect(plan.items.some((item) => item.id === "plugin:linear")).toBe(false);
    expectRecordFields(findItemByReason(plan.items, "plugin_read_unavailable"), {
      action: "manual",
      status: "skipped",
    });
    expect(appServerRequest.mock.calls.map(([request]) => request.method)).toEqual([
      "plugin/installed",
    ]);
    expect(sourceAppServerClientScope).toHaveBeenCalledTimes(1);
  });

  it("imports Codex auth.json OAuth into the selected agent and seeds cached models", async () => {
    const fixture = await createCodexFixture();
    const reportDir = path.join(fixture.root, "report");
    const configState: MigrationProviderContext["config"] = {
      agents: {
        defaults: {
          model: { fallbacks: [] },
          workspace: fixture.workspaceDir,
        },
        list: [{ id: "main", default: true }, { id: "research" }],
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
      targetAgentId: "research",
    });
    const plan = await provider.plan(ctx);
    expectRecordFields(findItem(plan.items, "auth:openai"), {
      kind: "auth",
      status: "planned",
      sensitive: true,
    });

    const result = await provider.apply(ctx, plan);

    expectRecordFields(findItem(result.items, "auth:openai"), { status: "migrated" });
    const authStore = loadTargetAuthStore(fixture, "research");
    expect(authStore.profiles?.["openai:account-acct_test"]).toEqual(
      expect.objectContaining({
        type: "oauth",
        provider: "openai",
        access: accessToken,
        refresh: "refresh-test-token",
      }),
    );
    expect(loadTargetAuthStore(fixture).profiles?.["openai:account-acct_test"]).toBeUndefined();
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

  it.each([
    {
      name: "skips source-installed plugins whose owned apps are inaccessible",
      isAccessible: false,
      isEnabled: true,
      reason: "app_inaccessible",
    },
    {
      name: "reports authorized source-owned apps as disabled, not inaccessible",
      isAccessible: true,
      isEnabled: false,
      reason: "app_disabled",
    },
  ])("$name", async ({ isAccessible, isEnabled, reason }) => {
    const fixture = await createCodexFixture();
    appServerRequest.mockImplementation(
      async ({ method, requestParams }: { method: string; requestParams?: unknown }) => {
        if (method === "plugin/installed" || method === "plugin/list") {
          return pluginMetadata(method, [
            pluginSummary("readwise", { installed: true, enabled: true }),
          ]);
        }
        if (method === "plugin/read") {
          return pluginRead("readwise", [pluginApp("asdk_app_readwise", { name: "Readwise" })]);
        }
        if (method === "account/read") {
          return chatGptAccount();
        }
        if (method === "app/installed" || method === "app/read") {
          if (method === "app/installed") {
            expectRecordFields(requestParams, { forceRefresh: true });
          }
          return codexAppInventoryResponse(method, [
            appInfo("asdk_app_readwise", {
              name: "Readwise",
              isAccessible,
              isEnabled,
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
    const manualItem = findItemByReason(plan.items, reason);
    expectRecordFields(manualItem, {
      kind: "manual",
      action: "manual",
      status: "skipped",
      reason,
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
        isAccessible,
        isEnabled,
      },
    ]);
    expect(
      appServerRequest.mock.calls.filter(([arg]) => arg.method === "app/installed"),
    ).toHaveLength(1);
  });

  it.each([
    {
      state: "missing from the committed installed runtime",
      installedApp: undefined,
      reason: "app_missing",
      expectedApp: { id: "asdk_app_readwise", name: "Readwise" },
    },
    {
      state: "disabled in the committed runtime despite authorized metadata",
      installedApp: {
        id: "asdk_app_readwise",
        runtimeName: "Readwise",
        enabled: false,
        callable: false,
      } satisfies v2.InstalledApp,
      reason: "app_disabled",
      expectedApp: {
        id: "asdk_app_readwise",
        name: "Readwise",
        isAccessible: true,
        isEnabled: false,
      },
    },
    {
      state: "enabled but not callable in the committed runtime",
      installedApp: {
        id: "asdk_app_readwise",
        runtimeName: "Readwise",
        enabled: true,
        callable: false,
      } satisfies v2.InstalledApp,
      reason: "app_inaccessible",
      expectedApp: {
        id: "asdk_app_readwise",
        name: "Readwise",
        isAccessible: false,
        isEnabled: true,
        isCallable: false,
      },
    },
  ])(
    "fails closed when an authorized source app is $state",
    async ({ installedApp, reason, expectedApp }) => {
      const fixture = await createCodexFixture();
      appServerRequest.mockImplementation(async ({ method }: { method: string }) => {
        if (method === "plugin/installed") {
          return pluginMetadata(method, [
            pluginSummary("readwise", { installed: true, enabled: true }),
          ]);
        }
        if (method === "plugin/read") {
          return pluginRead("readwise", [pluginApp("asdk_app_readwise", { name: "Readwise" })]);
        }
        if (method === "account/read") {
          return chatGptAccount();
        }
        if (method === "app/installed") {
          return { apps: installedApp ? [installedApp] : [] } satisfies v2.AppsInstalledResponse;
        }
        if (method === "app/read") {
          return codexAppInventoryResponse("app/read", [
            appInfo("asdk_app_readwise", { name: "Readwise" }),
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

      expect(plan.items.some((item) => item.id === "plugin:readwise")).toBe(false);
      expect(plan.items.some((item) => item.id === "config:codex-plugins")).toBe(false);
      const manualItem = findItemByReason(plan.items, reason);
      expectRecordFields(manualItem, { reason, status: "skipped" });
      expectRecordFields(manualItem.details, {
        pluginName: "readwise",
        marketplaceName: CODEX_PLUGINS_MARKETPLACE_NAME,
        apps: [expectedApp],
      });
      if (installedApp?.enabled && !installedApp.callable) {
        expect(manualItem.message).toEqual(expect.stringContaining("not callable"));
      }
      expect(sourceAppServerClientScope).toHaveBeenCalledTimes(1);
    },
  );

  it("reports installed apps without authorized metadata as inaccessible", async () => {
    const fixture = await createCodexFixture();
    appServerRequest.mockImplementation(async ({ method }: { method: string }) => {
      if (method === "plugin/installed" || method === "plugin/list") {
        return pluginMetadata(method, [
          pluginSummary("readwise", { installed: true, enabled: true }),
        ]);
      }
      if (method === "plugin/read") {
        return pluginRead("readwise", [pluginApp("asdk_app_readwise", { name: "Readwise" })]);
      }
      if (method === "account/read") {
        return chatGptAccount();
      }
      if (method === "app/installed") {
        return codexAppInventoryResponse(method, [
          appInfo("asdk_app_readwise", { name: "Readwise" }),
        ]);
      }
      if (method === "app/read") {
        return codexAppInventoryResponse(method, []);
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
    expectRecordFields(manualItem.details, {
      pluginName: "readwise",
      apps: [
        {
          id: "asdk_app_readwise",
          name: "Readwise",
          isAccessible: false,
          isEnabled: true,
        },
      ],
    });
    expect(plan.items.some((item) => item.id === "plugin:readwise")).toBe(false);
  });

  it("plans app-backed plugins without source app inventory by default", async () => {
    const fixture = await createCodexFixture();
    appServerRequest.mockImplementation(async ({ method }: { method: string }) => {
      if (method === "plugin/installed" || method === "plugin/list") {
        return pluginMetadata(method, [pluginSummary("gmail", { installed: true, enabled: true })]);
      }
      if (method === "plugin/read") {
        return pluginRead("gmail", [pluginApp("app-gmail", { name: "Gmail" })]);
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
    expect(
      appServerRequest.mock.calls.filter(([arg]) => arg.method === "app/installed"),
    ).toHaveLength(0);
  });

  it("warns and skips app-backed plugins when source Codex account is not ChatGPT subscription auth", async () => {
    const fixture = await createCodexFixture();
    appServerRequest.mockImplementation(async ({ method }: { method: string }) => {
      if (method === "plugin/installed" || method === "plugin/list") {
        return pluginMetadata(method, [pluginSummary("gmail", { installed: true, enabled: true })]);
      }
      if (method === "plugin/read") {
        return pluginRead("gmail", [pluginApp("app-gmail", { name: "Gmail" })]);
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
      },
    ]);
    expect(plan.warnings).toEqual([
      "Codex app-backed plugin migration requires the Codex app-server source account to be logged in with a ChatGPT subscription account. Log in to the Codex app with subscription auth; OpenClaw auth or API-key auth does not satisfy Codex app connector access.",
    ]);
    expect(
      appServerRequest.mock.calls.filter(([arg]) => arg.method === "app/installed"),
    ).toHaveLength(0);
  });

  it.each([
    { name: "missing", account: null },
    { name: "malformed", account: { type: "unknown" } },
  ])(
    "reports an unavailable source account when Codex returns a $name account",
    async ({ account }) => {
      const fixture = await createCodexFixture();
      appServerRequest.mockImplementation(async ({ method }: { method: string }) => {
        if (method === "plugin/installed" || method === "plugin/list") {
          return pluginMetadata(method, [
            pluginSummary("gmail", { installed: true, enabled: true }),
          ]);
        }
        if (method === "plugin/read") {
          return pluginRead("gmail", [pluginApp("app-gmail", { name: "Gmail" })]);
        }
        if (method === "account/read") {
          return {
            account,
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
      const manualItem = findItemByReason(plan.items, "codex_account_unavailable");
      expectRecordFields(manualItem, {
        reason: "codex_account_unavailable",
        status: "skipped",
      });
      expectRecordFields(manualItem.details, {
        error: "Codex app-server did not report an authenticated source account.",
      });
      expect(plan.warnings).toEqual([]);
      expect(
        appServerRequest.mock.calls.filter(([arg]) => arg.method === "app/installed"),
      ).toHaveLength(0);
    },
  );

  it("verifies source apps when account metadata is unavailable for backend auth", async () => {
    const fixture = await createCodexFixture();
    appServerRequest.mockImplementation(async ({ method }: { method: string }) => {
      if (method === "plugin/installed" || method === "plugin/list") {
        return pluginMetadata(method, [pluginSummary("gmail", { installed: true, enabled: true })]);
      }
      if (method === "plugin/read") {
        return pluginRead("gmail", [pluginApp("app-gmail", { name: "Gmail" })]);
      }
      if (method === "account/read") {
        return {
          account: null,
          requiresOpenaiAuth: true,
        } satisfies CodexGetAccountResponse;
      }
      if (method === "app/installed" || method === "app/read") {
        return codexAppInventoryResponse(method, [appInfo("app-gmail")]);
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
    expect(
      appServerRequest.mock.calls.filter(([arg]) => arg.method === "app/installed"),
    ).toHaveLength(1);
  });

  it("falls through to app inventory when source account read fails and app verification is requested", async () => {
    const fixture = await createCodexFixture();
    appServerRequest.mockImplementation(async ({ method }: { method: string }) => {
      if (method === "plugin/installed" || method === "plugin/list") {
        return pluginMetadata(method, [pluginSummary("gmail", { installed: true, enabled: true })]);
      }
      if (method === "plugin/read") {
        return pluginRead("gmail", [pluginApp("app-gmail", { name: "Gmail" })]);
      }
      if (method === "account/read") {
        throw new Error("account unavailable");
      }
      if (method === "app/installed" || method === "app/read") {
        return codexAppInventoryResponse(method, [appInfo("app-gmail")]);
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
    expect(
      appServerRequest.mock.calls.filter(([arg]) => arg.method === "app/installed"),
    ).toHaveLength(1);
  });

  it("skips app-backed plugins by default when source account read fails", async () => {
    const fixture = await createCodexFixture();
    appServerRequest.mockImplementation(async ({ method }: { method: string }) => {
      if (method === "plugin/installed" || method === "plugin/list") {
        return pluginMetadata(method, [pluginSummary("gmail", { installed: true, enabled: true })]);
      }
      if (method === "plugin/read") {
        return pluginRead("gmail", [pluginApp("app-gmail", { name: "Gmail" })]);
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
    expect(
      appServerRequest.mock.calls.filter(([arg]) => arg.method === "app/installed"),
    ).toHaveLength(0);
  });

  it("reads source plugin readiness with native source auth instead of target agent auth", async () => {
    const fixture = await createCodexFixture();
    appServerRequest.mockImplementation(async ({ method }: { method: string }) => {
      if (method === "plugin/installed" || method === "plugin/list") {
        return pluginMetadata(method, [
          pluginSummary("google-calendar", { installed: true, enabled: true }),
        ]);
      }
      if (method === "plugin/read") {
        return pluginRead("google-calendar", [
          pluginApp("app-google-calendar", { name: "Google Calendar" }),
        ]);
      }
      if (method === "account/read") {
        return chatGptAccount();
      }
      if (method === "app/installed" || method === "app/read") {
        return codexAppInventoryResponse(method, [appInfo("app-google-calendar")]);
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

    expect(appServerRequest).toHaveBeenCalledTimes(5);
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
      if (method === "plugin/installed" || method === "plugin/list") {
        return pluginMetadata(method, [
          pluginSummary("readwise", { installed: true, enabled: true }),
        ]);
      }
      if (method === "plugin/read") {
        return pluginRead("readwise", [
          pluginApp("asdk_app_readwise", { name: "Readwise" }),
          pluginApp("asdk_app_reader", { name: "Reader" }),
        ]);
      }
      if (method === "account/read") {
        return chatGptAccount();
      }
      if (method === "app/installed" || method === "app/read") {
        return codexAppInventoryResponse(method, [
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
      },
      {
        id: "asdk_app_readwise",
        name: "Readwise",
        isAccessible: false,
        isEnabled: true,
      },
    ]);
  });

  it("force-refreshes source app inventory once for app-backed plugins sharing a cache key", async () => {
    const fixture = await createCodexFixture();
    await defaultCodexAppInventoryCache.refreshNow({
      key: sourceAppCacheKey(fixture),
      request: async (method, params) =>
        codexAppInventoryResponse(
          method,
          [appInfo("app-google-calendar", { isAccessible: false })],
          params,
        ),
    });
    appServerRequest.mockImplementation(
      async ({ method, requestParams }: { method: string; requestParams?: unknown }) => {
        if (method === "plugin/installed" || method === "plugin/list") {
          return pluginMetadata(method, [
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
        if (method === "app/installed" || method === "app/read") {
          if (method === "app/installed") {
            expectRecordFields(requestParams, { forceRefresh: true });
          }
          return codexAppInventoryResponse(method, [
            appInfo("app-google-calendar"),
            appInfo("app-gmail"),
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

    expectRecordFields(findItem(plan.items, "plugin:google-calendar"), { status: "planned" });
    expectRecordFields(findItem(plan.items, "plugin:gmail"), { status: "planned" });
    expect(sourceAppServerClientScope).toHaveBeenCalledTimes(1);
    expect(
      appServerRequest.mock.calls.filter(([arg]) => arg.method === "plugin/installed"),
    ).toHaveLength(1);
    expect(
      appServerRequest.mock.calls.filter(([arg]) => arg.method === "plugin/read"),
    ).toHaveLength(2);
    expect(appServerRequest.mock.calls.some(([arg]) => arg.method === "plugin/list")).toBe(false);
    expect(
      appServerRequest.mock.calls.filter(([arg]) => arg.method === "app/installed"),
    ).toHaveLength(1);
  });

  it("fails closed for disabled plugins and plugin/read failures", async () => {
    const fixture = await createCodexFixture();
    appServerRequest.mockImplementation(
      async ({ method, requestParams }: { method: string; requestParams?: unknown }) => {
        if (method === "plugin/installed" || method === "plugin/list") {
          return pluginMetadata(method, [
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
    expect(
      appServerRequest.mock.calls.filter(([arg]) => arg.method === "app/installed"),
    ).toHaveLength(0);
  });

  it("fails closed when app inventory refresh fails for app-backed plugins", async () => {
    const fixture = await createCodexFixture();
    appServerRequest.mockImplementation(async ({ method }: { method: string }) => {
      if (method === "plugin/installed" || method === "plugin/list") {
        return pluginMetadata(method, [
          pluginSummary("readwise", { installed: true, enabled: true }),
        ]);
      }
      if (method === "plugin/read") {
        return pluginRead("readwise", [pluginApp("asdk_app_readwise", { name: "Readwise" })]);
      }
      if (method === "account/read") {
        return chatGptAccount();
      }
      if (method === "app/installed") {
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

  it("treats fieldless source app summaries as ready when app inventory confirms access", async () => {
    const fixture = await createCodexFixture();
    appServerRequest.mockImplementation(async ({ method }: { method: string }) => {
      if (method === "plugin/installed" || method === "plugin/list") {
        return pluginMetadata(method, [
          pluginSummary("reader", { installed: true, enabled: true }),
        ]);
      }
      if (method === "plugin/read") {
        return pluginRead("reader", [
          pluginApp("ready-app", { name: "Ready App" }),
          pluginApp("auth-app", { name: "Auth App" }),
        ]);
      }
      if (method === "account/read") {
        return chatGptAccount();
      }
      if (method === "app/installed" || method === "app/read") {
        return codexAppInventoryResponse(method, [appInfo("ready-app"), appInfo("auth-app")]);
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

    await fs.access(path.join(fixture.workspaceDir, "skills", "tweet-helper", "SKILL.md"));
    await fs.access(path.join(fixture.workspaceDir, "skills", "personal-style", "SKILL.md"));
    await fs.access(path.join(reportDir, "archive", "config.toml"));
    expectRecordFields(findItem(result.items, "plugin:documents:1"), { status: "skipped" });
    expectRecordFields(findItem(result.items, "skill:tweet-helper"), { status: "migrated" });
    expectRecordFields(findItem(result.items, "archive:config.toml"), { status: "migrated" });
    await fs.access(path.join(reportDir, "report.json"));
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
        if (method === "plugin/installed" && !isTarget) {
          return pluginMetadata(method, [
            pluginSummary("google-calendar", { installed: true, enabled: true }),
          ]);
        }
        if (method === "plugin/list" && isTarget) {
          targetPluginListCalls += 1;
          if (targetPluginListCalls === 1) {
            return { marketplaces: [], marketplaceLoadErrors: [], featuredPluginIds: [] };
          }
          return pluginMetadata(method, [
            pluginSummary("google-calendar", { installed: true, enabled: true }),
          ]);
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
        if (method === "app/installed" || method === "app/read") {
          return codexAppInventoryResponse(method, []);
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
        if (method === "plugin/installed" && !isTarget) {
          return pluginMetadata(method, [
            pluginSummary("google-calendar", { installed: true, enabled: true }),
          ]);
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
        if (method === "app/installed" || method === "app/read") {
          return codexAppInventoryResponse(method, []);
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
        if (method === "plugin/installed" && !isTarget) {
          return pluginMetadata(method, [
            pluginSummary("google-calendar", { installed: true, enabled: true }),
          ]);
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
        if (method === "app/installed" || method === "app/read") {
          return codexAppInventoryResponse(method, []);
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
      if (method === "plugin/installed" || method === "plugin/list") {
        return pluginMetadata(method, [
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
      if (method === "plugin/installed" || method === "plugin/list") {
        return pluginMetadata(method, [
          pluginSummary("google-calendar", { installed: true, enabled: true }),
        ]);
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
      if (method === "app/installed" || method === "app/read") {
        return codexAppInventoryResponse(method, []);
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
      if (method === "plugin/installed" || method === "plugin/list") {
        return pluginMetadata(method, [
          pluginSummary("google-calendar", { installed: true, enabled: true }),
        ]);
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
      if (method === "app/installed" || method === "app/read") {
        return codexAppInventoryResponse(method, []);
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
      request: async (method, params) =>
        codexAppInventoryResponse(method, [appInfo("source-only-app")], params),
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
      if (method === "plugin/installed" || method === "plugin/list") {
        return pluginMetadata(method, [
          pluginSummary("google-calendar", { installed: true, enabled: true }),
        ]);
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
      if (method === "app/installed" || method === "app/read") {
        return codexAppInventoryResponse(method, []);
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
      if (method === "plugin/installed" || method === "plugin/list") {
        return pluginMetadata(method, [
          pluginSummary("google-calendar", { installed: true, enabled: true }),
        ]);
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
      if (method === "app/installed" || method === "app/read") {
        return codexAppInventoryResponse(method, []);
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
      if (method === "plugin/installed" || method === "plugin/list") {
        return pluginMetadata(method, [
          pluginSummary("google-calendar", { installed: true, enabled: true }),
        ]);
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
      if (method === "app/installed" || method === "app/read") {
        return codexAppInventoryResponse(method, []);
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
      if (method === "plugin/installed" || method === "plugin/list") {
        return pluginMetadata(method, [
          pluginSummary("google-calendar", { installed: true, enabled: true }),
        ]);
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
      if (method === "app/installed" || method === "app/read") {
        return codexAppInventoryResponse(method, []);
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

  it("records fieldless auth-required plugin install apps as disabled explicit config entries", async () => {
    const fixture = await createCodexFixture();
    const configState: MigrationProviderContext["config"] = {
      agents: { defaults: { workspace: fixture.workspaceDir } },
    } as MigrationProviderContext["config"];
    appServerRequest.mockImplementation(async ({ method }: { method: string }) => {
      if (method === "plugin/installed" || method === "plugin/list") {
        return pluginMetadata(method, [
          pluginSummary("google-calendar", { installed: true, enabled: true }),
        ]);
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
              category: "productivity",
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
      if (method === "app/installed" || method === "app/read") {
        return codexAppInventoryResponse(method, []);
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
      if (method === "plugin/installed" || method === "plugin/list") {
        return pluginMetadata(method, [
          pluginSummary("google-calendar", { installed: true, enabled: true }),
        ]);
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
      status: "warning",
      reason: "selected Codex plugin activation is incomplete",
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

function pluginMetadata(
  method: "plugin/installed" | "plugin/list",
  plugins: v2.PluginSummary[],
): v2.PluginInstalledResponse | v2.PluginListResponse {
  const response = pluginList(plugins);
  if (method === "plugin/installed") {
    return {
      marketplaces: response.marketplaces,
      marketplaceLoadErrors: [],
    };
  }
  return response;
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
    category: null,
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
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
