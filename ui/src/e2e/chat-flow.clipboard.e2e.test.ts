import path from "node:path";
import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { createChatFlowE2eSuite, installMockGateway } from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();

type ClipboardFailureProof = {
  asyncAttempts: number;
  legacyAttempts: number;
  value: string;
};

async function installDeniedClipboard(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const proof = { asyncAttempts: 0, legacyAttempts: 0, value: "" };
    Object.defineProperty(globalThis, "clipboardFailureProof", {
      configurable: true,
      value: proof,
    });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          proof.asyncAttempts += 1;
          proof.value = text;
          throw new DOMException("Clipboard access denied", "NotAllowedError");
        },
      },
    });
    document.execCommand = ((command: string) => {
      if (command === "copy") {
        proof.legacyAttempts += 1;
      }
      return false;
    }) as typeof document.execCommand;
  });
}

async function readClipboardFailureProof(page: Page): Promise<ClipboardFailureProof> {
  return page.evaluate(
    () =>
      (globalThis as typeof globalThis & { clipboardFailureProof: ClipboardFailureProof })
        .clipboardFailureProof,
  );
}

async function deferClipboard(page: Page): Promise<void> {
  await page.evaluate(() => {
    navigator.clipboard.writeText = (value) => {
      const proof = (
        globalThis as typeof globalThis & { clipboardFailureProof: ClipboardFailureProof }
      ).clipboardFailureProof;
      proof.asyncAttempts += 1;
      proof.value = value;
      return new Promise<void>((resolve, reject) => {
        Object.defineProperty(globalThis, "resolveClipboardRetry", {
          configurable: true,
          value: (failed: boolean) =>
            failed
              ? reject(new DOMException("Clipboard access denied", "NotAllowedError"))
              : resolve(),
        });
      });
    };
  });
}

async function resolveClipboard(page: Page, failed = false): Promise<void> {
  await page.evaluate(
    (rejected) =>
      (
        globalThis as typeof globalThis & { resolveClipboardRetry: (failed: boolean) => void }
      ).resolveClipboardRetry(rejected),
    failed,
  );
}

async function selectBubbleText(bubble: Locator): Promise<void> {
  await bubble.locator(".chat-text").evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  });
  await bubble.click({ button: "right" });
  // Context-menu dismissal listeners install on the next animation frame.
  await bubble.page().evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => resolve());
      }),
  );
}

