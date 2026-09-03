import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  WizardNextResult,
  WizardStartResult,
  WizardStatusResult,
} from "../../packages/gateway-protocol/src/index.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveAgentDir } from "../agents/agent-scope.js";
import { upsertAuthProfile } from "../agents/auth-profiles/profiles.js";
import { loadAuthProfileStoreWithoutExternalProfiles } from "../agents/auth-profiles/store.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import {
  connectGatewayClient,
  disconnectGatewayClient,
  startGatewayWithClient,
} from "./test-helpers.e2e.js";

const COLLISION_PROVIDER = "collision-provider";
const SELECTED_OWNER = "selected-login-owner";
const WORKSPACE_OWNER = "aaa-workspace-shadow";
const PROBE_KEY = Symbol.for("openclaw.test.providerLoginOwnerCollision");
const IMPORT_PLUGIN = "provider-login-import-fixture";
const IMPORT_CHOICE = "fixture-openai-import";
const IMPORT_MIGRATION = "fixture-openai-migration";
const IMPORTED_PROFILE = "openai:imported";
const CONFIGURED_PROFILE = "openai:configured";
const IMPORT_PROBE_KEY = Symbol.for("openclaw.test.providerLoginImportPromotion");

type CollisionProbe = {
  selectedAuthRuns: number;
  selectedAuthRelease: Promise<void>;
  workspaceAuthRuns: number;
  workspaceModuleLoads: number;
};

type ImportProbe = {
  releasePersistence: Promise<void>;
};

const envKeys = [
  "HOME",
  "OPENCLAW_STATE_DIR",
  "OPENCLAW_CONFIG_PATH",
  "OPENCLAW_GATEWAY_TOKEN",
  "OPENCLAW_SKIP_CHANNELS",
  "OPENCLAW_SKIP_GMAIL_WATCHER",
  "OPENCLAW_SKIP_CRON",
  "OPENCLAW_SKIP_CANVAS_HOST",
  "OPENCLAW_SKIP_BROWSER_CONTROL_SERVER",
  "OPENCLAW_SKIP_PROVIDERS",
  "OPENCLAW_BUNDLED_PLUGINS_DIR",
  "OPENCLAW_DISABLE_BUNDLED_PLUGINS",
  "OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR",
] as const;

function configureGatewayFixtureEnvironment(params: {
  tempHome: string;
  stateDir: string;
  configPath: string;
  token: string;
  bundledPluginsDir: string;
}) {
  for (const [key, value] of Object.entries({
    HOME: params.tempHome,
    OPENCLAW_STATE_DIR: params.stateDir,
    OPENCLAW_CONFIG_PATH: params.configPath,
    OPENCLAW_GATEWAY_TOKEN: params.token,
    OPENCLAW_SKIP_CHANNELS: "1",
    OPENCLAW_SKIP_GMAIL_WATCHER: "1",
    OPENCLAW_SKIP_CRON: "1",
    OPENCLAW_SKIP_CANVAS_HOST: "1",
    OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
    OPENCLAW_BUNDLED_PLUGINS_DIR: params.bundledPluginsDir,
    OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1",
  })) {
    setTestEnvValue(key, value);
  }
  delete process.env.OPENCLAW_SKIP_PROVIDERS;
  delete process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS;
}

function pluginManifest(params: { id: string; selected?: boolean }) {
  return {
    id: params.id,
    name: params.id,
    enabledByDefault: params.selected === true,
    providers: [COLLISION_PROVIDER],
    ...(params.selected
      ? {
          providerAuthChoices: [
            {
              provider: COLLISION_PROVIDER,
              method: "oauth",
              choiceId: "collision-oauth",
              choiceLabel: "Collision OAuth",
              appGuidedAuth: "device-code",
              channelLogin: { aliases: ["collision"] },
            },
          ],
        }
      : {}),
    configSchema: { type: "object", additionalProperties: false, properties: {} },
  };
}

