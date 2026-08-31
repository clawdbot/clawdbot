import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Control UI model and effort controls" });

suite.define(() => {
  it.each(["chat", "new"])(
    "keeps independent model and effort controls within the %s composer",
    async (route) => {
      await suite.withPage({ viewport: { width: 393, height: 852 } }, async ({ page }) => {
        const longName =
          "Long catalog display name for a model with a very large context window and detailed reasoning capabilities";
        const thinkingLevels = [
          { id: "low", label: "Low" },
          { id: "high", label: "High" },
        ];
        const gateway = await installMockGateway(page, {
          agentModel: "openai/gpt-5.6-luna",
          models: [
            {
              id: "gpt-5.6-luna",
              provider: "openai",
              name: longName,
              reasoning: true,
              thinkingLevels,
            },
            {
              id: "speed-only",
              provider: "openai",
              name: "Speed only",
              reasoning: false,
              thinkingLevels: [],
            },
            {
              id: "basic",
              provider: "example",
              name: "Basic",
              reasoning: false,
              thinkingLevels: [],
            },
          ],
          methodResponses: {
            "sessions.list": {
              count: 1,
              path: "",
              ts: 1,
              defaults: {
                model: "gpt-5.6-luna",
                modelProvider: "openai",
                thinkingDefault: "high",
                thinkingLevels,
                contextTokens: 200_000,
              },
              sessions: [
                {
                  key: "agent:main:main",
                  kind: "direct",
                  model: "gpt-5.6-luna",
                  modelProvider: "openai",
                  updatedAt: 1,
                  contextTokens: 200_000,
                  totalTokens: 46_000,
                  totalTokensFresh: true,
                },
              ],
            },
          },
        });
        await page.goto(`${suite.server.baseUrl}${route}`);
        const composer = page.locator(".agent-chat__input").first();
        const model = composer.locator('[data-chat-model-select="true"]');
        const effort = composer.locator('[data-chat-thinking-select="true"]');
        await expect.poll(() => model.getAttribute("title")).toBe(longName);
        await expect.poll(() => effort.isVisible()).toBe(true);
        for (const width of [320, 375, 393, 430, 560, 768, 1280]) {
          await page.setViewportSize({ width, height: 900 });
          await expect
            .poll(
              async () => {
                const [modelBox, effortBox, actionsBox, composerBox] = await Promise.all([
                  model.boundingBox(),
                  effort.boundingBox(),
                  composer.locator(".agent-chat__composer-actions").boundingBox(),
                  composer.boundingBox(),
                ]);
                return Boolean(
                  modelBox &&
                  effortBox &&
                  actionsBox &&
                  composerBox &&
                  modelBox.width > 0 &&
                  effortBox.width >= 44 &&
                  modelBox.x >= composerBox.x &&
                  modelBox.x + modelBox.width <= effortBox.x + 1 &&
                  effortBox.x + effortBox.width <= actionsBox.x + 1 &&
                  actionsBox.x + actionsBox.width <= composerBox.x + composerBox.width + 1,
                );
              },
              { message: `nonoverlapping ${route} controls at ${width}px` },
            )
            .toBe(true);
          const label = await model
            .locator(".chat-controls__inline-select-label")
            .evaluate((node) => ({
              content: node.textContent?.trim(),
              clipped: node.scrollWidth > node.clientWidth,
              overflow: getComputedStyle(node).overflow,
              textOverflow: getComputedStyle(node).textOverflow,
            }));
          expect(label).toEqual({
            content: longName,
            clipped: true,
            overflow: "hidden",
            textOverflow: "ellipsis",
          });
          expect(await model.getAttribute("aria-label")).toContain(longName);
          await model.click();
          const menu = composer.locator(".chat-controls__model-menu");
          await expect.poll(() => menu.isVisible()).toBe(true);
          expect(await menu.getByText(/Effort|Fast mode/).count()).toBe(0);
          expect(
            await menu.locator("[data-chat-thinking-slider], [data-chat-speed-toggle]").count(),
          ).toBe(0);
          await expect
            .poll(() => menu.getByRole("option", { name: new RegExp(longName) }).count())
            .toBe(1);
          await page.keyboard.press("Escape");
          await expect
            .poll(() => model.evaluate((node) => node === document.activeElement))
            .toBe(true);
          const artifactRoot = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();
          const artifactDir = artifactRoot
            ? createControlUiE2eArtifactDir("chat-model-controls", artifactRoot)
            : undefined;
          if (artifactDir && [320, 393, 560, 1280].includes(width)) {
            await page.screenshot({
              path: `${artifactDir}/${route}-model-effort-${width}.png`,
              animations: "disabled",
            });
          }
        }
        await page.setViewportSize({ width: 393, height: 852 });
        await page.emulateMedia({ reducedMotion: "no-preference" });
        const needle = effort.locator(".chat-controls__effort-gauge-needle");
        const needleAngle = () =>
          needle.evaluate((node) => {
            const matrix = new DOMMatrixReadOnly(getComputedStyle(node).transform);
            return Math.round((Math.atan2(matrix.b, matrix.a) * 180) / Math.PI);
          });
        await expect.poll(needleAngle).toBe(120);
        expect(
          await needle.evaluate((node) =>
            Number.parseFloat(getComputedStyle(node).transitionDuration),
          ),
        ).toBeGreaterThan(0);
        expect(await needle.evaluate((node) => node.namespaceURI)).toBe(
          "http://www.w3.org/2000/svg",
        );
        await effort.click();
        const slider = composer.locator('[data-chat-thinking-slider="true"]');
        await expect.poll(() => slider.isVisible()).toBe(true);
        await slider.press("Home");
        await expect.poll(() => effort.getAttribute("data-chat-thinking-value")).toBe("low");
        await expect.poll(needleAngle).toBe(-120);
        if (route === "chat") {
          expect((await gateway.waitForRequest("sessions.patch")).params).toMatchObject({
            key: "agent:main:main",
            thinkingLevel: "low",
          });
        }
        await page.emulateMedia({ reducedMotion: "reduce" });
        expect(await needle.evaluate((node) => getComputedStyle(node).transitionProperty)).toBe(
          "none",
        );
        await slider.press("End");
        await expect.poll(() => effort.getAttribute("data-chat-thinking-value")).toBe("high");
        expect(await needleAngle()).toBe(120);
        await page.keyboard.press("Escape");
        await expect
          .poll(() => effort.evaluate((node) => node === document.activeElement))
          .toBe(true);
        if (route === "chat") {
          await page.setViewportSize({ width: 1180, height: 900 });
          await page.getByRole("button", { name: "Open split view" }).click();
          const panes = page.locator(".chat-split-view__pane .agent-chat__input");
          await expect.poll(() => panes.count()).toBe(2);
          await expect
            .poll(() =>
              panes.evaluateAll((inputs) =>
                inputs.every((input) => {
                  const paneModel = input.querySelector<HTMLElement>(
                    '[data-chat-model-select="true"]',
                  );
                  const paneEffort = input.querySelector<HTMLElement>(
                    '[data-chat-thinking-select="true"]',
                  );
                  const actions = input.querySelector<HTMLElement>(".agent-chat__composer-actions");
                  if (!paneModel || !paneEffort || !actions) {
                    return false;
                  }
                  const modelBox = paneModel.getBoundingClientRect();
                  const effortBox = paneEffort.getBoundingClientRect();
                  return (
                    input.getBoundingClientRect().width <= 480 &&
                    modelBox.width > 0 &&
                    effortBox.width > 0 &&
                    modelBox.right <= effortBox.left + 1 &&
                    effortBox.right <= actions.getBoundingClientRect().left + 1
                  );
                }),
              ),
            )
            .toBe(true);
          const artifactRoot = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();
          const artifactDir = artifactRoot
            ? createControlUiE2eArtifactDir("chat-model-controls", artifactRoot)
            : undefined;
          if (artifactDir) {
            await page.screenshot({
              path: `${artifactDir}/chat-model-effort-split.png`,
              animations: "disabled",
            });
          }
        }
        await model.click();
        await composer.locator("[data-chat-model-search]").fill("Speed only");
        await composer.locator('[data-chat-model-option="openai/speed-only"]').click();
        if (route === "chat") {
          await expect
            .poll(async () =>
              (await gateway.getRequests("sessions.patch")).map(({ params }) => params),
            )
            .toContainEqual({
              key: "agent:main:main",
              model: "openai/speed-only",
            });
        } else {
          await expect.poll(() => effort.count()).toBe(1);
          await expect.poll(() => effort.getAttribute("aria-label")).toBe("Fast mode: Standard");
          await expect
            .poll(() => composer.locator("[data-chat-speed-toggle]").getAttribute("aria-checked"))
            .toBe("false");
          await model.click();
          await composer.locator('[data-chat-model-option="example/basic"]').click();
          await expect.poll(() => effort.count()).toBe(0);
        }
      });
    },
  );
  it.each(["openai", "example"])(
    "keeps %s non-reasoning capabilities reachable without a model-menu bridge",
    async (provider) => {
      await suite.withPage({ viewport: { width: 320, height: 852 } }, async ({ page }) => {
        const gateway = await installMockGateway(page, {
          agentModel: `${provider}/basic`,
          models: [{ id: "basic", provider, name: "Basic", reasoning: false, thinkingLevels: [] }],
          methodResponses: {
            "sessions.list": {
              count: 1,
              path: "",
              ts: 1,
              defaults: {
                model: "basic",
                modelProvider: provider,
                thinkingLevels: [],
                contextTokens: 200_000,
              },
              sessions: [
                {
                  key: "agent:main:main",
                  kind: "direct",
                  model: "basic",
                  modelProvider: provider,
                  thinkingLevels: [],
                  contextTokens: 200_000,
                  totalTokens: 46_000,
                  totalTokensFresh: true,
                  updatedAt: 1,
                },
              ],
            },
          },
        });
        await page.goto(`${suite.server.baseUrl}chat`);
        const composer = page.locator(".agent-chat__input");
        const model = composer.locator('[data-chat-model-select="true"]');
        await expect.poll(() => model.getAttribute("aria-busy")).toBe("false");
        const effort = composer.locator('[data-chat-thinking-select="true"]');
        if (provider === "example") {
          await expect.poll(() => effort.count()).toBe(0);
          return;
        }
        await expect.poll(() => effort.getAttribute("aria-label")).toBe("Fast mode: Standard");
        const [modelBox, effortBox, actionsBox] = await Promise.all([
          model.boundingBox(),
          effort.boundingBox(),
          composer.locator(".agent-chat__composer-actions").boundingBox(),
        ]);
        expect(modelBox).not.toBeNull();
        expect(effortBox).not.toBeNull();
        expect(actionsBox).not.toBeNull();
        expect(modelBox!.x + modelBox!.width).toBeLessThanOrEqual(effortBox!.x + 1);
        expect(effortBox!.x + effortBox!.width).toBeLessThanOrEqual(actionsBox!.x + 1);
        expect(effortBox!.width).toBeGreaterThanOrEqual(44);
        await effort.click();
        expect(await composer.locator("[data-chat-thinking-slider]").count()).toBe(0);
        await composer.getByRole("switch", { name: /Fast responses/ }).click();
        expect((await gateway.waitForRequest("sessions.patch")).params).toMatchObject({
          key: "agent:main:main",
          fastMode: true,
        });
        await expect.poll(() => effort.getAttribute("aria-label")).toBe("Fast mode: Fast");
        await page.keyboard.press("Escape");
        await expect
          .poll(() => effort.evaluate((node) => node === document.activeElement))
          .toBe(true);
        const artifactRoot = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();
        const artifactDir = artifactRoot
          ? createControlUiE2eArtifactDir("chat-model-controls", artifactRoot)
          : undefined;
        if (artifactDir) {
          await page.screenshot({
            path: `${artifactDir}/chat-speed-only-320.png`,
            animations: "disabled",
          });
        }
      });
    },
  );
});
