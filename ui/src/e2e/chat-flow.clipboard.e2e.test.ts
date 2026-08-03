import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { createChatFlowE2eSuite, installMockGateway } from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();

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
        expect(
          await page.evaluate(
            () =>
              (
                globalThis as typeof globalThis & {
                  clipboardFailureProof: {
                    asyncAttempts: number;
                    legacyAttempts: number;
                    value: string;
                  };
                }
              ).clipboardFailureProof,
          ),
        ).toEqual({ asyncAttempts: 1, legacyAttempts: 1, value });
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
});