function pluginModule(params: { id: string; selected?: boolean }): string {
  const counter = params.selected ? "selectedAuthRuns" : "workspaceAuthRuns";
  const profile = params.selected ? "selected" : "workspace";
  return `
const probe = globalThis[Symbol.for("openclaw.test.providerLoginOwnerCollision")];
${params.selected ? "" : "probe.workspaceModuleLoads += 1;"}
export default {
  id: ${JSON.stringify(params.id)},
  register(api) {
    api.registerProvider({
      id: "collision-provider",
      label: ${JSON.stringify(params.id)},
      auth: [{
        id: "oauth",
        label: "OAuth",
        kind: "oauth",
        async run({ prompter }) {
          probe.${counter} += 1;
          await prompter.deviceCode?.({
            title: "Collision OAuth",
            code: ${JSON.stringify(params.selected ? "SELECTED-CODE" : "WORKSPACE-CODE")},
            message: "https://example.invalid/device",
          });
          ${params.selected ? "await probe.selectedAuthRelease;" : ""}
          return {
            ${params.selected ? 'configPatch: { agents: { defaults: { model: "collision-provider/default" } }, messages: { responsePrefix: "provider-stale" } },' : ""}
            profiles: [{
              profileId: ${JSON.stringify(`${COLLISION_PROVIDER}:${profile}`)},
              credential: {
                type: "oauth",
                provider: "collision-provider",
                access: ${JSON.stringify(`${profile}-access`)},
                refresh: ${JSON.stringify(`${profile}-refresh`)},
                expires: Date.now() + 60000,
              },
            }],
          };
        },
      }],
    });
  },
};
`;
}

async function writePlugin(root: string, params: { id: string; selected?: boolean }) {
  const pluginDir = path.join(root, params.id);
  await fs.mkdir(pluginDir, { recursive: true });
  await Promise.all([
    fs.writeFile(
      path.join(pluginDir, "package.json"),
      `${JSON.stringify({ name: params.id, type: "module", main: "index.mjs" })}\n`,
    ),
    fs.writeFile(
      path.join(pluginDir, "openclaw.plugin.json"),
      `${JSON.stringify(pluginManifest(params))}\n`,
    ),
    fs.writeFile(path.join(pluginDir, "index.mjs"), pluginModule(params)),
  ]);
}

