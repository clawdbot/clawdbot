import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import { expect, it } from "vitest";
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

suite.define(() => {
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

        const artifactDir = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();
        if (artifactDir) {
          await mkdir(artifactDir, { recursive: true });
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
      await expect
        .poll(() => button.locator(".code-block-copy__idle").textContent())
        .toBe("Copy failed");
      expect(await readClipboardFailureProof(page)).toEqual({
        asyncAttempts: 1,
        legacyAttempts: 1,
        value: code,
      });
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);

      const artifactDir = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();
      if (artifactDir) {
        await mkdir(artifactDir, { recursive: true });
        await page.screenshot({
          fullPage: true,
          path: path.join(artifactDir, "clipboard-assistant-code-failure.png"),
        });
      }

      await expect.poll(() => button.getAttribute("aria-label")).toBe("Copy code");
      await expect.poll(() => button.locator(".code-block-copy__idle").textContent()).toBe("Copy");
    } finally {
      await suite.closeBrowserContext(context);
    }
  });
});
