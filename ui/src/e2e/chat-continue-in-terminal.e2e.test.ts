import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { decodeResumeHandoff } from "../../../src/shared/resume-handoff.js";
import type { ChatPaneElement } from "../pages/chat/route-draft-focus-handoff.ts";
import {
  controlUiSessionPath,
  controlUiSessionUrl,
  installMockGateway,
  waitForControlUiRoute,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI continue in terminal mocked Gateway E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not installed at ${executablePath}. Run \`pnpm --dir ui exec playwright install chromium\`, or set OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM=1 only when intentionally skipping this lane.`,
});

const artifactDir = path.resolve(process.cwd(), ".artifacts/control-ui-e2e/header-session-menu");
const basePath = new URL("/nested/$&;=()+,![]{}'`/%25PATH%25", "http://localhost").pathname;
const agentId = "runner";
const sessionKey = `agent:${agentId}:main-'"$&;|<>^()%![]{}\\\`-%PATH%`;

function sessionsListResponse() {
  return {
    count: 1,
    owners: [
      { type: "human" as const, id: "profile-ada", label: "Ada" },
      { type: "human" as const, id: "profile-bob", label: "Bob" },
    ],
    defaults: { contextTokens: null, model: "gpt-5.5", modelProvider: "openai" },
    path: "",
    sessions: [
      {
        agentId,
        key: sessionKey,
        kind: "direct",
        label: "Terminal continuation",
        sessionId: "session-terminal-continuation",
        owner: { actor: { type: "human", id: "profile-bob", label: "Bob" } },
        updatedAt: Date.now(),
      },
    ],
    ts: Date.now(),
  };
}

const sharedManagementActions = [
  "Pin session",
  "Mark as unread",
  "Rename…",
  "Assign to me",
  "Assign to…",
  "Set icon",
  "Fork",
  "Copy session ID",
  "Move to group",
  "Archive session",
  "Delete…",
] as const;
const compactManagementActions = sharedManagementActions
  .filter((label) => label !== "Assign to me")
  // Compact mode folds icon and color into one drill-down row.
  .map((label) => (label === "Set icon" ? "Icon & color" : label));

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
          featureMethods: [
            "chat.startup",
            "sessions.assignOwner",
            "sessions.groups.put",
            "sessions.patch",
          ],
          historyMessages: [
            {
              content: [{ type: "text", text: "Ready for terminal continuation." }],
              role: "assistant",
              timestamp: Date.now(),
            },
          ],
          methodResponses: { "sessions.list": sessionsListResponse() },
          operatorScopes: ["operator.read", "operator.write"],
          presenceUsers: [{ self: true, id: "profile-ada", name: "Ada" }],
          sessionKey,
        });
        const pageUrl = new URL(suite.server.baseUrl);
        const gatewayUrl = `ws://${pageUrl.host}${basePath}`;
        await context.grantPermissions(["clipboard-read", "clipboard-write"], {
          origin: pageUrl.origin,
        });
        await page.goto(
          controlUiSessionUrl(new URL(`${basePath}/`, suite.server.baseUrl).href, sessionKey),
        );
        const activePane = page.locator("openclaw-chat-pane.chat-pane-cache__pane--active");
        await expect
          .poll(() => activePane.evaluate((pane) => (pane as ChatPaneElement).sessionKey))
          .toBe(sessionKey);
        await waitForControlUiRoute(page, {
          routeId: "chat",
          pathname: controlUiSessionPath(sessionKey, basePath),
          pathnamePrefix: `${basePath}/chat/`,
          search: "",
          hash: "",
        });
        await activePane.getByText("Ready for terminal continuation.").waitFor({ timeout: 10_000 });

        const menuTrigger = activePane.getByRole("button", {
          name: "Actions for Terminal continuation",
        });
        await expect.poll(() => menuTrigger.getAttribute("aria-expanded")).toBe("false");
        await menuTrigger.press("Enter");
        const dropdown = menuTrigger.locator("xpath=ancestor::wa-dropdown");
        for (const label of sharedManagementActions) {
          await dropdown.getByText(label, { exact: true }).waitFor({ state: "visible" });
        }
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

  it("keeps the canonical session actions reachable in the mobile header menu", async () => {
    await mkdir(artifactDir, { recursive: true });
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { width: 390, height: 844 },
      },
      async ({ page }) => {
        await installMockGateway(page, {
          basePath,
          featureMethods: [
            "chat.startup",
            "sessions.assignOwner",
            "sessions.groups.put",
            "sessions.patch",
          ],
          historyMessages: [
            {
              content: [{ type: "text", text: "Mobile session menu proof." }],
              role: "assistant",
              timestamp: Date.now(),
            },
          ],
          methodResponses: { "sessions.list": sessionsListResponse() },
          operatorScopes: ["operator.read", "operator.write"],
          presenceUsers: [{ self: true, id: "profile-ada", name: "Ada" }],
          sessionKey,
        });
        await page.goto(
          controlUiSessionUrl(new URL(`${basePath}/`, suite.server.baseUrl).href, sessionKey),
        );
        const activePane = page.locator("openclaw-chat-pane.chat-pane-cache__pane--active");
        // Mock history also renders in the retained boot pane. Wait for this session's pane
        // before Playwright resolves a control that can stay mounted beneath its replacement.
        await expect
          .poll(() => activePane.evaluate((pane) => (pane as ChatPaneElement).sessionKey))
          .toBe(sessionKey);
        await waitForControlUiRoute(page, { routeId: "chat" });
        await activePane
          .getByRole("paragraph")
          .filter({ hasText: /^Mobile session menu proof\.$/ })
          .waitFor();

        const menuTrigger = activePane.getByRole("button", {
          name: "Actions for Terminal continuation",
        });
        await menuTrigger.click();
        await expect.poll(() => menuTrigger.getAttribute("aria-expanded")).toBe("true");
        const dropdown = menuTrigger.locator("xpath=ancestor::wa-dropdown");
        for (const label of compactManagementActions) {
          await dropdown.getByText(label, { exact: true }).waitFor({ state: "visible" });
        }
        await page.screenshot({
          animations: "disabled",
          fullPage: true,
          path: path.join(artifactDir, "03-mobile-menu.png"),
        });
      },
    );
  });
});
