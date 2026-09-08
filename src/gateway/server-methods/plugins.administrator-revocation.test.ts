import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it, vi } from "vitest";
import {
  channelAdministratorTestGrant,
  createTestChannelAdministratorSource,
} from "../../../test/helpers/channel-administrator-source.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createTestAdmittedRunContext } from "../../agents/admitted-run-context.test-support.js";
import { installDiscordRegistryHooks } from "../../auto-reply/test-helpers/command-auth-registry-fixture.js";
import * as backupRotation from "../../config/backup-rotation.js";
import { getRuntimeConfig, setRuntimeConfigSnapshot } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  claimAgentRunDelegatedAuthority,
  resetAgentRunRegistryForTest,
} from "../../infra/agent-run-registry.js";
import { withPluginLifecycleLease } from "../../plugins/plugin-lifecycle-lease.js";
import { clearPluginMetadataLifecycleCaches } from "../../plugins/plugin-metadata-lifecycle.js";
import { createColdPluginFixture } from "../../plugins/test-helpers/cold-plugin-fixtures.js";
import * as leaseStore from "../../state/openclaw-state-lease-store.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  createChannelAdministratorAuthority,
  mintChannelAdministratorGrant,
} from "../channel-administrator-authority.js";
import { handleGatewayRequest } from "../server-methods.js";
import type { GatewayClient, GatewayRequestContext } from "./types.js";

// Only the unrelated external catalog is substituted. The router, plugin
// metadata, SQLite lifecycle lease, config transaction and file rename are real.
vi.mock("../../plugins/official-external-plugin-catalog.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/official-external-plugin-catalog.js")>()),
  loadConfiguredHostedOfficialExternalPluginCatalogEntries: async () => ({
    source: "hosted",
    entries: [],
  }),
}));

installDiscordRegistryHooks();

afterEach(() => {
  vi.restoreAllMocks();
  clearPluginMetadataLifecycleCaches();
  resetAgentRunRegistryForTest();
});

it.each(["active", "lease wait", "publication prerequisite"] as const)(
  "fences administrator plugin policy writes: %s",
  async (scenario) => {
    await withOpenClawTestState(
      {
        label: "administrator-plugin-policy",
        applyEnv: true,
        env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" },
      },
      async (state) => {
        const pluginId = "administrator-proof";
        const pluginRoot = state.path("fixture-plugin");
        await fs.mkdir(pluginRoot, { recursive: true });
        const plugin = createColdPluginFixture({
          rootDir: pluginRoot,
          pluginId,
          manifest: { providers: [], channels: [], channelConfigs: {}, providerAuthChoices: [] },
        });
        const config: OpenClawConfig = {
          commands: {
            ownerAllowFrom: [`discord:${channelAdministratorTestGrant.senderId}`],
            channelAdministrators: [channelAdministratorTestGrant],
          },
          plugins: {
            allow: [pluginId],
            load: { paths: [pluginRoot] },
            entries: { [pluginId]: { enabled: true } },
          },
        };
        await state.writeConfig(config);
        setRuntimeConfigSnapshot(config);
        const original = await fs.readFile(state.configPath, "utf8");
        const { operationalRunInstance } = createTestAdmittedRunContext("plugin-policy-proof");
        const authority = claimAgentRunDelegatedAuthority(operationalRunInstance);
        const source = await createTestChannelAdministratorSource(config);
        const capability = createChannelAdministratorAuthority(
          operationalRunInstance.runId,
          source.lifetime.signal,
          expectDefined(source.assertPolicyCurrent, "authenticated owner policy admission"),
        );
        const client = {
          connId: "administrator-plugin-policy",
          connect: {
            role: "operator",
            scopes: ["operator.read"],
            minProtocol: 1,
            maxProtocol: 1,
            client: { id: "test", version: "1", platform: "test", mode: "test" },
          },
          internal: {
            agentRuntimeIdentity: {
              kind: "agentRuntime",
              agentId: "main",
              sessionKey: "agent:main:discord:channel:234567890123456789",
              operationalRunInstance,
              delegatedAuthority: { kind: "local", ...authority },
              turnSourceChannel: "discord",
              turnSourceAccountId: "operations",
              channelAdministratorGrant: mintChannelAdministratorGrant(
                capability,
                authority,
                "plugins.setEnabled",
              ),
            },
          },
        } as GatewayClient;
        const paused = createDeferred();
        const resume = createDeferred();
        let blocker: Promise<void> | undefined;
        if (scenario === "lease wait") {
          const entered = createDeferred();
          blocker = withPluginLifecycleLease({ env: process.env }, async () => {
            entered.resolve();
            await resume.promise;
          });
          await entered.promise;
          const acquire = leaseStore.acquireOpenClawStateLeaseInTransaction;
          vi.spyOn(leaseStore, "acquireOpenClawStateLeaseInTransaction").mockImplementation(
            (...args) => {
              const result = acquire(...args);
              if (result === undefined) {
                paused.resolve();
              }
              return result;
            },
          );
        }
        if (scenario === "publication prerequisite") {
          const maintain = backupRotation.maintainConfigBackups;
          vi.spyOn(backupRotation, "maintainConfigBackups").mockImplementation(async (...args) => {
            await maintain(...args);
            paused.resolve();
            await resume.promise;
          });
        }
        const respond = vi.fn();
        const request = handleGatewayRequest({
          req: {
            type: "req",
            id: "plugin-policy-change",
            method: "plugins.setEnabled",
            params: { pluginId, enabled: false },
          },
          client,
          respond,
          isWebchatConnect: () => false,
          context: {
            getRuntimeConfig,
            logGateway: { info: vi.fn(), warn: vi.fn() },
          } as unknown as GatewayRequestContext,
        });
        try {
          if (scenario !== "active") {
            // Race completion against the actual blocked phase; an early handler
            // error is a failed proof, not a timeout or apparent revocation success.
            await Promise.race([
              paused.promise,
              request.then(() => {
                throw new Error("request finished before its controlled revocation boundary");
              }),
            ]);
            setRuntimeConfigSnapshot({
              ...config,
              commands: { ...config.commands, channelAdministrators: [] },
            });
          }
        } finally {
          resume.resolve();
          await blocker;
          await request;
        }
        if (scenario === "active") {
          expect(respond).toHaveBeenCalledWith(
            true,
            expect.objectContaining({ ok: true }),
            undefined,
          );
          const persisted = JSON.parse(await fs.readFile(state.configPath, "utf8"));
          expect(persisted.plugins.entries[pluginId].enabled).toBe(false);
        } else {
          expect(respond).toHaveBeenCalledWith(
            false,
            undefined,
            expect.objectContaining({
              message: expect.stringContaining("grant or command ownership was revoked"),
            }),
          );
          expect(await fs.readFile(state.configPath, "utf8")).toBe(original);
        }
        await expect(fs.stat(path.resolve(plugin.runtimeMarker))).rejects.toMatchObject({
          code: "ENOENT",
        });
      },
    );
  },
);
