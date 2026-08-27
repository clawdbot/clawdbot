import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import { installMockGateway, type MockGatewayControls } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI agent identity lifecycle",
  startServerBeforeBrowser: true,
});
const captureUiProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const proofDir = path.join(
  process.cwd(),
  ".artifacts",
  "control-ui-e2e",
  "agent-identity-lifecycle",
);
const overviewPath = "settings/agents/main/overview";

async function capture(page: Page, state: string) {
  if (!captureUiProof) {
    return;
  }
  await mkdir(proofDir, { recursive: true });
  await page.locator(".agent-identity-editor__avatar").scrollIntoViewIfNeeded();
  await page.screenshot({
    animations: "disabled",
    fullPage: true,
    path: path.join(proofDir, `${process.env.OPENCLAW_UI_PROOF_LABEL ?? "current"}-${state}.png`),
  });
}

function identityResponses(name: string, avatar = "") {
  const identity = { name, avatar };
  const config = { agents: { entries: { main: { default: true, identity } } } };
  return {
    "agents.list": {
      agents: [{ id: "main", name, identity }],
      defaultId: "main",
      mainKey: "main",
      scope: "per-sender",
    },
    "agent.identity.get": {
      agentId: "main",
      name,
      avatar,
      avatarStatus: avatar ? "data" : "none",
    },
    "config.get": {
      config,
      sourceConfig: config,
      runtimeConfig: config,
      hash: `identity-${name}`,
      issues: [],
      raw: JSON.stringify(config),
      valid: true,
    },
  };
}

async function publishIdentity(gateway: MockGatewayControls, name: string, avatar = "") {
  for (const [method, response] of Object.entries(identityResponses(name, avatar))) {
    await gateway.setMethodResponse(method, response);
  }
}

async function openIdentity(page: Page) {
  const gateway = await installMockGateway(page, {
    assistantName: "QA agent",
    defaultAgentId: "main",
    featureMethods: ["agents.list", "agents.update", "agent.identity.get", "config.get"],
    methodResponses: identityResponses("QA agent"),
    operatorScopes: ["operator.admin", "operator.read", "operator.write"],
  });
  expect((await page.goto(`${suite.server.baseUrl}${overviewPath}`))?.status()).toBe(200);
  const editor = page.locator("openclaw-agents-page .agent-identity-editor");
  const name = editor.getByRole("textbox", { name: "Display name" });
  const actions = page.locator(".agent-identity-editor__actions");
  const save = actions.getByRole("button");
  await expect.poll(() => name.inputValue()).toBe("QA agent");
  await gateway.waitForRequest("config.get");
  return { gateway, editor, name, actions, save };
}