suite.define(() => {
  it.each(["tool-diff", "selection", "agent-id"] as const)(
    "reports clipboard failure from the %s action",
    async (surface) => {
      const artifactDirParent = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();
      const artifactDir = artifactDirParent
        ? createControlUiE2eArtifactDir("chat-flow.clipboard", artifactDirParent)
        : undefined;
      const context = await suite.newBrowserContext({
        colorScheme: "light",
        locale: "en-US",
        viewport: { height: 900, width: 1440 },
        ...(artifactDir
          ? { recordVideo: { dir: artifactDir, size: { height: 900, width: 1440 } } }
          : {}),
      });
      const page = await context.newPage();
      await page.clock.install();
      await installDeniedClipboard(page);
      const text = "Deployment update is ready for review.";
      const gateway = await installMockGateway(page, {
        historyMessages: [
          {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "copy-edit",
                name: "edit",
                arguments: { path: "src/deploy.ts", oldText: "before", newText: "after" },
              },
            ],
            timestamp: 1_000,
          },
          {
            role: "toolResult",
            toolCallId: "copy-edit",
            toolName: "edit",
            content: [{ type: "text", text: "Updated src/deploy.ts" }],
            timestamp: 2_000,
          },
          { role: "assistant", content: [{ type: "text", text }], timestamp: 3_000 },
        ],
      });
      try {
        await page.goto(
          `${suite.server.baseUrl}${surface === "agent-id" ? "settings/agents/main" : "chat"}`,
        );
        let button;
        if (surface === "tool-diff") {
          await page.getByText(text, { exact: true }).waitFor();
          await page
            .locator(".chat-tool-msg-summary")
            .first()
            .click({ position: { x: 4, y: 4 } });
          button = await page
            .locator(".chat-tool-card__actions")
            .getByRole("button", { name: "Copy", exact: true })
            .elementHandle();
        } else if (surface === "selection") {
          const bubble = page.locator(".chat-bubble").filter({ hasText: text });
          await bubble.waitFor();
          await selectBubbleText(bubble);
          button = await page
            .locator(".chat-reply-context-menu")
            .getByRole("menuitem", { name: "Copy", exact: true })
            .elementHandle();
        } else {
          button = await page.getByRole("button", { name: "Copy ID", exact: true }).elementHandle();
        }
        if (!button) {
          throw new Error(`Missing ${surface} copy button`);
        }
        const hasAccessibleName = (name: string) =>
          page
            .getByRole(surface === "selection" ? "menuitem" : "button", { name, exact: true })
            .evaluate((element, original) => element === original, button);
        await button.click();
        await expect
          .poll(async () => (await readClipboardFailureProof(page)).legacyAttempts)
          .toBe(1);
        expect((await readClipboardFailureProof(page)).asyncAttempts).toBe(1);
        if (artifactDir) {
          await page.screenshot({
            path: path.join(artifactDir, `clipboard-${surface}-failure.png`),
          });
        }
        expect(await button.evaluate((element) => element.isConnected)).toBe(true);
        expect(await hasAccessibleName("Copy failed")).toBe(true);
        const copiedValue = (await readClipboardFailureProof(page)).value;
        expect(copiedValue).toBe(
          surface === "tool-diff" ? "-before\n+after" : surface === "selection" ? text : "main",
        );
        await deferClipboard(page);
        await button.dblclick();
        expect(await button.isDisabled()).toBe(true);
        expect(await button.getAttribute("aria-busy")).toBe("true");
        expect(await readClipboardFailureProof(page)).toEqual({
          asyncAttempts: 2,
          legacyAttempts: 1,
          value: copiedValue,
        });
        await resolveClipboard(page);
        if (surface === "selection") {
          await expect.poll(() => page.locator(".chat-reply-context-menu").count()).toBe(0);
        } else {
          await expect.poll(() => hasAccessibleName("Copied!")).toBe(true);
          expect(await button.isDisabled()).toBe(false);
          await page.clock.fastForward(1_500);
          await expect
            .poll(() => hasAccessibleName(surface === "agent-id" ? "Copy ID" : "Copy"))
            .toBe(true);
        }
        expect(await gateway.getRequests("chat.send")).toHaveLength(0);
      } finally {
        await suite.closeBrowserContext(context);
      }
    },
  );

  it.each([false, true])(
    "scopes pending agent ID copies across selection changes (rejected: %s)",
    async (failed) => {
      const context = await suite.newBrowserContext({ locale: "en-US" });
      const page = await context.newPage();
      await installDeniedClipboard(page);
      await installMockGateway(page, {
        methodResponses: {
          "agents.list": {
            defaultId: "main",
            mainKey: "main",
            scope: "per-sender",
            agents: [
              { id: "main", name: "Main" },
              { id: "reviewer", name: "Reviewer" },
            ],
          },
        },
      });
      try {
        await page.goto(`${suite.server.baseUrl}settings/agents/main`);
        const copy = page.locator(".agents-toolbar-actions button").filter({ hasText: "Copy ID" });
        await copy.waitFor();
        await deferClipboard(page);
        await copy.click();
        expect(await copy.isDisabled()).toBe(true);
        const picker = page.locator("openclaw-agents-page openclaw-agent-select");
        await picker.locator(".agent-select__trigger").click();
        await picker
          .locator("wa-dropdown-item[data-agent-option]")
          .filter({ hasText: "Reviewer" })
          .click();
        await expect.poll(() => new URL(page.url()).pathname).toBe("/settings/agents/reviewer");
        expect(await copy.isDisabled()).toBe(false);
        expect((await readClipboardFailureProof(page)).value).toBe("main");
        expect(await copy.count()).toBe(1);
        expect(await copy.isDisabled()).toBe(false);
        expect(await page.getByRole("button", { name: "Copied!", exact: true }).count()).toBe(0);
        await page.evaluate(() => {
          const proof = (
            globalThis as typeof globalThis & { clipboardFailureProof: ClipboardFailureProof }
          ).clipboardFailureProof;
          navigator.clipboard.writeText = async (value) => {
            proof.asyncAttempts += 1;
            proof.value = value;
          };
          document.execCommand = ((command: string) => {
            if (command !== "copy") {
              return false;
            }
            proof.legacyAttempts += 1;
            proof.value = (document.activeElement as HTMLTextAreaElement).value;
            return true;
          }) as typeof document.execCommand;
        });
        await copy.click();
        expect((await readClipboardFailureProof(page)).value).toBe("reviewer");
        await page.getByRole("button", { name: "Copied!", exact: true }).waitFor();
        await resolveClipboard(page, failed);
        expect(await readClipboardFailureProof(page)).toEqual({
          asyncAttempts: 2,
          legacyAttempts: 0,
          value: "reviewer",
        });
        expect(await page.getByRole("button", { name: "Copied!", exact: true }).count()).toBe(1);
      } finally {
        await suite.closeBrowserContext(context);
      }
    },
  );

  it.each(
    ["Escape", "outside click", "replacement", "navigation", "reconnect"].flatMap((dismissal) =>
      [false, true].map((failed) => ({ dismissal, failed })),
    ),
  )(
    "handles pending selection copies after $dismissal (rejected: $failed)",
    async ({ dismissal, failed }) => {
      const context = await suite.newBrowserContext({ locale: "en-US" });
      const page = await context.newPage();
      await installDeniedClipboard(page);
      const text = "Selected transcript text.";
      const gateway = await installMockGateway(page, {
        historyMessages: [
          { role: "assistant", content: [{ type: "text", text }], timestamp: 1_000 },
        ],
      });
      try {
        await page.goto(`${suite.server.baseUrl}chat`);
        const bubble = page.locator(".chat-bubble").filter({ hasText: text });
        await bubble.waitFor();
        await deferClipboard(page);
        await selectBubbleText(bubble);
        const menu = page.locator(".chat-reply-context-menu");
        const copy = menu.getByRole("menuitem", { name: "Copy", exact: true });
        await copy.click();
        expect(await copy.isDisabled()).toBe(true);
        if (dismissal === "Escape") {
          await page.keyboard.press("Escape");
        } else if (dismissal === "outside click") {
          await page.locator(".agent-chat__composer-combobox textarea").click();
        } else if (dismissal === "replacement") {
          await selectBubbleText(bubble);
        } else if (dismissal === "navigation") {
          const sidebar = page.locator("openclaw-app-sidebar");
          await sidebar.locator(".sidebar-identity-card").click();
          await sidebar
            .locator('wa-dropdown.sidebar-identity-menu wa-dropdown-item[value="command:usage"]')
            .click();
          await expect.poll(() => new URL(page.url()).pathname).toBe("/usage");
        } else {
          const sockets = await gateway.getSocketCount();
          await gateway.closeLatest(1001, "copy lifecycle proof");
          await expect.poll(() => gateway.getSocketCount()).toBeGreaterThan(sockets);
          // Reconnection retains this transcript: copy remains owned until dismissal.
          expect(await copy.isDisabled()).toBe(true);
          await page.keyboard.press("Escape");
        }
        if (dismissal !== "replacement") {
          await expect.poll(() => menu.count()).toBe(0);
        }
        if (dismissal === "navigation") {
          await page.goBack();
          await bubble.waitFor();
        }
        if (dismissal !== "replacement") {
          await selectBubbleText(bubble);
        }
        expect(await copy.isDisabled()).toBe(false);
        await resolveClipboard(page, failed);
        expect(await readClipboardFailureProof(page)).toEqual({
          asyncAttempts: 1,
          legacyAttempts: 0,
          value: text,
        });
        expect(await copy.count()).toBe(1);
        expect(await copy.isDisabled()).toBe(false);
        expect(await menu.getByRole("menuitem", { name: "Copy failed", exact: true }).count()).toBe(
          0,
        );
        await page.keyboard.press("Escape");
        expect(await menu.count()).toBe(0);
      } finally {
        await suite.closeBrowserContext(context);
      }
    },
  );

  it.each([
    { action: "copy-path", label: "Copy path", value: "/workspace" },
    { action: "copy-branch", label: "Copy branch name", value: "feature/clipboard" },
  ] as const)(
    "shows a visible error when the workspace header $action clipboard action fails",
    async ({ action, label, value }) => {
      const context = await suite.newBrowserContext({
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1280 },
      });
      const page = await context.newPage();
      await installDeniedClipboard(page);
      const gateway = await installMockGateway(page, {
        workspace: "/workspace",
        workspaceGit: true,
        methodResponses: {
          "worktrees.branches": { headBranch: "feature/clipboard" },
        },
      });

      try {
        await page.goto(`${suite.server.baseUrl}chat`);
        await page.locator(".chat-pane__workspace-chip").click();
        await gateway.waitForRequest("worktrees.branches");
        await page.getByText(label, { exact: true }).click();

        const alert = page.getByRole("alert").filter({ hasText: "Copy failed" });
        await alert.waitFor({ state: "visible", timeout: 10_000 });
        expect(await readClipboardFailureProof(page)).toEqual({
          asyncAttempts: 1,
          legacyAttempts: 1,
          value,
        });
        expect(await gateway.getRequests("chat.send")).toHaveLength(0);

        const artifactDirParent = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();
        const artifactDir = artifactDirParent
          ? createControlUiE2eArtifactDir("chat-flow.clipboard", artifactDirParent)
          : undefined;
        if (artifactDir) {
          await page.screenshot({
            fullPage: true,
            path: path.join(artifactDir, `clipboard-${action}-failure.png`),
          });
        }
      } finally {
        await suite.closeBrowserContext(context);
      }
    },
  );

  it("shows and resets a visible accessible failure when assistant code cannot be copied", async () => {
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    await page.clock.install();
    await installDeniedClipboard(page);
    const code = "const answer = 42;";
    const gateway = await installMockGateway(page, {
      historyMessages: [
        {
          content: [{ text: `\`\`\`ts\n${code}\n\`\`\``, type: "text" }],
          role: "assistant",
          timestamp: Date.now(),
        },
      ],
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      const button = page.locator(".code-block-copy");
      await button.click();

      await expect.poll(() => button.getAttribute("aria-label")).toBe("Copy failed");
      await expect.poll(() => button.getAttribute("class")).toContain("copy-failed");
      await expect
        .poll(() =>
          button
            .locator(".code-block-copy__failed")
            .evaluate((element) => getComputedStyle(element).display),
        )
        .not.toBe("none");
      expect(await readClipboardFailureProof(page)).toEqual({
        asyncAttempts: 1,
        legacyAttempts: 1,
        value: code,
      });
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);

      const artifactDirParent = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();
      const artifactDir = artifactDirParent
        ? createControlUiE2eArtifactDir("chat-flow.clipboard", artifactDirParent)
        : undefined;
      if (artifactDir) {
        await page.screenshot({
          fullPage: true,
          path: path.join(artifactDir, "clipboard-assistant-code-failure.png"),
        });
      }

      await page.clock.fastForward(2_000);
      await expect.poll(() => button.getAttribute("aria-label")).toBe("Copy code");
      await expect.poll(() => button.getAttribute("class")).not.toContain("copy-failed");
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it.each([1280, 390])(
    "keeps message-copy failure readable after leaving the control at %dpx",
    async (width) => {
      const context = await suite.newBrowserContext({
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width },
      });
      const page = await context.newPage();
      await page.clock.install();
      await installDeniedClipboard(page);
      await installMockGateway(page, {
        historyMessages: [
          { content: [{ text: "Copy this complete message.", type: "text" }], role: "assistant" },
        ],
      });
      try {
        await page.goto(`${suite.server.baseUrl}chat`);
        const message = page.locator(".chat-group.assistant").filter({
          hasText: "Copy this complete message.",
        });
        await message.locator(".chat-text").click();
        await message.hover();
        const copy = message.getByRole("button", { name: "Copy as markdown", exact: true });
        await copy.click();
        await page.locator(".agent-chat__composer-combobox textarea").focus();
        await page.mouse.move(0, 0);
        const feedback = message.getByRole("status").filter({ hasText: "Copy failed" });
        await feedback.waitFor({ state: "visible" });
        expect(
          await feedback.evaluate((element) =>
            element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }),
          ),
        ).toBe(true);
        const bounds = await feedback.boundingBox();
        expect(bounds).not.toBeNull();
        expect(bounds!.x).toBeGreaterThanOrEqual(0);
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
        expect(await readClipboardFailureProof(page)).toEqual({
          asyncAttempts: 1,
          legacyAttempts: 1,
          value: "Copy this complete message.",
        });
        await page.clock.fastForward(2_000);
        await feedback.waitFor({ state: "hidden" });
        await expect.poll(() => copy.getAttribute("aria-label")).toBe("Copy as markdown");
      } finally {
        await suite.closeBrowserContext(context);
      }
    },
  );
});
