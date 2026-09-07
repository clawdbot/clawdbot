import path from "node:path";
import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { installScriptedRfbServer } from "./desktop-rfb-test-support.ts";

const suite = createControlUiE2eSuite({
  name: "desktop keyboard wire input",
  startServerBeforeBrowser: true,
});

const desktopObserve = {
  transport: "rfb",
  wsPath: "/desktop/observe?token=synthetic-keyboard",
  expiresAtMs: 60_000,
  control: true,
};

async function openKeyboard(page: Page, beforeReady?: (panel: Locator) => Promise<void>) {
  const gateway = await installMockGateway(page, {
    deferredMethods: ["environments.list", "desktop.observe"],
    featureMethods: ["desktop.observe", "environments.list"],
    methodResponses: {
      "desktop.observe": desktopObserve,
    },
  });
  await page.goto(`${suite.server.baseUrl}focus/desktop/control/source/gateway`);
  await gateway.waitForRequest("environments.list");
  const peer = await installScriptedRfbServer(page);
  await gateway.resolveDeferred("environments.list", {
    environments: [{ id: "gateway", type: "local", status: "available", desktop: true }],
  });
  const panel = page.locator("openclaw-desktop-panel");
  await gateway.waitForRequest("desktop.observe");
  await beforeReady?.(panel);
  await gateway.resolveDeferred("desktop.observe");
  await panel.locator(".desktop-surface canvas").waitFor();
  await expect.poll(peer.events).toEqual(["authenticated:1"]);
  await panel
    .getByRole("status", { name: "Connecting to desktop…", exact: true })
    .waitFor({ state: "hidden" });
  await panel.getByRole("button", { name: "Keyboard", exact: true }).click();
  return { gateway, panel, peer, input: panel.locator(".desktop-keyboard-input") };
}

function keyPresses(keysyms: readonly number[]) {
  return keysyms.flatMap((keysym) => [
    { down: true, keysym },
    { down: false, keysym },
  ]);
}

suite.define(() => {
  it("accepts 32 pasted ASCII characters only after connected control and disables view-only input", async () => {
    await suite.withPage({ serviceWorkers: "block" }, async ({ page }) => {
      await page.setViewportSize({ width: 720, height: 540 });
      const artifactDirectory = createControlUiE2eArtifactDir("desktop-keyboard-readiness");
      const { gateway, panel, peer, input } = await openKeyboard(page, async (connectingPanel) => {
        await connectingPanel
          .getByRole("status", { name: "Connecting to desktop…", exact: true })
          .waitFor();
        const keyboard = connectingPanel.getByRole("button", { name: "Keyboard", exact: true });
        const pendingInput = connectingPanel.locator(".desktop-keyboard-input");
        const padding = await pendingInput.inputValue();
        const bounds = await keyboard.boundingBox();
        if (!bounds) {
          throw new Error("Expected the visible desktop Keyboard button");
        }
        await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
        await page.keyboard.insertText("early");
        await page.screenshot({ path: path.join(artifactDirectory, "connecting.png") });
        expect(await pendingInput.inputValue()).toBe(padding);
        expect(await keyboard.isDisabled()).toBe(true);
        expect(await pendingInput.isDisabled()).toBe(true);
      });
      expect(await peer.keyEvents()).toEqual([]);
      const padding = await input.inputValue();
      const text = "Aa7!z?Bb8@x#Cc9$w%Dd0^v&Ee1*f(G)";
      const expected = keyPresses(Array.from(text, (character) => character.charCodeAt(0)));

      await page.keyboard.insertText(text);
      await expect.poll(peer.keyEvents).toEqual(expected);
      expect(await input.inputValue()).toBe(padding);

      await page.keyboard.insertText("Z");
      await page.keyboard.press("Backspace");
      await expect.poll(peer.keyEvents).toEqual([...expected, ...keyPresses([0x5a, 0xff08])]);
      await page.screenshot({ path: path.join(artifactDirectory, "connected-control.png") });

      await gateway.setMethodResponse("desktop.observe", { ...desktopObserve, control: false });
      await panel.getByRole("button", { name: "Switch to view only", exact: true }).click();
      await gateway.waitForRequest("desktop.observe", { after: 1 });
      await expect.poll(peer.events).toContain("authenticated:2");
      await panel
        .getByRole("status", { name: "Connecting to desktop…", exact: true })
        .waitFor({ state: "hidden" });
      expect(await panel.getByRole("button", { name: "Keyboard", exact: true }).isDisabled()).toBe(
        true,
      );
      expect(await input.isDisabled()).toBe(true);
      await page.screenshot({ path: path.join(artifactDirectory, "connected-view-only.png") });
    });
  });

  it.each([
    { name: "deletion", replacement: "", inputType: "deleteContentBackward", keysyms: [0xff08] },
    {
      name: "replacement",
      replacement: "🦀",
      inputType: "insertReplacementText",
      keysyms: [0xff08, 0x0101f980],
    },
  ])(
    "keeps supplementary characters intact during mobile $name",
    async ({ replacement, inputType, keysyms }) => {
      await suite.withPage({ serviceWorkers: "block" }, async ({ page }) => {
        const { peer, input } = await openKeyboard(page);
        const padding = await input.inputValue();
        await page.keyboard.insertText("🦞");
        await expect.poll(peer.keyEvents).toEqual(keyPresses([0x0101f99e]));
        await input.evaluate(
          (element, edit) => {
            if (!(element instanceof HTMLTextAreaElement)) {
              throw new Error("Expected the desktop keyboard textarea");
            }
            element.value = edit.value;
            element.dispatchEvent(
              new InputEvent("input", {
                bubbles: true,
                inputType: edit.inputType,
                data: edit.replacement || null,
              }),
            );
          },
          { value: padding + replacement, inputType, replacement },
        );
        await expect.poll(peer.keyEvents).toEqual(keyPresses([0x0101f99e, ...keysyms]));
      });
    },
  );

  it.each([
    { name: "BMP", text: "éΩ漢", keysyms: [0x00e9, 0x07d9, 0x01006f22] },
    {
      name: "line endings",
      text: "a\r\nb\rc\nd",
      keysyms: [0x61, 0xff0d, 0x62, 0xff0d, 0x63, 0xff0d, 0x64],
    },
    { name: "supplementary Unicode", text: "A🦞B", keysyms: [0x41, 0x0101f99e, 0x42] },
  ])("emits balanced $name keysyms through real noVNC", async ({ text, keysyms }) => {
    await suite.withPage({ serviceWorkers: "block" }, async ({ page }) => {
      const { peer } = await openKeyboard(page);
      await page.keyboard.insertText(text);
      await expect.poll(peer.keyEvents).toEqual(keyPresses(keysyms));
    });
  });
});