suite.define(() => {
  it("saves the selected image with a dirty name after native image decoding finishes", async () => {
    await suite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport: { width: 1440, height: 1000 } },
      async ({ page }) => {
        await page.addInitScript(() => {
          const decode = globalThis.createImageBitmap.bind(globalThis);
          Object.defineProperty(globalThis, "createImageBitmap", {
            value: async (...args: Parameters<typeof createImageBitmap>) => {
              if (args[0] instanceof File && args[0].name === "qa-avatar.png") {
                await new Promise<void>((resolve) => {
                  window.addEventListener("qa-release-avatar-decode", () => resolve(), {
                    once: true,
                  });
                  document.documentElement.setAttribute("data-qa-avatar-decoding", "pending");
                });
              }
              return decode(...args);
            },
          });
        });
        const { gateway, editor, name, actions, save } = await openIdentity(page);
        const png = await page.evaluate(() => {
          const canvas = document.createElement("canvas");
          canvas.width = 96;
          canvas.height = 96;
          const context = canvas.getContext("2d")!;
          context.fillStyle = "rgb(30 144 255)";
          context.fillRect(0, 0, 96, 96);
          context.fillStyle = "white";
          context.fillRect(24, 24, 48, 48);
          return canvas.toDataURL("image/png").split(",")[1]!;
        });
        await name.fill("QA image agent");
        await actions.locator('input[type="file"]').setInputFiles({
          name: "qa-avatar.png",
          mimeType: "image/png",
          buffer: Buffer.from(png, "base64"),
        });
        await page.locator('html[data-qa-avatar-decoding="pending"]').waitFor();
        await gateway.deferNext("agents.update");
        await save.click();
        await expect.poll(async () => (await save.textContent())?.trim()).toBe("Saving…");
        await page.evaluate(
          () =>
            new Promise<void>((resolve) => {
              requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
            }),
        );
        await capture(page, "decode-pending");
        expect(await gateway.getRequests("agents.update")).toHaveLength(0);

        await page.evaluate(() => window.dispatchEvent(new Event("qa-release-avatar-decode")));
        const request = await gateway.waitForRequest("agents.update");
        expect(request.params).toMatchObject({
          agentId: "main",
          name: "QA image agent",
          avatar: expect.stringMatching(/^data:image\/(?:webp|png);base64,/),
        });
        const avatar = (request.params as { avatar: string }).avatar;
        await publishIdentity(gateway, "QA image agent", avatar);
        await gateway.resolveDeferred("agents.update", { ok: true });
        await expect.poll(async () => (await save.textContent())?.trim()).toBe("Save");
        await expect.poll(() => save.isDisabled()).toBe(true);
        await expect.poll(() => name.inputValue()).toBe("QA image agent");
        await expect.poll(() => editor.locator("img").getAttribute("src")).toBe(avatar);
        await expect
          .poll(() =>
            editor.locator("img").evaluate((image: HTMLImageElement) => image.naturalWidth),
          )
          .toBeGreaterThan(0);
        await capture(page, "saved-image");
        expect(await gateway.getRequests("agents.update")).toHaveLength(1);

        await page.reload();
        await expect.poll(() => name.inputValue()).toBe("QA image agent");
        await expect.poll(() => editor.locator("img").getAttribute("src")).toBe(avatar);
        await expect.poll(() => save.isDisabled()).toBe(true);
        expect(await gateway.getRequests("agents.update")).toHaveLength(0);
      },
    );
  });

  it("unlocks an interrupted save and preserves the editable draft for retry after reconnect", async () => {
    await suite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport: { width: 1440, height: 1000 } },
      async ({ page }) => {
        const { gateway, name, save } = await openIdentity(page);
        await name.fill("QA retry agent");
        await gateway.deferNext("agents.update");
        await save.click();
        await gateway.waitForRequest("agents.update");
        await expect.poll(async () => (await save.textContent())?.trim()).toBe("Saving…");
        await gateway.setOnline(false);
        await page.getByText("Actions are unavailable while the Gateway reconnects.").waitFor();
        // Retire the response owned by the closed socket before deferring the retry.
        await gateway.resolveDeferred("agents.update", { ok: true });

        const connectsBefore = (await gateway.getRequests("connect")).length;
        await gateway.setOnline(true);
        await gateway.waitForRequest("connect", { after: connectsBefore });
        await name.waitFor();
        await capture(page, "reconnected-save");
        await expect.poll(async () => (await save.textContent())?.trim()).toBe("Save");
        await expect.poll(() => name.inputValue()).toBe("QA retry agent");
        await expect.poll(() => name.isEnabled()).toBe(true);
        await expect.poll(() => save.isEnabled()).toBe(true);
        await name.fill("QA retried agent");
        await gateway.deferNext("agents.update");
        const updatesBefore = (await gateway.getRequests("agents.update")).length;
        await save.click();
        const retry = await gateway.waitForRequest("agents.update", { after: updatesBefore });
        expect(retry.params).toEqual({ agentId: "main", name: "QA retried agent" });
        await publishIdentity(gateway, "QA retried agent");
        await gateway.resolveDeferred("agents.update", { ok: true });
        await expect.poll(async () => (await save.textContent())?.trim()).toBe("Save");
        await expect.poll(() => save.isDisabled()).toBe(true);
        await expect.poll(() => name.inputValue()).toBe("QA retried agent");
        expect(await gateway.getRequests("agents.update")).toHaveLength(2);
        await capture(page, "reconnected-retry-saved");
      },
    );
  });
});