async function writeImportPlugin(root: string) {
  const pluginDir = path.join(root, IMPORT_PLUGIN);
  const manifest = {
    id: IMPORT_PLUGIN,
    name: "Provider login import fixture",
    enabledByDefault: true,
    providers: ["openai"],
    providerAuthChoices: [
      {
        provider: "openai",
        method: "oauth",
        choiceId: IMPORT_CHOICE,
        choiceLabel: "Fixture OpenAI import",
        appGuidedAuth: "oauth",
      },
    ],
    contracts: { migrationProviders: [IMPORT_MIGRATION] },
    configSchema: { type: "object", additionalProperties: false, properties: {} },
  };
  const module = `
import path from "node:path";
import { updateAuthProfileStoreWithLock } from "openclaw/plugin-sdk/provider-auth";

const probe = globalThis[Symbol.for("openclaw.test.providerLoginImportPromotion")];
const profileId = ${JSON.stringify(IMPORTED_PROFILE)};
const migrationId = ${JSON.stringify(IMPORT_MIGRATION)};
const itemId = "auth:fixture-openai";

export default {
  id: ${JSON.stringify(IMPORT_PLUGIN)},
  register(api) {
    api.registerMigrationProvider({
      id: migrationId,
      label: "Fixture OpenAI migration",
      supportedItemKinds: ["auth"],
      plan: async () => ({
        providerId: migrationId,
        source: "fixture",
        summary: {
          total: 1,
          planned: 1,
          migrated: 0,
          skipped: 0,
          conflicts: 0,
          errors: 0,
          sensitive: 1,
        },
        items: [{
          id: itemId,
          kind: "auth",
          action: "create",
          status: "planned",
          sensitive: true,
          details: {
            profileId,
            provider: "openai",
            credentialKind: "oauth",
          },
        }],
      }),
      apply: async (ctx, plan) => {
        await probe.releasePersistence;
        const agentId = ctx.targetAgentId ?? "main";
        const agentDir =
          ctx.runtime?.agent?.resolveAgentDir(ctx.config, agentId) ??
          path.join(ctx.stateDir, "agents", agentId, "agent");
        const store = await updateAuthProfileStoreWithLock({
          agentDir,
          stateDir: ctx.stateDir,
          updater(current) {
            current.profiles[profileId] = {
              type: "oauth",
              provider: "openai",
              access: "fixture-access",
              refresh: "fixture-refresh",
              expires: Date.now() + 60_000,
            };
            return true;
          },
        });
        if (!plan || !store?.profiles[profileId]) {
          throw new Error("Fixture credential persistence failed.");
        }
        return {
          ...plan,
          items: plan.items.map((item) =>
            item.id === itemId
              ? { ...item, status: "migrated", details: { ...item.details, configUpdated: false } }
              : item,
          ),
        };
      },
    });
    api.registerProvider({
      id: "openai",
      label: "Fixture OpenAI",
      auth: [{
        id: "oauth",
        label: "Fixture OpenAI import",
        kind: "oauth",
        credentialImport: {
          migrationProviderId: migrationId,
          itemId,
          credentialKind: "oauth",
        },
        async run() {
          throw new Error("Interactive auth must not run when import succeeds.");
        },
      }],
    });
  },
};
`;
  await fs.mkdir(pluginDir, { recursive: true });
  await Promise.all([
    fs.writeFile(
      path.join(pluginDir, "package.json"),
      `${JSON.stringify({ name: IMPORT_PLUGIN, type: "module", main: "index.mjs" })}\n`,
    ),
    fs.writeFile(path.join(pluginDir, "openclaw.plugin.json"), `${JSON.stringify(manifest)}\n`),
    fs.writeFile(path.join(pluginDir, "index.mjs"), module),
  ]);
}

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  Reflect.deleteProperty(globalThis, PROBE_KEY);
  Reflect.deleteProperty(globalThis, IMPORT_PROBE_KEY);
});
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("openclaw.setup.auth.start owner binding", () => {
  it(
    "never loads a colliding workspace provider behind a bundled login choice",
    { timeout: 90_000 },
    async () => {
      const envSnapshot = captureEnv([...envKeys]);
      const tempHome = tempDirs.make("openclaw-provider-login-owner-");
      const stateDir = path.join(tempHome, ".openclaw");
      const workspaceDir = path.join(tempHome, "workspace");
      const bundledPluginsDir = path.join(tempHome, "bundled-plugins");
      const workspacePluginsDir = path.join(workspaceDir, ".openclaw", "extensions");
      const configPath = path.join(stateDir, "openclaw.json");
      const token = "provider-login-owner-proof";
      let releaseSelectedAuth!: () => void;
      const selectedAuthRelease = new Promise<void>((resolve) => {
        releaseSelectedAuth = resolve;
      });
      const probe: CollisionProbe = {
        selectedAuthRuns: 0,
        selectedAuthRelease,
        workspaceAuthRuns: 0,
        workspaceModuleLoads: 0,
      };
      (globalThis as Record<PropertyKey, unknown>)[PROBE_KEY] = probe;
      let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
      let otherClient: Awaited<ReturnType<typeof connectGatewayClient>> | undefined;

      try {
        await Promise.all([
          fs.mkdir(stateDir, { recursive: true }),
          fs.mkdir(workspacePluginsDir, { recursive: true }),
          writePlugin(bundledPluginsDir, { id: SELECTED_OWNER, selected: true }),
          writePlugin(workspacePluginsDir, { id: WORKSPACE_OWNER }),
        ]);
        configureGatewayFixtureEnvironment({
          tempHome,
          stateDir,
          configPath,
          token,
          bundledPluginsDir,
        });

        const cfg = {
          plugins: {
            enabled: true,
            allow: [SELECTED_OWNER, WORKSPACE_OWNER],
            entries: {
              [SELECTED_OWNER]: { enabled: true },
              [WORKSPACE_OWNER]: { enabled: true },
            },
          },
          agents: {
            defaults: { workspace: workspaceDir, skipBootstrap: true },
            list: [{ id: "main", default: true }],
          },
          gateway: { auth: { mode: "token" as const, token } },
        };
        await fs.writeFile(configPath, `${JSON.stringify(cfg, null, 2)}\n`);
        gateway = await startGatewayWithClient({
          cfg,
          configPath,
          token,
          clientDisplayName: "provider-login-owner-proof",
        });
        const started = await gateway.client.request<WizardStartResult>(
          "openclaw.setup.auth.start",
          {
            sessionId: "owner-proof-session",
            agentId: "main",
            authChoice: "collision-oauth",
          },
        );
        expect(started).toMatchObject({ done: false, status: "running" });
        const deviceCode = await gateway.client.request<WizardNextResult>("wizard.next", {
          sessionId: started.sessionId,
        });
        expect(deviceCode.step).toMatchObject({
          type: "note",
          deviceCode: { code: "SELECTED-CODE" },
        });
        expect(probe).toMatchObject({
          selectedAuthRuns: 1,
          workspaceAuthRuns: 0,
          workspaceModuleLoads: 0,
        });
        otherClient = await connectGatewayClient({
          url: `ws://127.0.0.1:${gateway.port}`,
          token,
          clientDisplayName: "provider-login-other-operator",
          scopes: ["operator.admin"],
        });
        for (const method of ["wizard.status", "wizard.next", "wizard.cancel"] as const) {
          await expect(
            otherClient.request(method, { sessionId: started.sessionId }),
          ).rejects.toMatchObject({
            code: "INVALID_REQUEST",
            details: { code: "WIZARD_NOT_FOUND" },
          });
        }
        expect(
          Object.keys(
            loadAuthProfileStoreWithoutExternalProfiles(resolveAgentDir(cfg, "main")).profiles,
          ).filter((profileId) => profileId.startsWith(`${COLLISION_PROVIDER}:`)),
        ).toEqual([]);
        const liveConfig = await gateway.client.request<{ hash: string }>("config.get", {});
        await gateway.client.request("config.patch", {
          raw: JSON.stringify({ messages: { responsePrefix: "concurrent-edit" } }),
          baseHash: liveConfig.hash,
        });
        releaseSelectedAuth();
        const completed = await gateway.client.request<WizardNextResult>("wizard.next", {
          sessionId: started.sessionId,
          answer: { stepId: deviceCode.step?.id ?? "", value: null },
        });
        expect(completed).toMatchObject({ done: true, status: "done" });

        const store = loadAuthProfileStoreWithoutExternalProfiles(resolveAgentDir(cfg, "main"));
        expect(probe).toMatchObject({
          selectedAuthRuns: 1,
          workspaceAuthRuns: 0,
        });
        expect(Object.keys(store.profiles)).toContain("collision-provider:selected");
        expect(Object.keys(store.profiles)).not.toContain("collision-provider:workspace");
        const configAfterLogin = JSON.parse(await fs.readFile(configPath, "utf8"));
        expect(configAfterLogin.agents?.defaults?.model).toBeUndefined();
        expect(configAfterLogin.agents?.defaults?.workspace).toBe(workspaceDir);
        expect(configAfterLogin.messages?.responsePrefix).toBe("concurrent-edit");
      } finally {
        if (otherClient) {
          await disconnectGatewayClient(otherClient);
        }
        if (gateway) {
          await disconnectGatewayClient(gateway.client);
          await gateway.server.close({ reason: "provider login owner proof complete" });
        }
        envSnapshot.restore();
      }
    },
  );
});

