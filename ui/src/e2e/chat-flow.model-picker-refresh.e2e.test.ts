import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import {
  createChatFlowE2eSuite,
  installMockGateway,
  requireRecord,
} from "./chat-flow.test-support.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";

const suite = createChatFlowE2eSuite();

const captureUiProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";

async function screenshot(page: Page, name: string) {
  if (!captureUiProof) {
    return;
  }
  await mkdir(path.join(suite.artifactDir, "model-picker-refresh"), { recursive: true });
  await page.screenshot({
    animations: "disabled",
    path: path.join(path.join(suite.artifactDir, "model-picker-refresh"), name),
  });
}

suite.define(() => {
  it("preserves the Gateway-resolved target without exposing it in the picker", async () => {
    const context = await suite.newBrowserContext({
      hasTouch: true,
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
      ...(captureUiProof
        ? {
            recordVideo: {
              dir: path.join(suite.artifactDir, "model-picker-refresh"),
              size: { height: 900, width: 1280 },
            },
          }
        : {}),
    });
    const page = await context.newPage();
    const session = {
      key: "agent:main:main",
      kind: "direct",
      updatedAt: 1,
      sessionId: "model-target-proof",
      model: "gpt-5.6-sol",
      modelProvider: "openai",
    };
    const gateway = await installMockGateway(page, {
      sessionKey: session.key,
      models: [
        { id: "gpt-5.6-sol", name: "GPT-5.6 Sol", provider: "openai" },
        { id: "gpt-5.6-terra", name: "GPT-5.6 Terra", provider: "openai" },
      ],
      methodResponses: {
        "sessions.list": {
          ts: 1,
          path: "",
          count: 1,
          sessions: [session],
          defaults: {
            contextTokens: null,
            model: "gpt-5.6-sol",
            modelProvider: "openai",
            modelSelectionTarget: "global",
          },
        },
      },
    });
    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      let picker = page.locator(
        'openclaw-chat-pane[aria-hidden="false"] .chat-controls__model-picker',
      );
      await picker.locator('[data-chat-model-select="true"]').tap();
      await picker.getByRole("option", { name: "GPT-5.6 Terra", exact: true }).waitFor();
      await expect.poll(() => picker.locator("[data-chat-model-selection-target]").count()).toBe(0);
      await screenshot(page, "05-picker-before-touch-selection.png");

      await picker.getByRole("option", { name: "GPT-5.6 Terra", exact: true }).tap();
      const request = await gateway.waitForRequest("sessions.patch");
      expect(request.params).toMatchObject({
        key: "agent:main:main",
        model: "openai/gpt-5.6-terra",
      });
      await expect
        .poll(() =>
          picker.locator('[data-chat-model-select="true"]').getAttribute("data-chat-select-value"),
        )
        .toBe("openai/gpt-5.6-terra");
      await screenshot(page, "06-picker-after-touch-selection.png");

      await gateway.setSessionsListResponse({
        ts: 2,
        path: "",
        count: 1,
        sessions: [
          {
            ...session,
            model: "gpt-5.6-terra",
            modelOverrideSource: "user",
            updatedAt: 2,
          },
        ],
        defaults: {
          contextTokens: null,
          model: "gpt-5.6-terra",
          modelProvider: "openai",
          modelSelectionTarget: "global",
        },
      });

      await page.reload();
      picker = page.locator('openclaw-chat-pane[aria-hidden="false"] .chat-controls__model-picker');
      await picker.locator('[data-chat-model-select="true"]').tap();
      await picker.getByRole("button", { name: "Reset session model", exact: true }).waitFor();
      await expect.poll(() => picker.locator("[data-chat-model-selection-target]").count()).toBe(0);
      await expect
        .poll(() =>
          picker.locator('[data-chat-model-select="true"]').getAttribute("data-chat-select-value"),
        )
        .toBe("openai/gpt-5.6-terra");
      await screenshot(page, "07-picker-after-reload.png");
      await page.setViewportSize({ height: 900, width: 400 });
      const footer = picker.locator(".chat-controls__model-provenance");
      await expect
        .poll(() =>
          footer.evaluate((element) => {
            const bounds = element.getBoundingClientRect();
            return Array.from(element.children).every((child) => {
              const childBounds = child.getBoundingClientRect();
              const range = document.createRange();
              range.selectNodeContents(child);
              const lines = new Set(Array.from(range.getClientRects(), (rect) => rect.top));
              return (
                lines.size === 1 &&
                childBounds.left >= bounds.left &&
                childBounds.right <= bounds.right
              );
            });
          }),
        )
        .toBe(true);
      await screenshot(page, "08-compact-footer-mobile.png");
      const configureModels = picker
        .getByRole("button", { name: "Configure models", exact: true })
        .first();
      await expect
        .poll(() =>
          configureModels.evaluate((button) => {
            const heading = button.closest<HTMLElement>("[data-chat-model-provider]");
            if (!heading) {
              return Number.POSITIVE_INFINITY;
            }
            return heading.getBoundingClientRect().right - button.getBoundingClientRect().right;
          }),
        )
        .toBeLessThanOrEqual(11);
      await expect
        .poll(() =>
          configureModels.locator("svg").evaluate((icon) => icon.getBoundingClientRect().width),
        )
        .toBeLessThanOrEqual(12);
      await configureModels.hover();
      await page.waitForTimeout(800);
      const configureModelsTooltip = page.locator("wa-tooltip[open]").filter({
        hasText: "Configure models",
      });
      await expect.poll(() => configureModelsTooltip.count()).toBe(0);
      await screenshot(page, "09-configure-models-no-tooltip.png");
      await configureModels.tap();
      await expect.poll(() => page.url()).toContain("model-setup");
      await page.locator("openclaw-model-setup-page .model-setup").waitFor({ state: "visible" });
      await screenshot(page, "10-model-setup-navigation.png");
    } finally {
      await context.close();
    }
  });

  it("clears a persisted pin matching the default through the default model row", async () => {
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
      ...(captureUiProof
        ? {
            recordVideo: {
              dir: path.join(suite.artifactDir, "model-picker-refresh"),
              size: { height: 900, width: 1280 },
            },
          }
        : {}),
    });
    const page = await context.newPage();
    const session = {
      key: "agent:main:main",
      kind: "direct",
      updatedAt: 1,
      sessionId: "model-pin-proof",
      model: "gpt-5.5",
      modelProvider: "openai",
      modelOverrideSource: "user",
    };
    const gateway = await installMockGateway(page, {
      sessionKey: "agent:main:main",
      sessionInfo: session,
      models: [{ id: "gpt-5.5", name: "Proof Model", provider: "openai" }],
      methodResponses: {
        "sessions.list": {
          ts: 1,
          path: "",
          count: 1,
          sessions: [session],
          defaults: { model: "gpt-5.5", modelProvider: "openai", contextTokens: null },
        },
      },
    });
    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      const picker = page.locator(
        'openclaw-chat-pane[aria-hidden="false"] .chat-controls__model-picker',
      );
      await picker.locator('[data-chat-model-select="true"]').click();
      await picker.getByRole("button", { name: "Reset session model", exact: true }).waitFor();
      await screenshot(page, "03-pin-matching-default.png");
      await picker.getByRole("option", { name: "Proof Model", exact: true }).click();
      const request = await gateway.waitForRequest("sessions.patch");
      expect(request.params).toMatchObject({ key: "agent:main:main", model: null });
      await expect
        .poll(() =>
          picker.locator('[data-chat-model-select="true"]').getAttribute("data-chat-select-value"),
        )
        .toBe("");
      await picker.locator('[data-chat-model-select="true"]').click();
      await expect.poll(() => picker.locator("[data-chat-model-reset]").count()).toBe(0);
      await screenshot(page, "04-pin-cleared.png");
    } finally {
      await context.close();
    }
  });

  it("keeps the warm model list interactive while a picker-open refresh is in flight", async () => {
    const context = await suite.newBrowserContext(createControlUiE2eContextOptions());
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      models: [
        { id: "gpt-5.6-sol", name: "GPT-5.6 Sol", provider: "openai" },
        { id: "gpt-5.6-luna", name: "GPT-5.6 Luna", provider: "openai" },
        { id: "fable-5", name: "Claude Fable 5", provider: "anthropic" },
      ],
      sessionKey: "agent:main:main",
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      const pane = page.locator('openclaw-chat-pane[aria-hidden="false"]');
      const picker = pane.locator(".chat-controls__model-picker");
      await picker.locator("[data-chat-model-option]").first().waitFor({ state: "attached" });

      // Freeze the operator-signaled revalidation so the in-flight state is observable.
      await gateway.deferNext("models.list", { refresh: true });
      await picker.locator('[data-chat-model-select="true"]').click();
      const request = await gateway.waitForRequest("models.list");
      expect(requireRecord(request.params)).toMatchObject({ refresh: true, view: "configured" });

      // The warm list stays rendered and selectable with no refresh/loading interstitial.
      await expect
        .poll(() => picker.locator("[data-chat-model-option]:visible").count())
        .toBeGreaterThanOrEqual(3);
      await screenshot(page, "01-picker-open-refresh-in-flight.png");
      expect(await picker.locator("[data-chat-model-catalog-state]").count()).toBe(0);
      expect(
        await picker.locator('[data-chat-model-option="openai/gpt-5.6-luna"]').isDisabled(),
      ).toBe(false);

      // Discovery invalidates the session projection; only that projection can update readiness.
      await gateway.deferNext("chat.metadata");
      await gateway.resolveDeferred("models.list", {
        models: [
          { id: "gpt-5.6-sol", name: "GPT-5.6 Sol", provider: "openai" },
          { id: "gpt-5.6-terra", name: "GPT-5.6 Terra", provider: "openai" },
        ],
      });
      const metadataRequest = await gateway.waitForRequest("chat.metadata");
      expect(metadataRequest.params).toEqual({ agentId: "main", sessionKey: "agent:main:main" });
      expect(
        await picker.locator('[data-chat-model-option="openai/gpt-5.6-luna"]').isVisible(),
      ).toBe(true);
      await gateway.resolveDeferred("chat.metadata", {
        commands: [],
        models: [
          { id: "gpt-5.6-sol", name: "GPT-5.6 Sol", provider: "openai" },
          { id: "gpt-5.6-terra", name: "GPT-5.6 Terra", provider: "openai" },
        ],
      });
      await picker
        .locator('[data-chat-model-option="openai/gpt-5.6-terra"]')
        .waitFor({ state: "visible" });
      expect(await picker.locator("[data-chat-model-catalog-state]").count()).toBe(0);
      await screenshot(page, "02-picker-after-background-apply.png");
    } finally {
      await context.close();
    }
  });
});
