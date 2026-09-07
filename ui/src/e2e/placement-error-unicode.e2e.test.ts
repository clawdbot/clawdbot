import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect } from "playwright/test";
import { it } from "vitest";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import {
  createdSessionListResult,
  installMockGateway,
  waitForCommittedChatRoute,
} from "./new-session-page.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Placement error Unicode boundary" });
const storagePrefix = "openclaw.new-session.session-placement-recovery.v1:";
const storageWarning = "Recovery could not be saved in this tab. Keep this page open.\n";

suite.define(() => {
  it.each([false, true])(
    "retains a readable bounded dispatch failure (pause write fails: %s)",
    async (writeFails) => {
      const viewport = { width: 1280, height: 900 };
      await suite.withPage(
        { viewport, recordVideo: { dir: suite.artifactDir, size: viewport } },
        async ({ page }) => {
          const sessionKey = "agent:cloud:unicode-placement-proof";
          const message = "Keep this task after a Unicode placement failure";
          const lead = "Unicode placement diagnostic: ";
          const prefix = writeFails ? storageWarning : "";
          const retained = `${lead}${"x".repeat(4095 - prefix.length - lead.length)}`;
          const diagnostic = `${retained}🤖`;
          const gateway = await installMockGateway(page, {
            defaultAgentId: "cloud",
            deferredMethods: ["sessions.dispatch"],
            workspaceGit: true,
            methodResponses: {
              "agents.list": {
                agents: [
                  { id: "cloud", name: "Cloud", workspace: "/workspace", workspaceGit: true },
                ],
                defaultId: "cloud",
                mainKey: "main",
                scope: "agent",
              },
              "environments.list": {
                environments: [],
                profiles: [{ id: "aws", providerId: "crabbox" }],
              },
              "worktrees.branches": {
                branches: [{ kind: "local", name: "main" }],
                defaultBranch: "main",
                repositoryStatus: "git",
              },
              "sessions.create": { key: sessionKey },
              "sessions.list": createdSessionListResult(sessionKey),
              "sessions.describe": { session: {} },
              "chat.history": {
                messages: [],
                sessionInfo: { hasActiveRun: false, status: "done" },
              },
            },
          });
          await page.goto(`${suite.server.baseUrl}new`);
          await gateway.waitForRequest("environments.list");
          await page.locator("#new-session-where-trigger").click();
          await page
            .locator("wa-popover.new-session-page__where-popover")
            .getByRole("button", { name: "Cloud · aws" })
            .click();
          await page.locator(".new-session-page__message").fill(message);
          await page.getByRole("button", { name: "Start session" }).click();
          await gateway.waitForRequest("sessions.dispatch");
          await waitForCommittedChatRoute(page);
          if (writeFails) {
            await page.evaluate((recoveryKeyPrefix) => {
              const setSessionItem = sessionStorage.setItem.bind(sessionStorage);
              const setLocalItem = localStorage.setItem.bind(localStorage);
              Storage.prototype.setItem = function (key: string, value: string) {
                if (this === sessionStorage) {
                  if (key.startsWith(recoveryKeyPrefix) && JSON.parse(value).phase === "paused") {
                    throw new DOMException("quota exceeded", "QuotaExceededError");
                  }
                  setSessionItem(key, value);
                } else {
                  setLocalItem(key, value);
                }
              };
            }, storagePrefix);
          }
          await gateway.rejectDeferred("sessions.dispatch", {
            code: "INVALID_REQUEST",
            message: diagnostic,
          });
          const alert = page.getByRole("alert").filter({ hasText: lead });
          await expect(alert).toBeVisible();
          await alert.locator("summary").click();
          const detail = alert.locator("pre");
          await expect(detail).toBeVisible();
          const rendered = await detail.textContent();
          const renderedWellFormed =
            rendered === null ? undefined : !/[\uD800-\uDFFF]/u.test(rendered);
          await alert.scrollIntoViewIfNeeded();
          await detail.evaluate((element) => element.scrollTo(0, element.scrollHeight));
          await expect
            .poll(() =>
              detail.evaluate((element) => {
                const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
                let tail: Node | null = null;
                while (walker.nextNode()) {
                  if (walker.currentNode.textContent) {
                    tail = walker.currentNode;
                  }
                }
                if (!tail?.textContent) {
                  return false;
                }
                const range = document.createRange();
                range.setStart(tail, tail.textContent.length - 1);
                range.setEnd(tail, tail.textContent.length);
                const ending = range.getBoundingClientRect();
                const bounds = element.getBoundingClientRect();
                return (
                  ending.width > 0 &&
                  ending.height > 0 &&
                  ending.top >= Math.max(bounds.top, 0) &&
                  ending.bottom <= Math.min(bounds.bottom, window.innerHeight) &&
                  ending.left >= Math.max(bounds.left, 0) &&
                  ending.right <= Math.min(bounds.right, window.innerWidth)
                );
              }),
            )
            .toBe(true);
          await page.screenshot({ path: path.join(suite.artifactDir, "paused-error.png") });
          await writeFile(
            path.join(suite.artifactDir, "diagnostic.json"),
            JSON.stringify(
              {
                writeFails,
                inputLength: diagnostic.length,
                expectedBoundedLength: (prefix + retained).length,
                renderedLength: rendered?.length,
                renderedWellFormed,
                renderedTailCodeUnits: rendered
                  ?.slice(-4)
                  .split("")
                  .map((unit) => unit.charCodeAt(0)),
              },
              null,
              2,
            ),
          );
          if (!renderedWellFormed) {
            throw new Error(
              "PLACEMENT_ERROR_UTF16_SPLIT_137649: rendered pause diagnostic contains a split surrogate",
            );
          }
          expect(rendered).toContain(prefix + retained);
          expect(rendered).not.toContain("🤖");
          const failed = page.locator(".chat-group.user", { hasText: message });
          await expect(failed).toBeVisible();
          await expect(failed.locator(".chat-send-status")).toContainText("Not sent");
          await expect(failed.getByRole("button", { name: "Retry queued message" })).toBeVisible();
          expect(await gateway.getRequests("sessions.send")).toHaveLength(0);
          expect(await gateway.getRequests("sessions.delete")).toHaveLength(0);
          if (!writeFails) {
            const saved = await page.evaluate(
              ({ prefix: recoveryKeyPrefix, sessionKey: expectedSessionKey }) => {
                const rows = Object.keys(sessionStorage).filter((key) =>
                  key.startsWith(recoveryKeyPrefix),
                );
                return rows
                  .map((key) => JSON.parse(sessionStorage.getItem(key) ?? "null"))
                  .find((row) => row?.sessionKey === expectedSessionKey);
              },
              { prefix: storagePrefix, sessionKey },
            );
            expect(saved).toMatchObject({ phase: "paused", message, error: retained });
            await page.reload();
            await expect(failed).toBeVisible();
            await expect(page.getByRole("alert").filter({ hasText: lead })).toBeVisible();
            expect(await gateway.getRequests("sessions.dispatch")).toHaveLength(0);
            expect(await gateway.getRequests("sessions.send")).toHaveLength(0);
          }
        },
      );
    },
  );
});
