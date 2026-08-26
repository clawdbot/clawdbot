import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import type { ApplicationContext } from "../app/context.ts";
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

      // Hold the warm refresh open at its vulnerable point: release the
      // owner-scoped response while the shared response remains deferred.
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
      const ownerProbe = await page.evaluateHandle(() => {
        const app = document.querySelector<
          HTMLElement & { runtime?: { context: ApplicationContext } }
        >("openclaw-app");
        const sidebar = document.querySelector<HTMLElement & { updateComplete: Promise<boolean> }>(
          "openclaw-app-sidebar",
        );
        const sessions = app?.runtime?.context.sessions;
        const row = sidebar?.querySelector('[data-session-key="agent:main:bob"]');
        const scope = sessions?.captureConnectionScope();
        if (!sidebar || !sessions || !row || !scope) {
          throw new Error("The warm session owner or sidebar is unavailable");
        }
        let removed = false;
        const observer = new MutationObserver((records) => {
          removed ||= records.some(({ removedNodes }) =>
            Array.from(removedNodes).some((node) => node === row || node.contains(row)),
          );
        });
        observer.observe(sidebar, { childList: true, subtree: true });
        return {
          observer,
          revision: sessions.canonicalListRevision,
          row,
          scope,
          sessions,
          sidebar,
          wasRemoved: () => removed,
        };
      });
      await gateway.resolveDeferred("sessions.list", ownerRoster);

      const ownerPhase = await ownerProbe.evaluate(async (probe) => {
        await new Promise<void>((resolve) => {
          requestAnimationFrame(() => resolve());
        });
        await probe.sidebar.updateComplete;
        return {
          connected: probe.sessions.isConnectionScopeCurrent(probe.scope),
          loading: probe.sessions.state.loading,
          revisionAdvanced: probe.sessions.canonicalListRevision !== probe.revision,
          rowConnected: probe.row.isConnected,
          rowRemoved: probe.wasRemoved(),
        };
      });
      expect(ownerPhase).toEqual({
        connected: true,
        loading: true,
        revisionAdvanced: false,
        rowConnected: true,
        rowRemoved: false,
      });
      expect(
        (await gateway.getRequests("sessions.list"))
          .slice(before)
          .map((request) => (request.params as { ownerId?: string }).ownerId ?? null),
      ).toEqual(["profile-ada", null]);

      for (let sample = 0; sample < 6; sample += 1) {
        expect(await bob.count()).toBe(1);
        expect(await ada.count()).toBe(1);
      }
      await captureSidebar(page, "warm-shared-deferred.png");

      await gateway.resolveDeferred("sessions.list", sharedRoster);
      const sharedPhase = await ownerProbe.evaluate(async (probe) => {
        if (probe.sessions.canonicalListRevision === probe.revision) {
          await new Promise<void>((resolve) => {
            const unsubscribe = probe.sessions.subscribe(() => {
              if (probe.sessions.canonicalListRevision > probe.revision) {
                unsubscribe();
                resolve();
              }
            });
            if (probe.sessions.canonicalListRevision > probe.revision) {
              unsubscribe();
              resolve();
            }
          });
        }
        await probe.sidebar.updateComplete;
        probe.observer.disconnect();
        return {
          connected: probe.sessions.isConnectionScopeCurrent(probe.scope),
          loading: probe.sessions.state.loading,
          revisionAdvanced: probe.sessions.canonicalListRevision > probe.revision,
          rowConnected: probe.row.isConnected,
          rowRemoved: probe.wasRemoved(),
        };
      });
      expect(sharedPhase).toEqual({
        connected: true,
        loading: false,
        revisionAdvanced: true,
        rowConnected: true,
        rowRemoved: false,
      });
      await expect.poll(() => bob.count()).toBe(1);
      expect(await ada.count()).toBe(1);
      await captureSidebar(page, "warm-after-merge.png");
      await ownerProbe.dispose();
    } finally {
      await context.close();
    }
  });
});