describe("openclaw.setup.auth.start imported profile promotion", () => {
  it(
    "promotes an imported profile ahead of the configured OpenAI profile",
    { timeout: 90_000 },
    async () => {
      const envSnapshot = captureEnv([...envKeys]);
      const tempHome = tempDirs.make("openclaw-provider-login-import-");
      const stateDir = path.join(tempHome, ".openclaw");
      const workspaceDir = path.join(tempHome, "workspace");
      const bundledPluginsDir = path.join(tempHome, "bundled-plugins");
      const configPath = path.join(stateDir, "openclaw.json");
      const token = "provider-login-import-proof";
      let releasePersistence!: () => void;
      const probe: ImportProbe = {
        releasePersistence: new Promise<void>((resolve) => {
          releasePersistence = resolve;
        }),
      };
      (globalThis as Record<PropertyKey, unknown>)[IMPORT_PROBE_KEY] = probe;
      let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
      let otherClient: Awaited<ReturnType<typeof connectGatewayClient>> | undefined;

      try {
        await Promise.all([
          fs.mkdir(stateDir, { recursive: true }),
          fs.mkdir(workspaceDir, { recursive: true }),
          writeImportPlugin(bundledPluginsDir),
        ]);
        configureGatewayFixtureEnvironment({
          tempHome,
          stateDir,
          configPath,
          token,
          bundledPluginsDir,
        });

        const cfg = {
          auth: {
            profiles: {
              [CONFIGURED_PROFILE]: { provider: "openai", mode: "oauth" as const },
            },
            order: { openai: [CONFIGURED_PROFILE] },
          },
          plugins: {
            enabled: true,
            allow: [IMPORT_PLUGIN],
            entries: { [IMPORT_PLUGIN]: { enabled: true } },
          },
          agents: {
            defaults: { workspace: workspaceDir, skipBootstrap: true },
            list: [{ id: "main", default: true }],
          },
          gateway: { auth: { mode: "token" as const, token } },
        };
        await fs.writeFile(configPath, `${JSON.stringify(cfg, null, 2)}\n`);
        gateway = await startGatewayWithClient({
          cfg,
          configPath,
          token,
          clientDisplayName: "provider-login-import-proof",
        });

        const started = await gateway.client.request<WizardStartResult>(
          "openclaw.setup.auth.start",
          {
            sessionId: "import-promotion-session",
            agentId: "main",
            authChoice: IMPORT_CHOICE,
          },
        );
        expect(started).toMatchObject({ done: false, status: "running" });
        otherClient = await connectGatewayClient({
          url: `ws://127.0.0.1:${gateway.port}`,
          token,
          clientDisplayName: "provider-login-import-other-operator",
          scopes: ["operator.admin"],
        });
        for (const method of ["wizard.status", "wizard.next", "wizard.cancel"] as const) {
          await expect(
            otherClient.request(method, { sessionId: started.sessionId }),
          ).rejects.toMatchObject({
            code: "INVALID_REQUEST",
            details: { code: "WIZARD_NOT_FOUND" },
          });
        }
        expect(
          loadAuthProfileStoreWithoutExternalProfiles(resolveAgentDir(cfg, "main")).profiles,
        ).not.toHaveProperty(IMPORTED_PROFILE);
        releasePersistence();
        await vi.waitFor(
          async () => {
            const status = await gateway?.client.request<WizardStatusResult>("wizard.status", {
              sessionId: started.sessionId,
            });
            expect(status).toEqual({ status: "done" });
          },
          { timeout: 20_000 },
        );

        const store = loadAuthProfileStoreWithoutExternalProfiles(resolveAgentDir(cfg, "main"));
        expect(store.order?.openai).toEqual([IMPORTED_PROFILE, CONFIGURED_PROFILE]);
        expect(store.profiles[IMPORTED_PROFILE]).toMatchObject({
          type: "oauth",
          provider: "openai",
        });
        const authStatus = await gateway.client.request<{
          providers: Array<{
            provider: string;
            profiles: Array<{ profileId: string; type: string }>;
          }>;
        }>("models.authStatus", { agentId: "main", refresh: true });
        expect(
          authStatus.providers.find((provider) => provider.provider === "openai")?.profiles,
        ).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ profileId: IMPORTED_PROFILE, type: "oauth" }),
          ]),
        );
      } finally {
        releasePersistence();
        if (otherClient) {
          await disconnectGatewayClient(otherClient);
        }
        if (gateway) {
          await disconnectGatewayClient(gateway.client);
          await gateway.server.close({ reason: "provider login import proof complete" });
        }
        envSnapshot.restore();
      }
    },
  );
});

