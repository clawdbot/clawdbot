// Real browser flow with a mocked Gateway; no Ollama server or model is used.
import path from "node:path";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type { Locator } from "playwright";
import { beforeEach, expect, it } from "vitest";
import type { ApplicationRuntime } from "../app/bootstrap.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import {
  defaultControlUiFeatureMethods,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Model Setup activation feedback mocked Gateway E2E",
  startServerBeforeBrowser: true,
});
const artifactRoot = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();
let artifactDir: string | undefined;
beforeEach(() => {
  artifactDir = artifactRoot
    ? createControlUiE2eArtifactDir("model-setup-activation-feedback", artifactRoot)
    : undefined;
});

async function viewportIntersection(target: Locator): Promise<number> {
  return target.evaluate(
    (element) =>
      new Promise<number>((resolve) => {
        const observer = new IntersectionObserver(([entry]) => {
          observer.disconnect();
          resolve(entry!.intersectionRatio);
        });
        observer.observe(element);
      }),
  );
}

suite.define(() => {
  it("bootstraps chat after leaving direct Model Setup despite unavailable auth status", async () => {
    await suite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport: { width: 1280, height: 800 } },
      async ({ page }) => {
        const pageErrors: string[] = [];
        page.on("pageerror", (error) => pageErrors.push(error.message));
        const gateway = await installMockGateway(page, {
          featureMethods: [...defaultControlUiFeatureMethods, "openclaw.setup.detect"],
          heldMethods: ["openclaw.setup.detect"],
          historyMessages: [
            { role: "assistant", content: [{ type: "text", text: "The existing chat is ready." }] },
          ],
          methodResponses: {
            "openclaw.setup.detect": {
              candidates: [],
              manualProviders: [],
              workspace: "/tmp/openclaw-e2e",
              setupComplete: false,
            },
            "models.authStatus": {
              __mockError: {
                code: "UNAVAILABLE",
                message: "Model authentication status is unavailable.",
                retryable: false,
              },
            },
          },
        });
        await page.goto(`${suite.server.baseUrl}settings/model-setup`);
        await gateway.waitForRequest("openclaw.setup.detect");
        await page.locator(".model-setup__loading").waitFor();
        await page.waitForFunction(() => {
          const app = document.querySelector("openclaw-app") as HTMLElement & {
            runtime: ApplicationRuntime;
          };
          return app.runtime.context.gateway.snapshot.client?.recoveryScopeReady;
        });
        const connectionOwner = await page.evaluateHandle(() => {
          const app = document.querySelector("openclaw-app") as HTMLElement & {
            runtime: ApplicationRuntime;
          };
          const client = app.runtime.context.gateway.snapshot.client!;
          return { client, recoveryScope: client.recoveryScope };
        });
        expect(await gateway.getRequests("chat.startup")).toHaveLength(0);
        await page.getByRole("button", { name: "Back to app" }).click();
        await gateway.waitForRequest("chat.startup");
        await gateway.waitForRequest("models.authStatus");
        await page.getByText("The existing chat is ready.", { exact: true }).waitFor();

        // Revisit before the old detection replies: this visit must own a fresh
        // request rather than inherit the abandoned route loader's pending work.
        await page.goBack();
        await gateway.waitForRequest("openclaw.setup.detect", { after: 1 });
        await gateway.resolveDeferred("openclaw.setup.detect");
        await page
          .locator(".model-setup__intro")
          .getByRole("button", { name: "Check again" })
          .waitFor();
        expect(await gateway.getRequests("openclaw.setup.detect")).toHaveLength(2);
        await page.getByRole("button", { name: "Back to app" }).click();
        await page.getByText("The existing chat is ready.", { exact: true }).waitFor();
        const composer = page.locator(".agent-chat__composer-combobox textarea");
        await expect.poll(() => composer.isEnabled()).toBe(true);
        await composer.fill("Continue after setup.");
        await page.getByRole("button", { name: "Send message", exact: true }).click();
        const sent = await gateway.waitForRequest("chat.send");
        const params = asOptionalRecord(sent.params);
        expect(params).toMatchObject({
          message: "Continue after setup.",
          idempotencyKey: expect.any(String),
        });
        await gateway.emitChatFinal({
          runId: String(params?.idempotencyKey),
          text: "Chat remains usable.",
        });
        await page.getByRole("paragraph").filter({ hasText: "Chat remains usable." }).waitFor();
        expect(await gateway.getRequests("connect")).toHaveLength(1);
        expect(
          await connectionOwner.evaluate(({ client, recoveryScope }) => {
            const app = document.querySelector("openclaw-app") as HTMLElement & {
              runtime: ApplicationRuntime;
            };
            return {
              sameClient: app.runtime.context.gateway.snapshot.client === client,
              recoveryReady: client.recoveryScopeReady,
              sameRecoveryScope: client.recoveryScope === recoveryScope,
            };
          }),
        ).toEqual({ sameClient: true, recoveryReady: true, sameRecoveryScope: true });
        await connectionOwner.dispose();
        expect(pageErrors).toEqual([]);
        if (artifactDir) {
          await page.screenshot({ path: path.join(artifactDir, "setup-back-to-chat.png") });
        }
      },
    );
  });

  it.each([
    { entry: "manual", width: 1080 },
    { entry: "candidate", width: 1280 },
  ])(
    "shows $entry activation feedback in a modal and restores focus after closing",
    async ({ entry, width }) => {
      await suite.withPage(
        { locale: "en-US", serviceWorkers: "block", viewport: { width, height: 720 } },
        async ({ page }) => {
          const gateway = await installMockGateway(page, {
            featureMethods: [
              "openclaw.setup.detect",
              "openclaw.setup.activate.start",
              "wizard.next",
            ],
            methodResponses: {
              "wizard.next": {
                done: true,
                status: "error",
                error: "Authentication failed (provider returned HTTP 401).",
                activationRejection: { disposition: "rejected-before-promotion", status: "auth" },
              },
              "openclaw.setup.detect": {
                candidates:
                  entry === "candidate"
                    ? Array.from({ length: 5 }, (_, index) => ({
                        kind: "provider-auto:local",
                        label: `Local model ${index + 1}`,
                        modelRef: `local/model-${index + 1}`,
                        detail: "Available on this Gateway",
                        credentials: true,
                        recommended: false,
                      }))
                    : [],
                manualProviders: [{ id: "openai", label: "OpenAI", brandId: "openai" }],
                authOptions: ["OpenAI", "OpenRouter", "xAI"].map((label) => ({
                  id: label,
                  label,
                  kind: "oauth",
                  featured: true,
                })),
                workspace: "/tmp/openclaw-e2e",
                setupComplete: false,
              },
            },
          });
          await page.goto(
            `${suite.server.baseUrl}settings/model-setup${entry === "manual" ? "?firstRun=1" : ""}`,
          );
          const setup = page.locator(".model-setup");
          const input = setup.locator('input[type="password"]');
          const scrollToBottom = () =>
            page.locator(".content").evaluate((element) => {
              element.scrollTo({ top: element.scrollHeight, behavior: "instant" });
            });
          if (entry === "manual") {
            await setup.locator(".model-setup-provider-select__trigger").click();
            await setup.locator('[data-manual-provider="openai"]').click();
          }
          await input.fill("invalid-test-key");
          const activate =
            entry === "manual"
              ? setup.getByRole("button", { name: "Connect & verify" })
              : setup.locator("[data-candidate-kind]").last().getByRole("button");
          await activate.scrollIntoViewIfNeeded();
          expect(await viewportIntersection(setup.locator(".model-setup__intro"))).toBe(0);
          expect(
            await page.locator(".content").evaluate((element) => element.scrollTop),
          ).toBeGreaterThan(0);
          await gateway.deferNext("openclaw.setup.activate.start");
          await activate.click();
          const request = await gateway.waitForRequest("openclaw.setup.activate.start");
          expect(request.params).toMatchObject(
            entry === "manual"
              ? { kind: "api-key", authChoice: "openai", apiKey: "invalid-test-key" }
              : { kind: "provider-auto:local", modelRef: "local/model-5" },
          );
          const dialog = page.locator("openclaw-modal-dialog");
          const progress = dialog.getByRole("status");
          await progress.waitFor();
          expect(await progress.count()).toBe(1);
          expect.soft(await viewportIntersection(progress)).toBeGreaterThan(0.99);
          if (artifactDir) {
            await page.screenshot({
              path: path.join(artifactDir, `${entry}-viewport-pending.png`),
            });
          }

          await gateway.resolveDeferred("openclaw.setup.activate.start", {
            sessionId: "activation-session",
            done: false,
            status: "running",
          });
          const failure = dialog.getByRole("alert");
          await failure.waitFor();
          expect(await failure.count()).toBe(1);
          expect(await failure.textContent()).toContain("HTTP 401");
          expect.soft(await viewportIntersection(failure)).toBeGreaterThan(0.99);
          expect(await setup.textContent()).not.toContain("invalid-test-key");
          if (artifactDir) {
            await page.screenshot({ path: path.join(artifactDir, `${entry}-viewport-failed.png`) });
          }
          await dialog.getByRole("button", { name: "Close", exact: true }).click();
          await expect.poll(() => dialog.count()).toBe(0);
          await expect
            .poll(() => activate.evaluate((element) => document.activeElement === element))
            .toBe(true);
          await scrollToBottom();
          await input.fill("another-invalid-test-key");
          expect(await input.evaluate((element) => document.activeElement === element)).toBe(true);
          expect(await gateway.getRequests("openclaw.setup.activate.start")).toHaveLength(1);
        },
      );
    },
  );

  it.each(["provider timeout", "request rejection"])(
    "shows pending and %s for a prepared idle model absent from detection",
    async (outcome) => {
      await suite.withPage(
        {
          locale: "en-US",
          serviceWorkers: "block",
          viewport: { width: 1080, height: 480 },
          ...(artifactDir
            ? { recordVideo: { dir: artifactDir, size: { width: 1080, height: 480 } } }
            : {}),
        },
        async ({ page }) => {
          const gateway = await installMockGateway(page, {
            featureMethods: [
              "openclaw.setup.detect",
              "openclaw.setup.prepare.start",
              "openclaw.setup.activate.start",
              "wizard.next",
            ],
            methodResponses: {
              "openclaw.setup.detect": {
                candidates: [],
                manualProviders: [{ id: "openai", label: "OpenAI", brandId: "openai" }],
                prepareOptions: [
                  { id: "lmstudio", label: "LM Studio", actionLabel: "Connect server" },
                  { id: "llama-cpp", label: "llama.cpp", actionLabel: "Set up model" },
                  {
                    id: "ollama",
                    brandId: "ollama",
                    label: "Ollama",
                    actionLabel: "Choose connection",
                  },
                ],
                workspace: "/tmp/openclaw-e2e",
                setupComplete: false,
              },
              "openclaw.setup.prepare.start": {
                sessionId: "idle-model-prepare",
                done: false,
                status: "running",
              },
              "wizard.next": {
                sequence: [
                  {
                    done: false,
                    status: "running",
                    step: {
                      id: "ollama-mode",
                      type: "select",
                      message: "Ollama mode",
                      options: [{ value: "local-only", label: "Local only" }],
                    },
                  },
                  {
                    done: false,
                    status: "running",
                    step: {
                      id: "ollama-base-url",
                      type: "text",
                      message: "Ollama base URL",
                      initialValue: "http://127.0.0.1:11434",
                    },
                  },
                  { done: true, status: "done", preparedModelRef: "ollama/qwen3:4b" },
                ],
              },
            },
          });
          await page.goto(`${suite.server.baseUrl}settings/model-setup?firstRun=1`);
          const setup = page.locator(".model-setup");
          const choose = setup.getByRole("button", { name: "Choose connection" });
          await choose.click();
          expect(
            (await gateway.waitForRequest("openclaw.setup.prepare.start")).params,
          ).toMatchObject({ authChoice: "ollama" });
          await page.getByRole("radio", { name: "Local only" }).check();
          await page.getByRole("button", { name: "Continue", exact: true }).click();
          await expect
            .poll(() => page.getByLabel("Ollama base URL").inputValue())
            .toBe("http://127.0.0.1:11434");
          await gateway.deferNext("openclaw.setup.activate.start");
          await page.getByRole("button", { name: "Submit", exact: true }).click();
          expect((await gateway.waitForRequest("openclaw.setup.activate.start")).params).toEqual({
            kind: "provider-auto:ollama",
            modelRef: "ollama/qwen3:4b",
            agentId: "main",
            sessionId: expect.any(String),
          });
          await expect.poll(() => page.locator("openclaw-modal-dialog").count()).toBe(1);
          expect(await setup.locator("[data-candidate-kind]").count()).toBe(0);
          expect(await choose.isDisabled()).toBe(true);
          const dialog = page.locator("openclaw-modal-dialog");
          const progress = dialog.getByRole("status");
          await progress.waitFor();
          expect.soft(await viewportIntersection(progress)).toBeGreaterThan(0.99);
          if (artifactDir) {
            await page.screenshot({ path: path.join(artifactDir, `${outcome}-pending.png`) });
          }
          expect.soft(await progress.count()).toBe(1);
          if (await progress.count()) {
            expect(await progress.isVisible()).toBe(true);
            expect(await progress.textContent()).toContain("Checking your model setup");
          }

          if (outcome === "provider timeout") {
            await gateway.setMethodResponse("wizard.next", {
              done: true,
              status: "error",
              error: "The model did not finish the setup test in time.",
              activationRejection: { disposition: "rejected-before-promotion", status: "timeout" },
            });
            await gateway.resolveDeferred("openclaw.setup.activate.start", {
              sessionId: "activation-session",
              done: false,
              status: "running",
            });
          } else {
            await gateway.rejectDeferred("openclaw.setup.activate.start", {
              code: "UNAVAILABLE",
              message: "The model did not finish the setup test in time.",
            });
            // A transport rejection leaves first-run intent unresolved; it must
            // not enable repeating a mutation whose result is still uncertain.
            await setup.getByText(/The previous activation is unresolved/u).waitFor();
            expect(await choose.isDisabled()).toBe(true);
          }
          await expect.poll(() => dialog.getByRole("status").count()).toBe(0);
          const failure = dialog
            .getByRole("alert")
            .filter({ hasText: "The model did not finish the setup test in time." });
          expect.soft(await viewportIntersection(failure)).toBeGreaterThan(0.99);
          if (artifactDir) {
            await page.screenshot({ path: path.join(artifactDir, `${outcome}-failed.png`) });
          }
          expect(await failure.count()).toBe(1);
          expect(await failure.isVisible()).toBe(true);
          expect(await failure.textContent()).toBe(
            "The model did not finish the setup test in time.",
          );
          await dialog.getByRole("button", { name: "Close", exact: true }).click();
          await expect.poll(() => dialog.count()).toBe(0);
          expect(await choose.isEnabled()).toBe(outcome === "provider timeout");
          expect(await setup.locator("[data-candidate-kind]").count()).toBe(0);
          expect(await page.locator(".model-setup-success").count()).toBe(0);
          expect(new URL(page.url()).pathname).toBe("/settings/model-setup");
          expect(await gateway.getRequests("openclaw.setup.activate.start")).toHaveLength(1);
          expect(await gateway.getRequests("config.set")).toHaveLength(0);
          const next = await gateway.getRequests("wizard.next");
          expect(next).toHaveLength(outcome === "provider timeout" ? 4 : 3);
          expect(next[1]?.params).toMatchObject({
            answer: { stepId: "ollama-mode", value: "local-only" },
          });
          expect(next[2]?.params).toMatchObject({
            answer: { stepId: "ollama-base-url", value: "http://127.0.0.1:11434" },
          });
        },
      );
    },
  );
});
