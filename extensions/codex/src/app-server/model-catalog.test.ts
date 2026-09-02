import fs from "node:fs/promises";
import path from "node:path";
import { loadAuthProfileStoreForSecretsRuntime } from "openclaw/plugin-sdk/agent-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { MigrationProviderContext } from "openclaw/plugin-sdk/plugin-entry";
import {
  resolvePreferredOpenClawTmpDir,
  tempWorkspace,
  type TempWorkspace,
} from "openclaw/plugin-sdk/temp-path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildMigrationProvider as buildCodexMigrationProvider } from "../../migration-provider-api.js";
import { createCodexAppServerModelCatalog } from "./model-catalog.js";
import { listAllCodexAppServerModels } from "./models.js";
import { withCodexAppServerJsonClient } from "./request.js";

vi.mock("./models.js", () => ({
  listAllCodexAppServerModels: vi.fn(),
}));

const rpc = vi.hoisted(() => ({ request: vi.fn(), epoch: 0, client: {} }));
vi.mock("./request.js", () => ({
  withCodexAppServerJsonClient: vi.fn(
    (_options: unknown, run: (request: unknown, client: unknown) => unknown) =>
      run(rpc.request, rpc.client),
  ),
}));
vi.mock("./shared-client.js", () => ({
  captureSharedCodexAppServerCatalogLifetime: () => {
    const epoch = rpc.epoch;
    return () => rpc.epoch === epoch;
  },
}));
let owner: ReturnType<typeof createCodexAppServerModelCatalog>;
const loadCodexAppServerModelCatalog = (...args: Parameters<typeof owner.load>) =>
  owner.load(...args);
const read = (overrides = {}) =>
  owner.read(
    { ...catalogParams, provider: "openai", modelId: "synthetic-opaque", ...overrides },
    undefined,
  );
const listModelsMock = vi.mocked(listAllCodexAppServerModels);
const tempWorkspaces: TempWorkspace[] = [];

const catalogParams = {
  config: {},
  agentId: "main",
  agentDir: "/tmp/main-agent",
  workspaceDir: "/tmp/workspace",
};

function fakeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.signature`;
}

function appServerModel(id: string) {
  return {
    id,
    model: id,
    displayName: id,
    inputModalities: ["text"],
    supportedReasoningEfforts: [],
  };
}

describe("Codex app-server model catalog", () => {
  beforeEach(() => {
    listModelsMock.mockReset();
    vi.mocked(withCodexAppServerJsonClient).mockClear();
    rpc.epoch += 1;
    rpc.request
      .mockReset()
      .mockResolvedValue({ account: { type: "apiKey" }, requiresOpenaiAuth: true });
    owner = createCodexAppServerModelCatalog("codex");
  });

  afterEach(async () => {
    await Promise.all(tempWorkspaces.splice(0).map((workspace) => workspace.cleanup()));
  });

  it("keeps native picker models independent of a host transport", async () => {
    listModelsMock.mockResolvedValue({
      models: [
        {
          id: "gpt-5.6-sol",
          model: "codex-execution-model",
          displayName: "GPT-5.6 Sol",
          inputModalities: ["text", "image", "unknown"],
          supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
        },
        {
          id: "gpt-5.6-luna",
          model: "gpt-5.6-luna",
          displayName: "GPT-5.6 Luna",
          inputModalities: ["text"],
          supportedReasoningEfforts: [],
        },
      ],
    });
    const catalog = await loadCodexAppServerModelCatalog(catalogParams, undefined);
    expect(catalog).toEqual([
      {
        provider: "openai",
        nativeRuntime: "codex",
        id: "gpt-5.6-sol",
        name: "GPT-5.6 Sol",
        providerOrder: 0,
        reasoning: true,
        input: ["text", "image"],
        params: { codexAppServerRuntimeModel: "codex-execution-model" },
        compat: {
          supportsReasoningEffort: true,
          supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
        },
      },
      {
        provider: "openai",
        nativeRuntime: "codex",
        id: "gpt-5.6-luna",
        name: "GPT-5.6 Luna",
        providerOrder: 1,
        reasoning: false,
        input: ["text"],
        compat: {
          supportsReasoningEffort: false,
          supportedReasoningEfforts: [],
        },
      },
    ]);
    expect(listModelsMock).toHaveBeenCalledExactlyOnceWith({ request: rpc.request, limit: 100 });
  });

  it("returns no rows without a live call when discovery is disabled", async () => {
    expect(
      await loadCodexAppServerModelCatalog(catalogParams, { discovery: { enabled: false } }),
    ).toEqual([]);
    expect(listModelsMock).not.toHaveBeenCalled();
  });

  it("bounds the live call with the configured discovery timeout", async () => {
    listModelsMock.mockResolvedValue({ models: [] });
    await loadCodexAppServerModelCatalog(catalogParams, { discovery: { timeoutMs: 750 } });
    expect(withCodexAppServerJsonClient).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ timeoutMs: 750 }),
      expect.any(Function),
    );
  });

  it("keeps CLI auth import separate from refreshed /models membership", async () => {
    const workspace = await tempWorkspace({
      rootDir: resolvePreferredOpenClawTmpDir(),
      prefix: "openclaw-codex-auth-catalog-",
    });
    tempWorkspaces.push(workspace);
    const codexHome = path.join(workspace.dir, ".codex");
    const stateDir = path.join(workspace.dir, "state");
    const workspaceDir = path.join(workspace.dir, "workspace");
    const agentDir = path.join(stateDir, "agents", "main", "agent");
    const accessToken = fakeJwt({
      exp: Math.floor(Date.now() / 1000) + 3600,
      "https://api.openai.com/auth": { chatgpt_account_id: "acct_catalog_refresh" },
      "https://api.openai.com/profile": { email: "catalog-refresh@example.test" },
    });
    await fs.mkdir(codexHome, { recursive: true });
    await fs.writeFile(
      path.join(codexHome, "auth.json"),
      JSON.stringify({
        auth_mode: "chatgpt",
        tokens: {
          access_token: accessToken,
          refresh_token: "refresh-catalog-test",
          id_token: "id-catalog-test",
          account_id: "acct_catalog_refresh",
        },
      }),
    );
    const config: MigrationProviderContext["config"] = {
      agents: {
        defaults: { workspace: workspaceDir },
        list: [{ id: "main", default: true }],
      },
    };
    const context: MigrationProviderContext = {
      config,
      source: codexHome,
      stateDir,
      targetAgentId: "main",
      itemKinds: ["auth"],
      includeSecrets: true,
      providerOptions: { configPatchMode: "return" },
      logger: { info() {}, warn() {}, error() {}, debug() {} },
    };
    let remoteModels = [appServerModel("catalog-a"), appServerModel("removed-after-refresh")];
    const hasImportedAuth = () =>
      loadAuthProfileStoreForSecretsRuntime(agentDir).profiles[
        "openai:account-acct_catalog_refresh"
      ] !== undefined;
    listModelsMock.mockImplementation(async () => ({
      models: hasImportedAuth() ? remoteModels : [],
    }));
    rpc.request.mockImplementation(async () => ({
      account: hasImportedAuth() ? { type: "chatgpt" } : null,
      requiresOpenaiAuth: true,
    }));
    const catalogOwner = createCodexAppServerModelCatalog("codex");
    const params = { config, agentId: "main", agentDir, workspaceDir };

    expect(await catalogOwner.load(params, undefined)).toEqual([]);
    const migrationProvider = buildCodexMigrationProvider();
    const plan = await migrationProvider.plan(context);
    const applied = await migrationProvider.apply(context, plan);

    expect(applied.items.find((item) => item.id === "auth:openai")?.status).toBe("migrated");
    expect(hasImportedAuth()).toBe(true);
    expect(config.agents?.defaults?.models).toBeUndefined();
    await expect(fs.stat(path.join(codexHome, "models_cache.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });

    const catalogA = await catalogOwner.load(params, undefined);
    expect(catalogA.map((model) => model.id)).toEqual(["catalog-a", "removed-after-refresh"]);

    remoteModels = [appServerModel("catalog-b")];
    const catalogB = await catalogOwner.load(params, undefined);
    expect(catalogB.map((model) => model.id)).toEqual(["catalog-b"]);
    expect(catalogB.some((model) => model.id === "removed-after-refresh")).toBe(false);
  });
  it.each([
    { account: { type: "apiKey" }, mode: "apiKey" },
    {
      account: { type: "chatgpt", email: "synthetic@example.test", planType: "plus" },
      mode: "chatgpt",
    },
    { account: null, mode: undefined },
  ])("preserves account mode $mode without importing credentials", async ({ account, mode }) => {
    listModelsMock.mockResolvedValue({
      models: [
        {
          id: "synthetic-opaque",
          model: "synthetic-opaque",
          inputModalities: ["text"],
          supportedReasoningEfforts: [],
        },
      ],
    });
    rpc.request.mockResolvedValue({ account, requiresOpenaiAuth: true });
    await owner.load(catalogParams, undefined);
    expect(read()).toEqual(mode ? { accountType: mode } : undefined);
    expect(read({ agentId: "another" })).toBeUndefined();
    expect(read({ agentDir: "/tmp/another-agent" })).toBeUndefined();
    expect(read({ workspaceDir: "/tmp/another-workspace" })).toBeUndefined();
    expect(read({ config: { ...catalogParams.config } })).toBeUndefined();
    expect(read({ modelId: "unlisted" })).toBeUndefined();
    expect(read({ provider: "another" })).toBeUndefined();
    expect(
      owner.read({ ...catalogParams, provider: "openai", modelId: "synthetic-opaque" }, {}),
    ).toBeUndefined();
    rpc.epoch += 1;
    expect(read()).toBeUndefined();
  });

  it("revokes prior readiness on failed or disabled refresh", async () => {
    listModelsMock.mockResolvedValue({
      models: [
        {
          id: "synthetic-opaque",
          model: "synthetic-opaque",
          inputModalities: ["text"],
          supportedReasoningEfforts: [],
        },
      ],
    });
    await owner.load(catalogParams, undefined);
    expect(read()).toEqual({ accountType: "apiKey" });
    rpc.request.mockRejectedValueOnce(new Error("synthetic account failure"));
    await expect(owner.load(catalogParams, undefined)).rejects.toThrow("synthetic account failure");
    expect(read()).toBeUndefined();
    await owner.load(catalogParams, undefined);
    await owner.load(catalogParams, { discovery: { enabled: false } });
    expect(read()).toBeUndefined();
  });

  it("cannot publish superseded or disposed asynchronous observations", async () => {
    listModelsMock.mockResolvedValue({
      models: [
        {
          id: "synthetic-opaque",
          model: "synthetic-opaque",
          inputModalities: ["text"],
          supportedReasoningEfforts: [],
        },
      ],
    });
    const pending = createDeferred<unknown>();
    rpc.request.mockReturnValueOnce(pending.promise);
    const older = owner.load(catalogParams, undefined);
    await vi.waitFor(() => expect(rpc.request).toHaveBeenCalledOnce());
    expect(read()).toBeUndefined();
    await owner.load(catalogParams, undefined);
    pending.resolve({ account: { type: "chatgpt" }, requiresOpenaiAuth: true });
    expect(await older).toEqual([]);
    expect(read()).toEqual({ accountType: "apiKey" });
    const disposed = createDeferred<unknown>();
    rpc.request.mockReturnValueOnce(disposed.promise);
    const late = owner.load(catalogParams, undefined);
    await vi.waitFor(() => expect(rpc.request).toHaveBeenCalledTimes(3));
    owner.dispose();
    disposed.resolve({ account: { type: "apiKey" }, requiresOpenaiAuth: true });
    expect(await late).toEqual([]);
    expect(read()).toBeUndefined();
  });
});
