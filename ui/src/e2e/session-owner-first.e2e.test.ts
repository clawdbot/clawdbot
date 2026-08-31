import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import { SIDEBAR_SESSION_ROSTER_LIMIT } from "../../../src/shared/session-list-limits.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Control UI owner-first session roster" });
const captureProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";

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
  await mkdir(path.join(suite.artifactDir, "session-owner-stack"), { recursive: true });
  await page.locator(".sidebar-sessions").screenshot({
    animations: "disabled",
    path: path.join(path.join(suite.artifactDir, "session-owner-stack"), fileName),
  });
}

suite.define(() => {
  it("hydrates the owner-first roster with the event subscription", async () => {
    const context = await suite.browser.newContext({ viewport: { height: 800, width: 1200 } });
    const page = await context.newPage();
    const sharedRoster = sessionsList();
    const gateway = await installMockGateway(page, {
      deferredMethods: ["sessions.subscribe"],
      presenceUsers: [{ self: true, id: "profile-ada", name: "Ada" }],
      sessionKey: "agent:main:ada",
      methodResponses: { "sessions.subscribe": { subscribed: true, list: sharedRoster } },
    });

    try {
      // A literal key avoids the independent slug lookup while the roster is deferred.
      await page.goto(`${suite.server?.baseUrl ?? ""}chat/main/~key/ada`);
      const subscribe = await gateway.waitForRequest("sessions.subscribe");
      expect(subscribe.params).toEqual(
        expect.objectContaining({ ownerFirst: true, limit: SIDEBAR_SESSION_ROSTER_LIMIT }),
      );
      const adaRow = page.locator('[data-session-key="agent:main:ada"]');
      const bobRow = page.locator('[data-session-key="agent:main:bob"]');
      // The selected session has an optimistic placeholder before roster hydration.
      await expect.poll(() => adaRow.count()).toBe(1);
      await expect.poll(() => bobRow.count()).toBe(0);
      expect(await gateway.getRequests("sessions.list")).toHaveLength(0);

      await gateway.resolveDeferred("sessions.subscribe", { subscribed: true, list: sharedRoster });
      await adaRow.waitFor();
      await bobRow.waitFor();
      expect(await gateway.getRequests("sessions.list")).toHaveLength(0);
      await captureSidebar(page, "owner-first-bootstrap.png");
    } finally {
      await context.close();
    }
  });
});
