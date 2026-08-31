// Browser proof that model setup reloads after a same-client Gateway reconnect.
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { Compile } from "typebox/compile";
import { expect, it } from "vitest";
import { ConnectParamsSchema } from "../../../packages/gateway-protocol/src/schema.js";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI model setup same-client reconnect",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) => `Playwright Chromium is unavailable at ${executablePath}`,
});

const captureUiProofEnabled = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const artifactDir = path.join(
  process.cwd(),
  ".artifacts",
  "control-ui-e2e",
  "model-setup-reconnect",
);

const validateConnect = Compile(ConnectParamsSchema);
function connectParams(value: unknown) {
  if (!validateConnect.Check(value)) {
    throw new Error("Invalid connect request");
  }
  return value;
}

const onboardingWelcome = {
  sessionId: "e2e-first-run",
  reply: "Your model is ready. Let's finish setting up OpenClaw.",
  action: "none",
};

function detection(modelRef: string) {
  return {
    candidates: [],
    manualProviders: [],
    configuredModel: modelRef,
    setupComplete: true,
    workspace: "/tmp/openclaw-e2e",
  };
}

suite.define(() => {
  it.each(["reconnect", "reopen"])(
    "retains manual first-run activation through restart during config refresh (%s)",
    async (restart) => {
      await suite.withPage(
        {
          locale: "en-US",
          serviceWorkers: "block",
          viewport: { height: 900, width: 1280 },
        },
        async ({ page, context }) => {
          const modelRef = "openai/gpt-5.6-luna";
          const pendingVerification = {
            ok: false,
            status: "unavailable",
            error: "Gateway settings are saved but not active yet. Retry after the restart.",
          };
          const gateway = await installMockGateway(page, {
            featureMethods: [
              "chat.metadata",
              "chat.startup",
              "openclaw.setup.detect",
              "openclaw.setup.activate",
              "openclaw.setup.verify",
              "openclaw.chat",
            ],
            methodResponses: {
              "openclaw.chat": onboardingWelcome,
              "openclaw.setup.detect": {
                ...detection(modelRef),
                configuredModel: undefined,
                setupComplete: false,
                manualProviders: [{ id: "openai", label: "OpenAI" }],
              },
              "openclaw.setup.activate": {
                ok: false,
                status: "auth",
                error: "401: invalid test API key",
              },
              "openclaw.setup.verify": pendingVerification,
            },
          });

          await page.goto(
            `${suite.server.baseUrl}settings/model-setup?firstRun=1#bootstrapToken=e2e-first-grant&bootstrapProfile=owner`,
          );
          const firstConnect = connectParams((await gateway.waitForRequest("connect")).params);
          expect(firstConnect.auth).toMatchObject({ bootstrapToken: "e2e-first-grant" });
          const apiKey = page.locator('.model-setup__manual input[type="password"]');
          await apiKey.fill("invalid-test-key");
          await page.getByRole("button", { name: "Connect & verify" }).click();
          await page.getByText("401: invalid test API key").waitFor();
          expect(new URL(page.url()).pathname).toBe("/settings/model-setup");
          expect(await gateway.getRequests("openclaw.setup.verify")).toHaveLength(0);

          await gateway.setMethodResponse("openclaw.setup.activate", {
            ok: true,
            modelRef,
            latencyMs: 42,
            gatewayRestartRequired: true,
          });
          const initialRefreshes = (await gateway.getRequests("config.get")).length;
          await gateway.deferNext("config.get");
          await apiKey.fill("accepted-test-key");
          await page.getByRole("button", { name: "Connect & verify" }).click();
          // The activation response has arrived, but its refresh has not. A
          // restart here must retain the confirmed model without reactivating it.
          await expect
            .poll(async () => (await gateway.getRequests("config.get")).length)
            .toBeGreaterThan(initialRefreshes);
          await gateway.setMethodResponse("openclaw.setup.detect", detection(modelRef));
          let destination = page;
          let reconnectedGateway = gateway;
          if (restart === "reopen") {
            await page.close();
            destination = await context.newPage();
            reconnectedGateway = await installMockGateway(destination, {
              featureMethods: ["openclaw.setup.detect", "openclaw.setup.verify", "openclaw.chat"],
              methodResponses: {
                "openclaw.chat": onboardingWelcome,
                "openclaw.setup.detect": detection(modelRef),
                "openclaw.setup.verify": pendingVerification,
              },
            });
            await destination.goto(
              `${suite.server.baseUrl}#bootstrapToken=e2e-next-grant&bootstrapProfile=owner`,
            );
            const reopened = connectParams(
              (await reconnectedGateway.waitForRequest("connect")).params,
            );
            expect(reopened.auth).toMatchObject({ bootstrapToken: "e2e-next-grant" });
            expect(reopened.device).toMatchObject({
              id: firstConnect.device?.id,
            });
          } else {
            await gateway.closeLatest(1012, "first-run activation restart");
          }
          await reconnectedGateway.waitForRequest("openclaw.setup.verify");
          await destination.getByText(pendingVerification.error, { exact: false }).waitFor();
          expect(new URL(destination.url()).pathname).toBe("/settings/model-setup");
          expect(await reconnectedGateway.getRequests("openclaw.chat")).toHaveLength(0);
          if (captureUiProofEnabled) {
            await mkdir(artifactDir, { recursive: true });
            await destination.screenshot({
              animations: "disabled",
              path: path.join(artifactDir, `manual-first-run-${restart}-pending.png`),
            });
          }
          await reconnectedGateway.setMethodResponse("openclaw.setup.verify", {
            ok: true,
            modelRef,
            latencyMs: 31,
          });
          await destination.getByRole("button", { name: "Verify & use selected model" }).click();
          await expect.poll(() => new URL(destination.url()).pathname).toBe("/custodian");
          if (restart === "reconnect") {
            expect(await gateway.getRequests("openclaw.setup.activate")).toHaveLength(2);
            const connections = await gateway.getRequests("connect");
            expect(connectParams(connections.at(-1)?.params).auth).toMatchObject({
              deviceToken: "e2e-device-token",
            });
            expect(connectParams(connections.at(-1)?.params).auth).not.toHaveProperty(
              "bootstrapToken",
            );
          } else {
            expect(await reconnectedGateway.getRequests("openclaw.setup.activate")).toHaveLength(0);
          }
          await destination.getByText(onboardingWelcome.reply, { exact: true }).waitFor();
          const welcomeRequest = await reconnectedGateway.waitForRequest("openclaw.chat");
          expect(welcomeRequest.params).toMatchObject({ welcomeVariant: "onboarding" });
          if (captureUiProofEnabled) {
            await destination.locator(".custodian__header--minimal").waitFor();
            await mkdir(artifactDir, { recursive: true });
            await destination.screenshot({
              animations: "disabled",
              path: path.join(artifactDir, `manual-first-run-${restart}-fixed.png`),
            });
          }
          expect(new URL(destination.url()).searchParams.get("onboarding")).toBe("1");
        },
      );
    },
  );

  it.each(["clicked candidate", "prepared model", "provider sign-in"])(
    "retains %s first-run activation before refresh reconnects",
    async (entry) => {
      await suite.withPage({ locale: "en-US", serviceWorkers: "block" }, async ({ page }) => {
        const modelRef = "openai/gpt-5.6-luna";
        const activation = { modelRef, gatewayRestartRequired: true };
        const gateway = await installMockGateway(page, {
          featureMethods: [
            "openclaw.setup.detect",
            "openclaw.setup.activate",
            "openclaw.setup.verify",
            "openclaw.setup.auth.start",
            "openclaw.setup.prepare.start",
            "wizard.next",
            "openclaw.chat",
          ],
          methodResponses: {
            "openclaw.chat": onboardingWelcome,
            "openclaw.setup.detect": {
              ...detection(modelRef),
              configuredModel: undefined,
              setupComplete: false,
              candidates:
                entry === "clicked candidate"
                  ? [
                      {
                        kind: "openai-api-key",
                        label: "OpenAI",
                        detail: "Detected access",
                        modelRef,
                        recommended: false,
                        credentials: false,
                      },
                    ]
                  : [],
              prepareOptions: [{ id: "local", label: "Local model", actionLabel: "Prepare model" }],
              authOptions: [
                { id: "provider-login", label: "Provider login", kind: "oauth", featured: true },
              ],
            },
            "openclaw.setup.activate": { ok: true, ...activation },
            "openclaw.setup.auth.start": {
              sessionId: "auth-session",
              done: false,
              status: "running",
            },
            "openclaw.setup.prepare.start": {
              sessionId: "prepare-session",
              done: false,
              status: "running",
            },
            "wizard.next": {
              done: true,
              status: "done",
              ...(entry === "prepared model"
                ? { preparedModelRef: modelRef }
                : { modelActivation: activation }),
            },
            "openclaw.setup.verify": { ok: true, modelRef, latencyMs: 31 },
          },
        });
        await page.goto(`${suite.server.baseUrl}settings/model-setup?firstRun=1`);
        await page.locator(".model-setup__intro").waitFor();
        // Preparation refreshes once before its separate activation. Hold the
        // activation response so only that mutation's refresh is interrupted.
        let refreshes = (await gateway.getRequests("config.get")).length;
        if (entry === "prepared model") {
          await gateway.deferNext("openclaw.setup.activate");
        } else {
          await gateway.deferNext("config.get");
        }
        if (entry === "clicked candidate") {
          await page.getByRole("button", { name: "Test & use" }).click();
        } else if (entry === "prepared model") {
          await page.getByRole("button", { name: "Prepare model" }).click();
        } else {
          await page.locator('[data-auth-choice="provider-login"] button').click();
        }
        if (entry === "prepared model") {
          await gateway.waitForRequest("openclaw.setup.activate");
          await gateway.deferNext("config.get");
          refreshes = (await gateway.getRequests("config.get")).length;
        }
        if (entry === "prepared model") {
          await gateway.resolveDeferred("openclaw.setup.activate");
        } else {
          await gateway.waitForRequest(
            entry === "clicked candidate" ? "openclaw.setup.activate" : "wizard.next",
          );
        }
        await expect
          .poll(async () => (await gateway.getRequests("config.get")).length)
          .toBeGreaterThan(refreshes);
        await gateway.setMethodResponse("openclaw.setup.detect", detection(modelRef));
        await gateway.closeLatest(1012, "activation refresh restart");
        await gateway.waitForRequest("openclaw.setup.verify");
        await expect.poll(() => new URL(page.url()).pathname).toBe("/custodian");
        expect(new URL(page.url()).searchParams.get("onboarding")).toBe("1");
        await page.getByText(onboardingWelcome.reply, { exact: true }).waitFor();
        expect(await gateway.getRequests("openclaw.setup.activate")).toHaveLength(
          entry === "provider sign-in" ? 0 : 1,
        );
      });
    },
  );

  it("re-detects once and replaces stale visible model state after reconnect", async () => {
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1280 },
      },
      async ({ page }) => {
        const pageErrors: string[] = [];
        page.on("pageerror", (error) => pageErrors.push(String(error)));
        const gateway = await installMockGateway(page, {
          featureMethods: ["openclaw.setup.detect"],
          methodResponses: { "openclaw.setup.detect": detection("provider/original-model") },
        });

        const response = await page.goto(`${suite.server.baseUrl}settings/model-setup`);
        expect(response?.status()).toBe(200);
        await page.getByText("original-model", { exact: true }).waitFor();
        const initialDetections = (await gateway.getRequests("openclaw.setup.detect")).length;
        const initialConnections = (await gateway.getRequests("connect")).length;
        await gateway.setMethodResponse(
          "openclaw.setup.detect",
          detection("provider/reconnected-model"),
        );
        await gateway.deferNext("connect");
        await gateway.closeLatest(1012, "model setup reconnect proof");
        await expect
          .poll(async () => page.getByText("original-model", { exact: true }).count())
          .toBe(0);
        await expect
          .poll(async () => (await gateway.getRequests("connect")).length)
          .toBeGreaterThan(initialConnections);
        await gateway.resolveDeferred("connect");
        await expect
          .poll(async () => (await gateway.getRequests("openclaw.setup.detect")).length)
          .toBe(initialDetections + 1);
        await page.getByText("reconnected-model", { exact: true }).waitFor();
        expect(pageErrors).toEqual([]);

        if (captureUiProofEnabled) {
          await mkdir(artifactDir, { recursive: true });
          await page.locator("openclaw-model-setup-page").screenshot({
            animations: "disabled",
            path: path.join(artifactDir, "00-reconnected-model-visible.png"),
          });
        }
      },
    );
  });
});
