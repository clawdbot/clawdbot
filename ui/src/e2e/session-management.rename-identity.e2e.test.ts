import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { createControlUiSessionRow as sessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import {
  captureUiProofEnabled,
  controlUiSessionUrl,
  createSessionManagementE2eSuite,
  installMockGateway,
  requireRecord,
  sessionsListResponse,
  waitForPatch,
} from "./session-management.test-support.ts";

const suite = createSessionManagementE2eSuite();

suite.define(() => {
  it.each(["sessions", "sidebar", "header"] as const)(
    "keeps a replacement session unchanged after a stale %s rename",
    async (surface) => {
      const viewport = { width: 1280, height: 900 };
      const context = await suite.browser.newContext({
        locale: "en-US",
        serviceWorkers: "block",
        viewport,
        recordVideo: captureUiProofEnabled
          ? { dir: path.join(suite.artifactDir, "session-identity-20260827"), size: viewport }
          : undefined,
      });
      const page = await context.newPage();
      const video = page.video();
      const original = sessionRow(
        "agent:main:rename-identity",
        "Original session",
        Date.parse("2026-08-27T12:00:00.000Z"),
      );
      const replacement = {
        ...original,
        sessionId: "replacement-session",
        label: "Replacement session",
        displayName: "Replacement session",
        updatedAt: original.updatedAt + 1_000,
      };
      const gateway = await installMockGateway(page, {
        deferredMethods: ["sessions.patch"],
        methodResponses: { "sessions.list": sessionsListResponse([original]) },
        sessionKey: original.key,
      });
      const capture = async (stage: string) => {
        if (captureUiProofEnabled) {
          await mkdir(path.join(suite.artifactDir, "session-identity-20260827"), {
            recursive: true,
          });
          await page.screenshot({
            path: path.join(
              path.join(suite.artifactDir, "session-identity-20260827"),
              `${surface}-${stage}.png`,
            ),
            animations: "disabled",
            fullPage: true,
          });
        }
      };

      try {
        await page.goto(
          surface === "sessions"
            ? `${suite.server.baseUrl}sessions`
            : controlUiSessionUrl(suite.server.baseUrl, original.key),
        );
        const row =
          surface === "sessions"
            ? page.locator(".sessions-table tbody tr", { hasText: original.key })
            : page.locator(`.sidebar-recent-session[data-session-key="${original.key}"]`);
        await row.waitFor({ state: "visible" });
        const openRename = async () => {
          if (surface === "header") {
            await page.locator(".chat-pane__session-title-button").click();
          } else {
            await row.hover();
            await row.getByRole("button", { name: "Open session menu" }).click();
            await page.getByRole("menuitem", { name: "Rename…" }).click();
          }
        };
        await openRename();
        const input = page.locator(
          surface === "header"
            ? ".chat-pane__session-title-input"
            : 'openclaw-modal-dialog[label="Rename session"] input',
        );
        await expect.poll(() => input.inputValue()).toBe(original.label);
        await input.fill("Stale rename");
        await capture("editing");

        await gateway.setMethodResponse("sessions.list", sessionsListResponse([replacement]));
        await gateway.emitGatewayEvent("sessions.changed", {
          ...replacement,
          sessionKey: original.key,
          reason: "create",
        });
        await expect.poll(() => row.textContent()).toContain(replacement.label);
        await input.press("Enter");
        const request = await waitForPatch(gateway, (params) => params.label === "Stale rename");
        const params = requireRecord(request.params);
        // Replay the Gateway's existing metadata CAS contract, covered by
        // server.sessions.patch-expected-identity.test.ts, without a new mock seam.
        if (params.expectedSessionId && params.expectedSessionId !== replacement.sessionId) {
          await gateway.rejectDeferred("sessions.patch", {
            code: "INVALID_REQUEST",
            message: `Session ${original.key} changed before patch. Retry.`,
            details: { reason: "session-changed" },
          });
        } else {
          await gateway.resolveDeferred("sessions.patch");
        }
        await input.waitFor({ state: "detached" });
        const outcome = page.getByText(/changed before patch\. Retry\.|Stale rename/, {
          exact: false,
        });
        await outcome.first().waitFor({ state: "visible" });
        await capture("outcome");
        await expect
          .poll(() => page.getByText(/changed before patch\. Retry\./).count())
          .toBeGreaterThan(0);
        expect(params).toMatchObject({
          key: original.key,
          expectedSessionId: original.sessionId,
          label: "Stale rename",
        });
        expect(await row.textContent()).toContain(replacement.label);
        expect(await page.getByText("Stale rename", { exact: true }).count()).toBe(0);

        await openRename();
        await expect.poll(() => input.inputValue()).toBe(replacement.label);
        await input.fill("Fresh rename");
        await input.press("Enter");
        const fresh = await waitForPatch(gateway, (next) => next.label === "Fresh rename");
        expect(fresh.params).toMatchObject({
          key: original.key,
          expectedSessionId: replacement.sessionId,
          label: "Fresh rename",
        });
        await expect.poll(() => row.textContent()).toContain("Fresh rename");
        await capture("recovered");
      } finally {
        await context.close();
        if (video) {
          await video.saveAs(
            path.join(path.join(suite.artifactDir, "session-identity-20260827"), `${surface}.webm`),
          );
        }
      }
    },
  );
});
