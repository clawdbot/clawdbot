// Installed-plugin setup proof: real UI/Gateway/auth persistence, no model inference.
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { expect, it } from "vitest";
import { findPersistedAuthProfileCredential } from "../../../src/agents/auth-profiles.ts";
import { reloadSharedAuthStoreOwnership } from "../../../src/agents/auth-profiles/path-resolve.ts";
import { readConfigFileSnapshot } from "../../../src/config/config.ts";
import type { OpenClawConfig } from "../../../src/config/types.openclaw.ts";
import {
  loadInstalledPluginIndexInstallRecords,
  writePersistedInstalledPluginIndexInstallRecords,
} from "../../../src/plugins/installed-plugin-index-records.ts";
import { createSqliteHostedOfficialExternalPluginCatalogSnapshotStore } from "../../../src/plugins/official-external-plugin-catalog-snapshot-store.ts";
import { createOpenClawTestInstance } from "../../../test/helpers/openclaw-test-instance.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI provider setup with a real Gateway",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not available at ${executablePath}`,
});
const pluginId = "ui-provider-setup-fixture";
const providerId = "ui-catalog-fixture";
const choiceId = "provider/ui-fixture:key@v1";
const profileId = `${providerId}:default`;
const originalModel = "existing-fixture/preserved-model";
const fixtureModel = `${providerId}/demo-model`;
const syntheticKey = "synthetic-ui-provider-key";
const requireRecord = createRequireRecord("record", "expected-object-value");

suite.define(() => {
  it("configures an installed provider through its consent and key wizard without replacing the primary", async () => {
    const gateway = await createOpenClawTestInstance({
      name: "control-ui-provider-setup",
      env: {
        CODEX_HOME: undefined,
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
        OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
        OPENCLAW_NO_RESPAWN: "1",
      },
    });
    const state = gateway.state;
    let inferenceRequests = 0;
    const inference = createServer((_request, response) => {
      inferenceRequests += 1;
      response.writeHead(503, { "content-type": "application/json" });
      response.end('{"error":"Configuration-only setup must not invoke inference"}');
    });
    try {
      const codexHome = path.join(state.home, ".codex");
      await mkdir(codexHome, { recursive: true });
      // Native-app detection can bypass PATH; keep both CLI auth readers in the test home.
      state.env.CODEX_HOME = codexHome;
      state.envVars.CODEX_HOME = codexHome;
      gateway.env.CODEX_HOME = codexHome;
      state.applyEnv();
      await new Promise<void>((resolve, reject) => {
        inference.once("error", reject);
        inference.listen(0, "127.0.0.1", resolve);
      });
      const address = inference.address();
      if (!address || typeof address === "string") {
        throw new Error("Synthetic inference listener has no TCP address");
      }
      const baseUrl = `http://127.0.0.1:${address.port}/v1`;
      const pluginRoot = state.statePath("extensions", pluginId);
      await mkdir(pluginRoot, { recursive: true });
      await writeFile(
        path.join(pluginRoot, "package.json"),
        JSON.stringify({
          name: "@openclaw/ui-provider-setup-fixture",
          version: "1.0.0",
          openclaw: { extensions: ["./index.cjs"] },
        }),
      );
      await writeFile(
        path.join(pluginRoot, "openclaw.plugin.json"),
        JSON.stringify({
          id: pluginId,
          name: "Catalog Fixture",
          providers: [providerId],
          providerAuthChoices: [
            {
              provider: providerId,
              method: "project-key",
              choiceId,
              choiceLabel: "Project API key",
              groupId: providerId,
              groupLabel: "Catalog Fixture",
              appGuidedSecret: true,
              onboardingScopes: ["text-inference"],
            },
          ],
          configSchema: { type: "object", additionalProperties: false, properties: {} },
        }),
      );
      await writeFile(
        path.join(pluginRoot, "index.cjs"),
        `module.exports = {
  id: ${JSON.stringify(pluginId)},
  register(api) {
    api.registerProvider({
      id: ${JSON.stringify(providerId)},
      label: "Catalog Fixture",
      auth: [{
        id: "project-key",
        label: "Project API key",
        kind: "api_key",
        async run(ctx) {
          const key = await ctx.prompter.text({
            message: "Catalog fixture project key",
            sensitive: true,
            validate: (value) => value.trim() ? undefined : "A key is required.",
          });
          return {
            profiles: [{
              profileId: ${JSON.stringify(profileId)},
              credential: { type: "api_key", provider: ${JSON.stringify(providerId)}, key },
            }],
            defaultModel: ${JSON.stringify(fixtureModel)},
            configPatch: {
              agents: { defaults: { model: ${JSON.stringify(fixtureModel)} } },
              models: { providers: { ${JSON.stringify(providerId)}: {
                baseUrl: ${JSON.stringify(baseUrl)},
                api: "openai-completions",
                models: [{
                  id: "demo-model", name: "Demo model", reasoning: false, input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 4096, maxTokens: 128,
                }],
              } } },
            },
          };
        },
      }],
    });
  },
};\n`,
      );
      const port = gateway.port;
      const config: OpenClawConfig = {
        agents: { defaults: { workspace: state.workspaceDir, model: originalModel } },
        models: { catalogRefresh: { enabled: false } },
        plugins: {
          allow: [pluginId],
          load: { paths: [pluginRoot] },
          entries: { [pluginId]: { enabled: false } },
        },
        gateway: {
          auth: { mode: "none" },
          controlUi: {
            allowedOrigins: [new URL(suite.server.baseUrl).origin],
            enabled: false,
          },
          port,
        },
      };
      await state.writeConfig(config);
      // Seed an existing managed package, not acceptance; the real wizard owns consent.
      await writePersistedInstalledPluginIndexInstallRecords(
        {
          [pluginId]: {
            source: "path",
            sourcePath: pluginRoot,
            installPath: pluginRoot,
            version: "1.0.0",
          },
        },
        { config, env: state.env, workspaceDir: state.workspaceDir },
      );
      expect(findPersistedAuthProfileCredential({ agentDir: state.agentDir(), profileId })).toBe(
        undefined,
      );
      // The CLI owns real config-triggered restarts; the helper waits for /readyz.
      await gateway.startGateway();
      const recordVisuals = process.env.OPENCLAW_UI_E2E_RECORD === "1";
      const artifactDir = recordVisuals ? suite.artifactDir : undefined;
      await suite.withPage(
        {
          locale: "en-US",
          serviceWorkers: "block",
          viewport: { height: 1200, width: 1440 },
          ...(artifactDir
            ? { recordVideo: { dir: artifactDir, size: { height: 1200, width: 1440 } } }
            : {}),
        },
        async ({ page }) => {
          const methods: string[] = [];
          const bootIds = new Set<string>();
          const observedRequests = new Map<string, "connect" | "models.authStatus">();
          let authStatus:
            | {
                ok: boolean;
                unavailableCode: unknown;
                providerStatus: unknown;
                hasApiKeyProfile: boolean;
              }
            | undefined;
          page.on("websocket", (socket) => {
            socket.on("framesent", ({ payload }) => {
              const frame = requireRecord(JSON.parse(payload.toString()));
              // Observe only method names. Credential answers and response bodies stay private.
              if (frame.type === "req" && typeof frame.method === "string") {
                methods.push(frame.method);
                if (
                  (frame.method === "connect" || frame.method === "models.authStatus") &&
                  typeof frame.id === "string"
                ) {
                  observedRequests.set(frame.id, frame.method);
                }
              }
            });
            socket.on("framereceived", ({ payload }) => {
              const frame = requireRecord(JSON.parse(payload.toString()));
              if (frame.type !== "res" || typeof frame.id !== "string") {
                return;
              }
              const method = observedRequests.get(frame.id);
              if (!method) {
                return;
              }
              observedRequests.delete(frame.id);
              const result = requireRecord(frame.payload ?? {});
              if (method === "connect") {
                if (result.type === "hello-ok") {
                  const server = requireRecord(result.server);
                  if (typeof server.bootId === "string") {
                    bootIds.add(server.bootId);
                  }
                }
                return;
              }
              const unavailable = result.unavailable
                ? requireRecord(result.unavailable)
                : undefined;
              const provider = Array.isArray(result.providers)
                ? result.providers.map(requireRecord).find((entry) => entry.provider === providerId)
                : undefined;
              const profiles = provider?.profiles;
              // Project status facts only; never retain credential or usage/account payloads.
              authStatus = {
                ok: frame.ok === true,
                unavailableCode: unavailable?.code ?? null,
                providerStatus: provider?.status ?? null,
                hasApiKeyProfile:
                  Array.isArray(profiles) &&
                  profiles.some((profile) => requireRecord(profile).type === "api_key"),
              };
            });
          });
          const capture = async (name: string) => {
            if (artifactDir) {
              await page.screenshot({
                animations: "disabled",
                fullPage: true,
                path: path.join(artifactDir, name),
              });
              // The state was asserted above; this hold only makes recorded video readable.
              await page.waitForTimeout(500);
            }
          };
          const url = new URL("settings/model-providers", suite.server.baseUrl);
          url.searchParams.set("gatewayUrl", `ws://127.0.0.1:${port}`);
          await page.goto(url.toString());
          const confirmation = page.locator("openclaw-gateway-url-confirmation");
          await confirmation.getByRole("button", { name: "Confirm", exact: true }).click();
          const add = page.locator(".settings-section", {
            has: page.getByRole("heading", { name: "Add provider", exact: true }),
          });
          await add.getByRole("button", { name: "Add provider", exact: true }).click();
          await add.getByLabel("Provider").selectOption(choiceId);
          expect(await add.locator('input[type="password"]').count()).toBe(0);
          await add.scrollIntoViewIfNeeded();
          await capture("01-installed-provider-choice.png");
          await add.getByRole("button", { name: "Configure provider" }).click();
          const wizard = page.locator("openclaw-modal-dialog");
          await wizard.getByRole("heading", { name: "Plugin capabilities", exact: true }).waitFor();
          await expect
            .poll(() =>
              wizard.locator("dialog").evaluate((dialog) => getComputedStyle(dialog).opacity),
            )
            .toBe("1");
          expect(await wizard.locator('input[type="password"]').count()).toBe(0);
          await capture("02-real-capability-review.png");
          await wizard.getByRole("button", { name: "Continue", exact: true }).click();
          await wizard.getByText(`Accept these capabilities for "${pluginId}"?`).waitFor();
          await capture("03-real-capability-consent.png");
          await wizard.getByRole("button", { name: "Continue", exact: true }).click();
          const keyInput = wizard.getByLabel("Catalog fixture project key");
          await keyInput.fill(syntheticKey);
          expect(await keyInput.getAttribute("type")).toBe("password");
          await capture("04-provider-owned-masked-key.png");
          await wizard.getByRole("button", { name: "Submit", exact: true }).click();
          await add.getByText("Provider Catalog Fixture configured.", { exact: true }).waitFor();
          await expect
            .poll(() => authStatus)
            .toEqual({
              ok: true,
              unavailableCode: null,
              providerStatus: "static",
              hasApiKeyProfile: true,
            });
          const card = page.locator(`[data-provider-id="${providerId}"]`);
          await card.getByText("Credentials configured", { exact: true }).waitFor();
          await card.getByText("API key profiles: 1", { exact: true }).waitFor();
          expect(await card.getByText("Not configured", { exact: true }).count()).toBe(0);
          expect(await page.getByText("Model authentication status is unavailable.").count()).toBe(
            0,
          );
          expect(bootIds.size).toBeGreaterThan(1);
          const saved = await readConfigFileSnapshot();
          expect(saved.valid).toBe(true);
          expect(saved.sourceConfig.agents?.defaults?.model).toBe(originalModel);
          expect(saved.sourceConfig.plugins?.entries?.[pluginId]?.enabled).toBe(true);
          // The CLI may relocate a fresh auth store; refresh only this parent reader's owner.
          reloadSharedAuthStoreOwnership(state.env);
          const credential = findPersistedAuthProfileCredential({
            agentDir: state.agentDir(),
            profileId,
          });
          expect(
            credential?.type === "api_key" &&
              credential.provider === providerId &&
              credential.key === syntheticKey,
          ).toBe(true);
          const records = await loadInstalledPluginIndexInstallRecords({ env: state.env });
          expect(records[pluginId]?.acceptedSurface?.providers).toContain(providerId);
          expect(inferenceRequests).toBe(0);
          expect(
            methods.filter((method) => method === "openclaw.setup.prepare.start"),
          ).toHaveLength(1);
          expect(methods).not.toContain("openclaw.setup.activate.start");
          expect(methods).not.toContain("openclaw.setup.auth.start");
          expect(methods).not.toContain("config.patch");
          expect(await page.getByRole("heading", { name: "Connection verified" }).count()).toBe(0);
          await add.scrollIntoViewIfNeeded();
          await capture("05-provider-configured-primary-preserved.png");
          if (artifactDir) {
            const feed = await createSqliteHostedOfficialExternalPluginCatalogSnapshotStore({
              env: state.env,
            }).read("https://clawhub.ai/v1/feeds/plugins");
            await writeFile(
              path.join(artifactDir, "proof.json"),
              JSON.stringify(
                {
                  scope: "real-cli-gateway-installed-plugin-config-only-setup",
                  pluginId,
                  providerId,
                  primaryPreserved: true,
                  persistedCredentialMatchesSyntheticInput: true,
                  capabilityConsentPersisted: true,
                  inferenceRequests,
                  authStatus,
                  gatewayBootIds: [...bootIds],
                  gatewayProcessId: gateway.child?.pid,
                  gatewayEntrypoint: await gateway.entrypoint(),
                  methods,
                  feedSnapshot: feed ? { metadata: feed.metadata, savedAt: feed.savedAt } : null,
                },
                null,
                2,
              ) + "\n",
            );
          }
        },
      );
    } catch (error) {
      if (process.env.OPENCLAW_UI_E2E_RECORD === "1") {
        await writeFile(
          path.join(suite.artifactDir, "gateway.log"),
          gateway
            .logs()
            .replaceAll(syntheticKey, "[REDACTED]")
            .replaceAll(gateway.gatewayToken, "[REDACTED]")
            .replaceAll(gateway.hookToken, "[REDACTED]"),
        );
      }
      throw error;
    } finally {
      try {
        await gateway.stopGateway();
      } finally {
        try {
          if (inference.listening) {
            await new Promise<void>((resolve, reject) => {
              inference.close((error) => (error ? reject(error) : resolve()));
            });
          }
        } finally {
          await gateway.cleanup();
        }
      }
    }
  });
});