describe("models.authLogout saved API-key profile", () => {
  it(
    "removes the credential and makes its configured model unavailable",
    { timeout: 90_000 },
    async () => {
      const envSnapshot = captureEnv([...envKeys]);
      const tempHome = tempDirs.make("openclaw-provider-api-key-logout-");
      const stateDir = path.join(tempHome, ".openclaw");
      const workspaceDir = path.join(tempHome, "workspace");
      const bundledPluginsDir = path.join(tempHome, "bundled-plugins");
      const configPath = path.join(stateDir, "openclaw.json");
      const token = "provider-api-key-logout-proof";
      const profileId = "groq:default";
      let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;

      try {
        await Promise.all([
          fs.mkdir(stateDir, { recursive: true }),
          fs.mkdir(workspaceDir, { recursive: true }),
          fs.mkdir(bundledPluginsDir, { recursive: true }),
        ]);
        configureGatewayFixtureEnvironment({
          tempHome,
          stateDir,
          configPath,
          token,
          bundledPluginsDir,
        });
        const cfg = {
          models: {
            providers: {
              groq: {
                baseUrl: "https://api.groq.com/openai/v1",
                api: "openai-completions" as const,
                models: [
                  {
                    id: "llama-3.3-70b",
                    name: "Llama 3.3 70B",
                    reasoning: false,
                    input: ["text"],
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                    maxTokens: 8192,
                  },
                ],
              },
            },
          },
          agents: {
            defaults: { workspace: workspaceDir, skipBootstrap: true },
            list: [{ id: "main", default: true }],
          },
          gateway: { auth: { mode: "token" as const, token } },
        };
        await fs.writeFile(configPath, `${JSON.stringify(cfg, null, 2)}\n`);
        upsertAuthProfile({
          agentDir: resolveAgentDir(cfg, "main"),
          profileId,
          credential: {
            type: "api_key",
            provider: "groq",
            key: "fixture-key",
          },
        });
        gateway = await startGatewayWithClient({
          cfg,
          configPath,
          token,
          clientDisplayName: "provider-api-key-logout-proof",
        });

        const beforeStatus = await gateway.client.request<{
          providers: Array<{
            provider: string;
            profiles: Array<{ profileId: string; logoutSupported?: boolean }>;
          }>;
        }>("models.authStatus", { agentId: "main", refresh: true });
        expect(
          beforeStatus.providers.find((provider) => provider.provider === "groq")?.profiles,
        ).toEqual(
          expect.arrayContaining([expect.objectContaining({ profileId, logoutSupported: true })]),
        );
        const beforeModels = await gateway.client.request<{
          models: Array<{ provider: string; id: string; available: boolean }>;
        }>("models.list", { agentId: "main", view: "configured" });
        expect(
          beforeModels.models.find(
            (model) => model.provider === "groq" && model.id === "llama-3.3-70b",
          )?.available,
        ).toBe(true);

        await gateway.client.request("models.authLogout", {
          agentId: "main",
          provider: "groq",
          profileIds: [profileId],
        });

        const afterStatus = await gateway.client.request<{
          providers: Array<{ provider: string; profiles: Array<{ profileId: string }> }>;
        }>("models.authStatus", { agentId: "main", refresh: true });
        expect(
          afterStatus.providers
            .find((provider) => provider.provider === "groq")
            ?.profiles.some((profile) => profile.profileId === profileId),
        ).not.toBe(true);
        const afterModels = await gateway.client.request<{
          models: Array<{ provider: string; id: string; available: boolean }>;
        }>("models.list", { agentId: "main", refresh: true, view: "configured" });
        expect(
          afterModels.models.find(
            (model) => model.provider === "groq" && model.id === "llama-3.3-70b",
          )?.available,
        ).toBe(false);
      } finally {
        if (gateway) {
          await disconnectGatewayClient(gateway.client);
          await gateway.server.close({ reason: "provider API-key logout proof complete" });
        }
        envSnapshot.restore();
      }
    },
  );
});
