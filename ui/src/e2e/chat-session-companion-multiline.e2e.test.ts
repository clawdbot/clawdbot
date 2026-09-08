import path from "node:path";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { openChatSidePanelType } from "./chat-side-panel.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "side chat multiline",
  startServerBeforeBrowser: true,
});

suite.define(() => {
  it.each([1200, 560])("writes and sends multiline side-chat questions at %spx", async (width) => {
    const artifactRoot = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();
    const artifactDir = artifactRoot
      ? createControlUiE2eArtifactDir(`side-chat-multiline-${width}`, artifactRoot)
      : undefined;
    await suite.withPage(
      {
        viewport: { width, height: 800 },
        ...(artifactDir ? { recordVideo: { dir: artifactDir, size: { width, height: 800 } } } : {}),
      },
      async ({ page }) => {
        const sessionKey = "agent:main:multiline-proof";
        const gateway = await installMockGateway(page, {
          sessionKey,
          methodResponses: {
            "sessions.companion.state": { exchanges: [] },
            "sessions.companion.ask": { answer: "Both paragraphs arrived together.", ts: 1_000 },
          },
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
        await openChatSidePanelType(page, "Side chat");
        const companion = page.locator("openclaw-chat-session-rail");
        const input = companion.getByRole("textbox", { name: "Ask in side chat" });
        await input.fill("First paragraph.");
        const shortHeight = await input.evaluate((element) => element.clientHeight);
        await input.press("Shift+Enter");
        await input.pressSequentially("Second paragraph.");
        if (artifactDir) {
          await page.screenshot({ path: path.join(artifactDir, "paragraphs.png") });
        }
        expect(await input.inputValue()).toBe("First paragraph.\nSecond paragraph.");
        expect(await gateway.getRequests("sessions.companion.ask")).toHaveLength(0);
        await expect
          .poll(() => input.evaluate((element) => element.clientHeight))
          .toBeGreaterThan(shortHeight);

        // Wrapping must grow the editor even without explicit newlines.
        await input.fill("Explain the changes and the remaining verification steps. ".repeat(5));
        await expect
          .poll(() => input.evaluate((element) => element.clientHeight))
          .toBeGreaterThan(shortHeight);
        expect(
          await input.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
        ).toBe(true);

        await input.fill("A line of context.\n".repeat(20));
        await expect
          .poll(() => input.evaluate((element) => element.scrollHeight > element.clientHeight))
          .toBe(true);
        const cappedHeight = await input.evaluate((element) => element.clientHeight);
        expect(cappedHeight).toBeLessThanOrEqual(200);
        await input.press("ControlOrMeta+End");
        expect(await input.evaluate((element) => getComputedStyle(element).overflowY)).toBe("auto");
        if (artifactDir) {
          await page.screenshot({ path: path.join(artifactDir, "bounded-scrolling.png") });
        }
        await input.fill("First paragraph.\nSecond paragraph.");
        await expect
          .poll(() => input.evaluate((element) => element.clientHeight))
          .toBeLessThan(cappedHeight);
        await input.press("Enter");
        const request = await gateway.waitForRequest("sessions.companion.ask");
        expect(request.params).toMatchObject({ question: "First paragraph.\nSecond paragraph." });
        await companion.getByText("Both paragraphs arrived together.", { exact: true }).waitFor();
        const question = companion.locator(".chat-session-rail__question");
        // oxlint-disable-next-line unicorn/prefer-dom-node-text-content -- textContent retains newlines even when CSS collapses them visually.
        await expect.poll(() => question.innerText()).toBe("First paragraph.\nSecond paragraph.");
        await expect.poll(() => input.inputValue()).toBe("");
        await expect
          .poll(() => input.evaluate((element) => element.clientHeight))
          .toBe(shortHeight);
        expect(await gateway.getRequests("sessions.companion.ask")).toHaveLength(1);
        if (artifactDir) {
          await page.screenshot({ path: path.join(artifactDir, "sent.png") });
        }
      },
    );
  });
});
