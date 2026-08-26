import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Control UI warm owner-first refresh" });
const captureProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const proofDir = path.join(process.cwd(), ".artifacts", "control-ui-e2e", "session-owner-warm");

function sessionRow(ownerId: string, key: string, label: string, updatedAt: number) {
  const owner = {
    type: "human" as const,
    id: ownerId,
    label: ownerId === "profile-ada" ? "Ada" : "Bob",
  };
  return {
    key,
    kind: "direct" as const,
    label,
    createdActor: owner,
    owner: { actor: owner },
    updatedAt,
  };
}

function rosterOf(sessions: ReturnType<typeof sessionRow>[]) {
  return {
    count: sessions.length,
    owners: sessions.map((session) => session.owner.actor),
    defaults: { contextTokens: null, model: null, modelProvider: null },
    path: "",
    sessions,
    ts: 1,
  };
}

async function captureSidebar(page: Page, fileName: string) {
  if (!captureProof) {
    return;
  }
  await mkdir(proofDir, { recursive: true });
  await page.locator(".sidebar-sessions").screenshot({
    animations: "disabled",
    path: path.join(proofDir, fileName),
  });
}

suite.define(() => {
  it("keeps foreign-owned rows visible while a warm refresh's shared phase is in flight", async () => {
    const context = await suite.browser.newContext({
      viewport: { height: 800, width: 1200 },
      ...(captureProof
        ? { recordVideo: { dir: proofDir, size: { height: 800, width: 1200 } } }
        : {}),
    });
    const page = await context.newPage();
    const adaRow = sessionRow("profile-ada", "agent:main:ada", "Ada research", 2);
    const bobRow = sessionRow("profile-bob", "agent:main:bob", "Bob operations", 1);
    const sharedRoster = rosterOf([adaRow, bobRow]);
    const ownerRoster = rosterOf([adaRow]);
    const gateway = await installMockGateway(page, {
      presenceUsers: [{ self: true, id: "profile-ada", name: "Ada" }],
      sessionKey: "agent:main:ada",
      methodResponses: {
        "sessions.list": {
          cases: [
            { match: { ownerId: "profile-ada" }, response: ownerRoster },
            { response: sharedRoster },
          ],
        },
      },
    });

    try {
      await page.goto(`${suite.server?.baseUrl ?? ""}chat`);
      const ada = page.locator('[data-session-key="agent:main:ada"]');
      const bob = page.locator('[data-session-key="agent:main:bob"]');
      await ada.waitFor();
      await bob.waitFor();
      await captureSidebar(page, "warm-before-event.png");

      // Hold the warm refresh open at its vulnerable point: the owner-scoped
      // request resolves instantly (mocked response), the shared request stays
      // deferred. Pre-#129558 the owner-only publish blanks Bob's row here.
      const before = (await gateway.getRequests("sessions.list")).length;
      await gateway.deferNext("sessions.list", { ownerId: "profile-ada" });
      await gateway.deferNext("sessions.list");
      await gateway.emitGatewayEvent("sessions.changed", {
        sessionKey: adaRow.key,
        key: adaRow.key,
        kind: "direct",
        reason: "create",
        updatedAt: 3,
      });
      await gateway.waitForRequest("sessions.list", { after: before + 1 });
      await gateway.resolveDeferred("sessions.list", ownerRoster);

      // The shared phase is still pending; the roster on screen must not shrink
      // to the owner window. Sample repeatedly so a transient blank fails loud.
      for (let sample = 0; sample < 6; sample += 1) {
        await page.waitForTimeout(100);
        expect(await bob.count()).toBe(1);
        expect(await ada.count()).toBe(1);
      }
      await captureSidebar(page, "warm-shared-deferred.png");

      await gateway.resolveDeferred("sessions.list", sharedRoster);
      await expect.poll(() => bob.count()).toBe(1);
      expect(await ada.count()).toBe(1);
      await captureSidebar(page, "warm-after-merge.png");
    } finally {
      await context.close();
    }
  });
});
