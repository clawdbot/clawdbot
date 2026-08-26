import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { decodeResumeHandoff } from "../../../src/shared/resume-handoff.js";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI continue in terminal mocked Gateway E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not installed at ${executablePath}. Run \`pnpm --dir ui exec playwright install chromium\`, or set OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM=1 only when intentionally skipping this lane.`,
});

const artifactDir = path.resolve(process.cwd(), ".artifacts/control-ui-e2e/continue-in-terminal");
const basePath = "/nested/$&;=()+,![]{}'`/%25PATH%25";
const agentId = "runner";
const sessionKey = `agent:${agentId}:main-'"$&;|<>^()%![]{}\\\`-%PATH%`;

function sessionsListResponse() {
  return {
    count: 1,
    defaults: { contextTokens: null, model: "gpt-5.5", modelProvider: "openai" },
    path: "",
    sessions: [
      {
        agentId,
        key: sessionKey,
        kind: "direct",
        label: "Terminal continuation",
        updatedAt: Date.now(),
      },
    ],
    ts: Date.now(),
  };
}

suite.define(() => {
  it("shows, copies, and retires a credential-free exact continuation command", async () => {
    await rm(artifactDir, { recursive: true, force: true });
    await mkdir(artifactDir, { recursive: true });
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { width: 1440, height: 900 },
      },
      async ({ context, page }) => {
        const gateway = await installMockGateway(page, {
          basePath,
          historyMessages: [
            {
              content: [{ type: "text", text: "Ready for terminal continuation." }],
              role: "assistant",
              timestamp: Date.now(),
            },
          ],
          methodResponses: { "sessions.list": sessionsListResponse() },
          sessionKey,
        });
        const pageUrl = new URL(suite.server.baseUrl);
        const gatewayUrl = `ws://${pageUrl.host}${basePath}`;
        await context.grantPermissions(["clipboard-read", "clipboard-write"], {
          origin: pageUrl.origin,
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
        const activePane = page.locator("openclaw-chat-pane.chat-pane-cache__pane--active");
        await activePane.getByText("Ready for terminal continuation.").waitFor({ timeout: 10_000 });

        const menuTrigger = activePane.getByRole("button", {
          name: "Actions for Terminal continuation",
        });
        await expect.poll(() => menuTrigger.getAttribute("aria-expanded")).toBe("false");
        await menuTrigger.press("Enter");
        const dropdown = menuTrigger.locator("xpath=ancestor::wa-dropdown");
        const action = dropdown.getByText("Continue in terminal…", { exact: true });
        await action.waitFor({ state: "visible" });
        await page.screenshot({ path: path.join(artifactDir, "01-menu.png"), fullPage: true });
        await action.click();

        const dialog = page.locator("openclaw-modal-dialog.continue-in-terminal-dialog");
        await dialog.waitFor({ state: "visible" });
        await action.waitFor({ state: "hidden" });
        const command = (await dialog.locator("code").textContent()) ?? "";
        expect(command).toMatch(/^openclaw resume --handoff [A-Za-z0-9_-]+$/u);
        const encoded = command.slice("openclaw resume --handoff ".length);
        expect(decodeResumeHandoff(encoded)).toEqual({
          version: 1,
          sessionKey,
          gatewayUrl,
        });
        expect(await dialog.textContent()).not.toMatch(/--token|--password|bootstrap/i);
        await page.screenshot({ path: path.join(artifactDir, "02-modal.png"), fullPage: true });
        await dialog.getByRole("button", { name: "Copy command", exact: true }).click();
        await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(command);

        await dialog.getByRole("button", { name: "Close" }).click();
        await menuTrigger.press("Enter");
        await action.click();
        await dialog.waitFor({ state: "visible" });
        const socketCount = await gateway.getSocketCount();
        await gateway.closeLatest(1001, "continue-in-terminal reconnect proof");
        await dialog.waitFor({ state: "detached", timeout: 10_000 });
        await expect
          .poll(() => gateway.getSocketCount(), { timeout: 15_000 })
          .toBeGreaterThan(socketCount);
      },
    );
  });
});
