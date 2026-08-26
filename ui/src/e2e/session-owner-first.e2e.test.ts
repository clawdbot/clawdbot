import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Control UI owner-first session roster" });
const captureProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const proofDir = path.join(process.cwd(), ".artifacts", "control-ui-e2e", "session-owner-stack");

function sessionRoster(ownerId: string, key: string, label: string, updatedAt: number) {
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

function sessionsList() {
  const sessions = [
    sessionRoster("profile-ada", "agent:main:ada", "Ada research", 2),
    sessionRoster("profile-bob", "agent:main:bob", "Bob operations", 1),
  ];
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
  it("publishes the signed-in owner's sessions before the shared roster", async () => {
    const context = await suite.browser.newContext({ viewport: { height: 800, width: 1200 } });
    const page = await context.newPage();
    const sharedRoster = sessionsList();
    const ownerRoster = {
      ...sharedRoster,
      count: 1,
      owners: sharedRoster.owners.slice(0, 1),
      sessions: sharedRoster.sessions.slice(0, 1),
    };
    const gateway = await installMockGateway(page, {
      deferredMethods: ["sessions.list", "sessions.list"],
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
      await expect
        .poll(async () => (await gateway.getRequests("sessions.list")).length)
        .toBeGreaterThanOrEqual(2);
      expect(
        (await gateway.getRequests("sessions.list")).some(
          (request) =>
            (request.params as { ownerId?: unknown } | undefined)?.ownerId === "profile-ada",
        ),
      ).toBe(true);
      await gateway.resolveDeferred("sessions.list", ownerRoster);

      const adaRow = page.locator('[data-session-key="agent:main:ada"]');
      const bobRow = page.locator('[data-session-key="agent:main:bob"]');
      await adaRow.waitFor();
      await expect.poll(() => bobRow.count()).toBe(0);
      await captureSidebar(page, "owner-first-roster.png");

      await gateway.resolveDeferred("sessions.list", sharedRoster);
      await bobRow.waitFor();
      await expect.poll(() => adaRow.count()).toBe(1);
      await captureSidebar(page, "owner-first-shared-roster.png");
    } finally {
      await context.close();
    }
  });
});
