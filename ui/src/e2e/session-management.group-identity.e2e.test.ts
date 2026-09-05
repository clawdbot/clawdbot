import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Locator } from "playwright";
import { expect, it } from "vitest";
import { takeControlUiViewportScreenshot } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { createControlUiSessionRow as sessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import {
  activateSelfRemovingControl,
  captureUiProofEnabled,
  controlUiSessionUrl,
  createSessionManagementE2eSuite,
  installMockGateway,
  openSessionMenuSubmenu,
  requireRecord,
  sessionsListResponse,
} from "./session-management.test-support.ts";

const suite = createSessionManagementE2eSuite();

suite.define(() => {
  it.each(["sessions", "sidebar", "selection", "header"] as const)(
    "keeps a replacement unchanged during a pending %s new-group assignment",
    async (surface) => {
      const viewport = { width: 1280, height: 900 };
      const context = await suite.newBrowserContext({
        locale: "en-US",
        serviceWorkers: "block",
        viewport,
        recordVideo: captureUiProofEnabled
          ? { dir: path.join(suite.artifactDir, "group-identity-20260827"), size: viewport }
          : undefined,
      });
      const page = await context.newPage();
      const video = page.video();
      const original = sessionRow("agent:main:group-identity", "Original session", Date.now(), {
        sessionId: "original-session",
      });
      const survivor = sessionRow("agent:main:group-survivor", "Surviving session", Date.now());
      const replacement = {
        ...original,
        sessionId: "replacement-session",
        label: "Replacement session",
        displayName: "Replacement session",
        updatedAt: original.updatedAt + 1_000,
      };
      const group = "Selected work";
      const batch = surface === "selection";
      const method = batch ? "sessions.patchMany" : "sessions.patch";
      const gateway = await installMockGateway(page, {
        deferredMethods: ["sessions.groups.put", method],
        methodResponses: { "sessions.list": sessionsListResponse([original, survivor]) },
        sessionKey: original.key,
      });
      const capture = async (stage: string, proofSurface: Locator, content: readonly Locator[]) => {
        if (captureUiProofEnabled) {
          await mkdir(path.join(suite.artifactDir, "group-identity-20260827"), { recursive: true });
          await writeFile(
            path.join(
              path.join(suite.artifactDir, "group-identity-20260827"),
              `${surface}-${stage}.png`,
            ),
            await takeControlUiViewportScreenshot(page, proofSurface, content),
          );
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
        if (batch) {
          for (const key of [original.key, survivor.key]) {
            await page
              .locator(`[data-session-key="${key}"] .sidebar-recent-session__link`)
              .click({ modifiers: ["Alt"] });
          }
          await expect
            .poll(() => page.locator(".sidebar-recent-session--selected").count())
            .toBe(2);
        }
        if (surface === "header") {
          await page.locator(".chat-header-session-menu__trigger").click();
        } else {
          await row.hover();
          await row.getByRole("button", { name: "Open session menu" }).click();
        }
        await openSessionMenuSubmenu(page, batch ? "Move 2 to group" : "Move to group");
        await activateSelfRemovingControl(page.getByRole("menuitem", { name: "New group" }));
        const input = page.getByLabel("New group name");
        await input.fill(group);
        await capture("editing", page.locator("openclaw-modal-dialog dialog"), [input]);
        await input.press("Enter");
        await gateway.waitForRequest("sessions.groups.put");

        // Deletion/recreation changes the durable identity, unlike ordinary reset.
        await gateway.setSessionsListResponse(sessionsListResponse([replacement, survivor]));
        await gateway.emitGatewayEvent("sessions.changed", {
          ...replacement,
          sessionKey: original.key,
          reason: "create",
        });
        await expect.poll(() => row.textContent()).toContain(replacement.label);
        await gateway.resolveDeferred("sessions.groups.put");
        const request = await gateway.waitForRequest(method);
        const params = requireRecord(request.params);
        const targets =
          batch && Array.isArray(params.targets) ? params.targets.map(requireRecord) : [params];
        const acceptedKeys: string[] = [];
        // Replay the existing Gateway CAS contract, not the UI's intended result.
        // The generic mock otherwise accepts every metadata write unconditionally.
        const outcomes = targets.map((target) => {
          const current = target.key === original.key ? replacement : survivor;
          if (target.expectedSessionId && target.expectedSessionId !== current.sessionId) {
            return {
              ok: false,
              key: target.key,
              agentId: target.agentId,
              error: {
                code: "INVALID_REQUEST",
                message: `Session ${String(target.key)} changed before patch. Retry.`,
                details: { reason: "session-changed" },
              },
            };
          }
          acceptedKeys.push(String(target.key));
          return { ok: true, key: target.key, agentId: target.agentId };
        });
        if (batch) {
          await gateway.setMethodResponse(method, { outcomes });
          await gateway.resolveDeferred(method);
        } else if (outcomes[0]?.error) {
          await gateway.rejectDeferred(method, outcomes[0].error);
        } else {
          await gateway.resolveDeferred(method);
        }
        const failure =
          surface === "header"
            ? page.getByText(/changed before patch\. Retry\./).first()
            : page.locator('openclaw-modal-dialog [role="alert"]');
        if (acceptedKeys.includes(original.key)) {
          await input.waitFor({ state: "detached" });
          await page
            .locator(
              `[data-session-section="category:${group}"] [data-session-key="${original.key}"]`,
            )
            .waitFor({ state: "visible" });
        } else {
          await failure.waitFor({ state: "visible" });
        }
        await capture(
          acceptedKeys.includes(original.key) ? "incorrectly-moved" : "rejected",
          !acceptedKeys.includes(original.key) && surface !== "header"
            ? page.locator("openclaw-modal-dialog dialog")
            : page.locator(".shell"),
          [acceptedKeys.includes(original.key) ? row : failure],
        );

        expect(acceptedKeys).not.toContain(original.key);
        expect(targets.find((target) => target.key === original.key)).toMatchObject({
          expectedSessionId: original.sessionId,
        });
        expect(await failure.textContent()).toContain("changed before patch. Retry.");
        if (batch) {
          expect(acceptedKeys).toEqual([survivor.key]);
          await page
            .locator(
              `[data-session-section="category:${group}"] [data-session-key="${survivor.key}"]`,
            )
            .waitFor({ state: "visible" });
        }
        expect(
          await page
            .locator(
              `[data-session-section="category:${group}"] [data-session-key="${original.key}"]`,
            )
            .count(),
        ).toBe(0);
        if (surface !== "header") {
          await page.getByRole("button", { name: "Cancel", exact: true }).click();
        }
        await input.waitFor({ state: "detached" });
        await capture("unchanged", page.locator(".shell"), [row]);
      } finally {
        await suite.closeBrowserContext(context);
        if (video) {
          await video.saveAs(
            path.join(path.join(suite.artifactDir, "group-identity-20260827"), `${surface}.webm`),
          );
        }
      }
    },
  );
});
