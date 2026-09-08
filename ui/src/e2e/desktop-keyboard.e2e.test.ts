import type { Page } from "playwright";
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { installScriptedRfbServer } from "./desktop-rfb-test-support.ts";

const suite = createControlUiE2eSuite({
  name: "desktop keyboard wire input",
  startServerBeforeBrowser: true,
});

async function openKeyboard(page: Page) {
  const gateway = await installMockGateway(page, {
    deferredMethods: ["environments.list"],
    featureMethods: ["desktop.observe", "environments.list"],
    methodResponses: {
      "desktop.observe": {
        transport: "rfb",
        wsPath: "/desktop/observe?token=synthetic-keyboard",
        expiresAtMs: 60_000,
        control: true,
      },
    },
  });
  await page.goto(`${suite.server.baseUrl}focus/desktop/control/source/gateway`);
  await gateway.waitForRequest("environments.list");
  const peer = await installScriptedRfbServer(page);
  await gateway.resolveDeferred("environments.list", {
    environments: [{ id: "gateway", type: "local", status: "available", desktop: true }],
  });
  const panel = page.locator("openclaw-desktop-panel");
  await panel.locator(".desktop-surface canvas").waitFor();
  await expect.poll(peer.events).toEqual(["authenticated:1"]);
  await panel.getByText("Connecting to desktop…", { exact: true }).waitFor({ state: "hidden" });
  await panel.getByRole("button", { name: "Keyboard", exact: true }).click();
  return { peer, input: panel.locator(".desktop-keyboard-input") };
}

function keyPresses(keysyms: readonly number[]) {
  return keysyms.flatMap((keysym) => [
    { down: true, keysym },
    { down: false, keysym },
  ]);
}

suite.define(() => {
  it("preserves all 32 pasted ASCII characters through padding reset and Backspace", async () => {
    await suite.withPage({ serviceWorkers: "block" }, async ({ page }) => {
      const { peer, input } = await openKeyboard(page);
      const padding = await input.inputValue();
      const text = "Aa7!z?Bb8@x#Cc9$w%Dd0^v&Ee1*f(G)";
      const expected = keyPresses(Array.from(text, (character) => character.charCodeAt(0)));

      await page.keyboard.insertText(text);
      await expect.poll(peer.keyEvents).toEqual(expected);
      expect(await input.inputValue()).toBe(padding);

      await page.keyboard.insertText("Z");
      await page.keyboard.press("Backspace");
      await expect.poll(peer.keyEvents).toEqual([...expected, ...keyPresses([0x5a, 0xff08])]);
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
