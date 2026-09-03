// Real product proof: served Control UI -> Gateway -> bundled provider -> agent auth store.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { loadAuthProfileStoreWithoutExternalProfiles } from "../../../src/agents/auth-profiles/store.ts";
import type { GatewayServer } from "../../../src/gateway/server-public.ts";
import { getActiveGatewayRootWorkCount } from "../../../src/process/gateway-work-admission.ts";
import { createOpenClawTestState } from "../../../src/test-utils/openclaw-test-state.ts";
import { getFreePort } from "../../../src/test-utils/ports.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const DEFAULT_MODEL = "openai/gpt-5.6-luna";
const syntheticApiCredential = ["sk", "test", "control", "ui", "import"].join("-");
const captureProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";

const suite = createControlUiE2eSuite({
  name: "Control UI provider login with a real Gateway",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not available at ${executablePath}`,
});

suite.define(() => {
  it(
    "imports an existing CLI key without changing the default model",
    { timeout: 240_000 },
    async () => {
      const port = await getFreePort();
      const state = await createOpenClawTestState({
        label: "control-ui-provider-login",
        layout: "home",
        env: {
          CODEX_HOME: "",
          OPENCLAW_BUNDLED_PLUGINS_DIR: path.resolve("extensions"),
          OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
          OPENCLAW_SKIP_CANVAS_HOST: "1",
          OPENCLAW_SKIP_CHANNELS: "1",
          OPENCLAW_SKIP_CRON: "1",
          OPENCLAW_SKIP_GMAIL_WATCHER: "1",
          OPENCLAW_SKIP_PROVIDERS: "0",
          OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1",
          VITEST: "1",
        },
      });
      const codexHome = path.join(state.home, ".codex");
      const httpUrl = `http://127.0.0.1:${port}`;
      let gateway: GatewayServer | undefined;
      try {
        await mkdir(codexHome, { recursive: true });
        await writeFile(
          path.join(codexHome, "auth.json"),
          `${JSON.stringify({
            auth_mode: "api_key",
            OPENAI_API_KEY: syntheticApiCredential,
          })}\n`,
          { mode: 0o600 },
        );
        await state.writeConfig({
          agents: {
            defaults: {
              model: { primary: DEFAULT_MODEL },
              modelPolicy: { allow: [DEFAULT_MODEL] },
              workspace: state.workspaceDir,
            },
            entries: { main: { workspace: state.workspaceDir } },
          },
          gateway: {
            auth: { mode: "none" },
            controlUi: {
              allowedOrigins: [httpUrl],
              enabled: true,
              root: path.resolve("dist/control-ui"),
            },
            port,
          },
          plugins: {
            allow: ["openai"],
            enabled: true,
            entries: {
              codex: { enabled: false },
              openai: { enabled: true },
            },
          },
        });
        state.applyEnv();
        const { startGatewayServer } = await import("../../../src/gateway/server.js");
        gateway = await startGatewayServer(port, {
          auth: { mode: "none" },
          bind: "loopback",
          controlUiEnabled: true,
          sidecarStartup: "defer",
        });

        const artifactDir = captureProof ? suite.artifactDir : undefined;
        await suite.withPage(
          {
            locale: "en-US",
            serviceWorkers: "block",
            viewport: { height: 900, width: 1440 },
            ...(artifactDir
              ? { recordVideo: { dir: artifactDir, size: { height: 900, width: 1440 } } }
              : {}),
          },
          async ({ page }) => {
            const response = await page.goto(`${httpUrl}/settings/model-providers`);
            expect(response?.status()).toBe(200);

            const signIn = page.getByRole("button", { name: "Sign in with OpenAI API Key" });
            await signIn.waitFor();
            await signIn.click();
            // Source mode lazily transforms the migration owner before the real Gateway finishes.
            await page
              .getByRole("status")
              .filter({ hasText: "Signed in." })
              .waitFor({ timeout: 120_000 });
            expect(await page.getByLabel("Enter OpenAI API key").count()).toBe(0);
            await expect
              .poll(() => {
                const store = loadAuthProfileStoreWithoutExternalProfiles(state.agentDir("main"));
                return Object.entries(store.profiles).filter(
                  ([, profile]) => profile.provider === "openai",
                );
              })
              .toEqual([
                [
                  "openai:codex-import",
                  expect.objectContaining({
                    type: "api_key",
                    provider: "openai",
                    key: syntheticApiCredential,
                  }),
                ],
              ]);
            expect(JSON.parse(await readFile(state.configPath, "utf8"))).toMatchObject({
              agents: {
                defaults: {
                  model: { primary: DEFAULT_MODEL },
                  modelPolicy: { allow: [DEFAULT_MODEL, "openai/*"] },
                },
              },
            });

            if (artifactDir) {
              await page.screenshot({
                animations: "disabled",
                fullPage: true,
                path: path.join(artifactDir, "signed-in.png"),
              });
              await writeFile(
                path.join(artifactDir, "proof.json"),
                `${JSON.stringify(
                  {
                    authChoice: "openai-api-key",
                    credentialPersisted: true,
                    defaultModel: DEFAULT_MODEL,
                    defaultModelUnchanged: true,
                    gateway: "real",
                    gatewayServedControlUi: true,
                    providerModelsEnabled: true,
                    provider: "openai",
                    secureInputShown: false,
                  },
                  null,
                  2,
                )}\n`,
              );
            }
          },
        );
      } finally {
        try {
          await gateway?.close({ reason: "provider login real-Gateway proof cleanup" });
          await expect.poll(() => getActiveGatewayRootWorkCount(), { timeout: 60_000 }).toBe(0);
        } finally {
          await state.cleanup();
        }
      }
    },
  );
});
