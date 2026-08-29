// Real browser flow with a mocked Gateway; no Ollama server or model is used.
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Locator } from "playwright";
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Model Setup activation feedback mocked Gateway E2E",
  startServerBeforeBrowser: true,
});
const artifactDir = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();

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
  it.each([
    { entry: "manual", width: 1080 },
    { entry: "candidate", width: 1280 },
  ])(
    "reveals $entry activation feedback in the scrolled viewport without taking focus",
    async ({ entry, width }) => {
      await suite.withPage(
        { locale: "en-US", serviceWorkers: "block", viewport: { width, height: 720 } },
        async ({ page }) => {
          const gateway = await installMockGateway(page, {
            featureMethods: ["openclaw.setup.detect", "openclaw.setup.activate"],
            methodResponses: {
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
          await gateway.deferNext("openclaw.setup.activate");
          await activate.click();
          const request = await gateway.waitForRequest("openclaw.setup.activate");
          expect(request.params).toMatchObject(
            entry === "manual"
              ? { kind: "api-key", authChoice: "openai", apiKey: "invalid-test-key" }
              : { kind: "provider-auto:local", modelRef: "local/model-5" },
          );
          const progress = setup.getByRole("status");
          await progress.waitFor();
          expect(await progress.count()).toBe(1);
          expect.soft(await viewportIntersection(progress)).toBeGreaterThan(0.99);
          expect(
            await page.evaluate(
              () => document.activeElement?.closest('[role="status"], [role="alert"]') !== null,
            ),
          ).toBe(false);
          if (artifactDir) {
            await mkdir(artifactDir, { recursive: true });
            await page.screenshot({
              path: path.join(artifactDir, `${entry}-viewport-pending.png`),
            });
          }

          // The operator may scroll away while waiting. Completion must reveal
          // feedback again without moving focus from another control.
          await scrollToBottom();
          expect(await viewportIntersection(progress)).toBe(0);
          const focusAnchor = page.locator(".content-header a").first();
          await focusAnchor.evaluate((element) =>
            (element as HTMLElement).focus({ preventScroll: true }),
          );
          await gateway.resolveDeferred("openclaw.setup.activate", {
            ok: false,
            status: "auth",
            error: "Authentication failed (provider returned HTTP 401).",
          });
          const failure = setup.getByRole("alert");
          await failure.waitFor();
          expect(await failure.count()).toBe(1);
          expect(await failure.textContent()).toContain("HTTP 401");
          expect.soft(await viewportIntersection(failure)).toBeGreaterThan(0.99);
          expect(await focusAnchor.evaluate((element) => document.activeElement === element)).toBe(
            true,
          );
          expect(await setup.textContent()).not.toContain("invalid-test-key");
          if (artifactDir) {
            await page.screenshot({ path: path.join(artifactDir, `${entry}-viewport-failed.png`) });
          }
          await scrollToBottom();
          await input.fill("another-invalid-test-key");
          expect(await viewportIntersection(failure)).toBe(0);
          expect(await input.evaluate((element) => document.activeElement === element)).toBe(true);
          expect(await gateway.getRequests("openclaw.setup.activate")).toHaveLength(1);
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
              "openclaw.setup.activate",
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
          await gateway.deferNext("openclaw.setup.activate");
          await page.getByRole("button", { name: "Submit", exact: true }).click();
          expect((await gateway.waitForRequest("openclaw.setup.activate")).params).toEqual({
            kind: "provider-auto:ollama",
            modelRef: "ollama/qwen3:4b",
            agentId: "main",
          });
          await expect.poll(() => page.locator("openclaw-modal-dialog").count()).toBe(0);
          expect(await setup.locator("[data-candidate-kind]").count()).toBe(0);
          expect(await choose.isDisabled()).toBe(true);
          const progress = setup.getByRole("status");
          await progress.waitFor();
          expect.soft(await viewportIntersection(progress)).toBeGreaterThan(0.99);
          if (artifactDir) {
            await mkdir(artifactDir, { recursive: true });
            await page.screenshot({ path: path.join(artifactDir, `${outcome}-pending.png`) });
          }
          expect.soft(await progress.count()).toBe(1);
          if (await progress.count()) {
            expect(await progress.isVisible()).toBe(true);
            expect(await progress.textContent()).toContain("Testing");
          }

          await setup.locator(".model-setup__manual").scrollIntoViewIfNeeded();
          expect(await viewportIntersection(progress)).toBe(0);

          if (outcome === "provider timeout") {
            await gateway.resolveDeferred("openclaw.setup.activate", {
              ok: false,
              status: "timeout",
              error: "The model did not finish the setup test in time.",
            });
            await expect.poll(() => choose.isEnabled()).toBe(true);
          } else {
            await gateway.rejectDeferred("openclaw.setup.activate", {
              code: "UNAVAILABLE",
              message: "The model did not finish the setup test in time.",
            });
            // A transport rejection leaves first-run intent unresolved; it must
            // not enable repeating a mutation whose result is still uncertain.
            await setup.getByText(/The previous activation is unresolved/u).waitFor();
            expect(await choose.isDisabled()).toBe(true);
          }
          await expect.poll(() => setup.getByRole("status").count()).toBe(0);
          const failure = setup
            .getByRole("alert")
            .filter({ hasText: "The model did not finish the setup test in time." });
          expect.soft(await viewportIntersection(failure)).toBeGreaterThan(0.99);
          if (artifactDir) {
            await page.screenshot({ path: path.join(artifactDir, `${outcome}-failed.png`) });
          }
          expect(await failure.count()).toBe(1);
          expect(await failure.isVisible()).toBe(true);
          expect(await failure.textContent()).toContain(
            outcome === "provider timeout"
              ? "Warm it or choose a faster model, then retry."
              : "Review the connection details, then retry.",
          );
          expect(await setup.locator("[data-candidate-kind]").count()).toBe(0);
          expect(await page.locator(".model-setup-success").count()).toBe(0);
          expect(new URL(page.url()).pathname).toBe("/settings/model-setup");
          expect(await gateway.getRequests("openclaw.setup.activate")).toHaveLength(1);
          expect(await gateway.getRequests("config.set")).toHaveLength(0);
          const next = await gateway.getRequests("wizard.next");
          expect(next).toHaveLength(3);
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
