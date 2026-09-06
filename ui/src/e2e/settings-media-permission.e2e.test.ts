import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import {
  installMockGateway,
  waitForControlUiSettingsTakeover,
} from "../test-helpers/control-ui-e2e.ts";
import {
  captureSettingsSidebarUiProof,
  captureSidebarUiProof,
  createSidebarCustomizationSuite,
} from "./sidebar-customization.test-support.ts";

const suite = createSidebarCustomizationSuite("Settings media permission lifetime");

type MediaEvent = {
  type: "enumerate" | "resolve" | "reject" | "probe" | "stop" | "pointer";
  route: string;
  id?: number;
  constraints?: MediaStreamConstraints;
  trusted?: boolean;
  kind?: string;
};
declare global {
  interface Window {
    settingsMediaProof: {
      events: MediaEvent[];
      settle: (id: number, reject?: boolean) => void;
    };
  }
}

async function installMediaBoundary(page: Page, holdRecoveryEnumeration: boolean) {
  await page.addInitScript(
    ({ holdRecovery }) => {
      const recordedEvents: MediaEvent[] = [];
      const pending = new Map<
        number,
        { resolve: (devices: MediaDeviceInfo[]) => void; reject: () => void }
      >();
      const granted = new Set<string>();
      let sequence = 0;
      const record = (event: Omit<MediaEvent, "route">) =>
        recordedEvents.push({ ...event, route: location.pathname });
      const devices = () =>
        [...granted].map((kind) => ({
          deviceId: `synthetic-${kind}`,
          groupId: "synthetic-media-proof",
          kind,
          label: kind === "audioinput" ? "Synthetic microphone" : "Synthetic camera",
          toJSON: () => ({}),
        })) as MediaDeviceInfo[];
      const media = new EventTarget();
      Object.assign(media, {
        enumerateDevices: () => {
          const id = ++sequence;
          record({ type: "enumerate", id });
          if (id <= 2 || (holdRecovery && id === 3)) {
            return new Promise<MediaDeviceInfo[]>((resolve, reject) => {
              pending.set(id, {
                resolve,
                reject: () =>
                  reject(new DOMException("Synthetic enumeration failure", "InvalidStateError")),
              });
            });
          }
          return Promise.resolve(devices());
        },
        getUserMedia: (constraints: MediaStreamConstraints) => {
          record({ type: "probe", constraints });
          const kind = constraints.audio ? "audioinput" : "videoinput";
          granted.add(kind);
          return Promise.resolve({
            getTracks: () => [{ stop: () => record({ type: "stop", kind }) }],
          });
        },
      });
      Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: media });
      document.addEventListener(
        "pointerdown",
        (event) => {
          const target = event.target;
          if (
            target instanceof HTMLSelectElement &&
            target.matches(".settings-select--media-device")
          ) {
            record({
              type: "pointer",
              trusted: event.isTrusted,
              kind: target.hasAttribute("data-settings-microphone") ? "audioinput" : "videoinput",
            });
          }
        },
        true,
      );
      window.settingsMediaProof = {
        events: recordedEvents,
        settle(id, reject = false) {
          const operation = pending.get(id);
          if (!operation) {
            throw new Error(`No pending media enumeration ${id}`);
          }
          pending.delete(id);
          record({ type: reject ? "reject" : "resolve", id });
          if (reject) {
            operation.reject();
          } else {
            operation.resolve(devices());
          }
        },
      };
    },
    { holdRecovery: holdRecoveryEnumeration },
  );
}

async function events(page: Page) {
  return page.evaluate(() => [...window.settingsMediaProof.events]);
}

async function settle(page: Page, enumerationId: number, rejectEnumeration = false) {
  return page.evaluate(
    ({ id, reject }) => {
      const owner = document.querySelector("openclaw-config-page");
      const pageId = owner ? Reflect.get(owner, "pageId") : undefined;
      const surface = {
        route: location.pathname,
        ownerConnected: owner?.isConnected ?? false,
        ownerPageId: typeof pageId === "string" ? pageId : null,
        pageTitle:
          owner?.querySelector(".content-header--settings .page-title")?.textContent?.trim() ??
          null,
        appearancePickerCount: document.querySelectorAll(".settings-select--media-device").length,
      };
      // Record the rendered owner in the same browser task that releases the held API.
      window.settingsMediaProof.settle(id, reject);
      return surface;
    },
    { id: enumerationId, reject: rejectEnumeration },
  );
}

async function renderedAfterMediaSettlement(page: Page) {
  // The held API promises, immediate synthetic stream and re-enumeration are all
  // microtasks. Cross a rendered frame after that finite chain; no product state
  // or permission flag is read or changed to manufacture completion.
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
}

suite.define(() => {
  for (const kind of ["microphone", "camera"] as const) {
    for (const transition of ["route leave", "disconnect", "second await", "stay"] as const) {
      it(`${kind}: ${transition}`, async () => {
        const caseId = `${kind}-${transition.replaceAll(" ", "-")}`;
        const artifactDir = suite.artifactDir;
        const context = await suite.newBrowserContext({
          locale: "en-US",
          serviceWorkers: "block",
          viewport: { height: 1000, width: 1440 },
          recordVideo: { dir: artifactDir, size: { height: 1000, width: 1440 } },
        });
        const page = await context.newPage();
        const record: Record<string, unknown> = {
          schema: "openclaw-settings-media-permission-proof-v1",
          caseId,
          kind,
          transition,
          status: "fail",
          boundary: "synthetic MediaDevices; native permission UI not exercised",
        };
        let gateway: Awaited<ReturnType<typeof installMockGateway>> | undefined;
        try {
          await installMediaBoundary(page, transition === "second await");
          gateway = await installMockGateway(page);
          await page.goto(`${suite.server.baseUrl}new`);
          await page.locator(".new-session-page__message").waitFor({ state: "visible" });
          await page.keyboard.press("Control+Shift+,");
          let { sidebar } = await waitForControlUiSettingsTakeover(page);
          const configOwner = await page.locator("openclaw-config-page").elementHandle();
          expect(configOwner).not.toBeNull();
          record.ownerConnectedAtGesture = await configOwner!.evaluate(
            (element) => element.isConnected,
          );
          expect(record.ownerConnectedAtGesture).toBe(true);
          await expect
            .poll(() =>
              events(page).then((rows) => rows.filter((row) => row.type === "enumerate").length),
            )
            .toBe(2);
          const picker = () => page.locator(`select[data-settings-${kind}]`);
          const proofSurface = page.locator(".shell");
          await picker().click();
          await page.keyboard.press("Escape");
          expect(new URL(page.url()).pathname).toBe("/settings/appearance");
          await captureSettingsSidebarUiProof(suite, sidebar, "appearance-sidebar.png");
          await captureSidebarUiProof(suite, page, "appearance-pending.png", proofSurface, [
            picker(),
          ]);
          const target = kind === "microphone" ? 1 : 2;
          const other = target === 1 ? 2 : 1;
          await settle(page, other);
          if (transition === "second await") {
            await settle(page, target, true);
            await expect
              .poll(() =>
                events(page).then((rows) => rows.filter((row) => row.type === "enumerate").length),
              )
              .toBe(3);
          }
          if (transition === "disconnect") {
            await sidebar.locator(".settings-sidebar__item").first().focus();
            await page.keyboard.press("Escape");
            await page.locator(".new-session-page__message").waitFor({ state: "visible" });
            expect(new URL(page.url()).pathname).toBe("/new");
          } else if (transition !== "stay") {
            await sidebar.locator('a[href="/settings/advanced"]').click();
            await expect.poll(() => new URL(page.url()).pathname).toBe("/settings/advanced");
            // History moves before the route module and Lit view commit. Retire the
            // actual Appearance surface before releasing its pending enumeration.
            const pageTitle = page.locator(
              "openclaw-config-page .content-header--settings .page-title",
            );
            await pageTitle.waitFor({ state: "visible" });
            await expect.poll(() => pageTitle.textContent()).toBe("Advanced");
            await expect.poll(() => page.locator(".settings-select--media-device").count()).toBe(0);
          }
          record.exitRoute = new URL(page.url()).pathname;
          record.ownerConnectedAfterExit = await configOwner!.evaluate(
            (element) => element.isConnected,
          );
          if (transition === "disconnect") {
            expect(record.ownerConnectedAfterExit).toBe(false);
          }
          const settlementSurface = await settle(page, transition === "second await" ? 3 : target);
          record.settlementSurface = settlementSurface;
          if (transition === "route leave" || transition === "second await") {
            expect(record.ownerConnectedAfterExit).toBe(true);
            expect(settlementSurface).toMatchObject({
              route: "/settings/advanced",
              ownerConnected: true,
              ownerPageId: "advanced",
              pageTitle: "Advanced",
              appearancePickerCount: 0,
            });
          }
          await renderedAfterMediaSettlement(page);
          record.eventsAfterSettlement = await events(page);
          record.probesAfterSettlement = (await events(page)).filter(
            (row) => row.type === "probe",
          ).length;
          const settledContent = page.locator(
            transition === "disconnect"
              ? ".new-session-page__message"
              : "openclaw-config-page .content-header--settings .page-title",
          );
          await captureSidebarUiProof(suite, page, "settled-surface.png", proofSurface, [
            settledContent,
          ]);
          if (transition !== "stay") {
            if (transition === "disconnect") {
              await page.keyboard.press("Control+Shift+,");
              ({ sidebar } = await waitForControlUiSettingsTakeover(page));
            } else {
              await sidebar.locator('a[href="/settings/appearance"]').click();
            }
            await picker().waitFor({ state: "visible" });
            await renderedAfterMediaSettlement(page);
            record.probesBeforeFreshGesture = (await events(page)).filter(
              (row) => row.type === "probe",
            ).length;
            await picker().click();
            await page.keyboard.press("Escape");
            await renderedAfterMediaSettlement(page);
          }
          record.finalEvents = await events(page);
          record.finalRoute = new URL(page.url()).pathname;
          await captureSidebarUiProof(suite, page, "fresh-gesture-result.png", proofSurface, [
            picker(),
          ]);
          const rows = await events(page);
          const probes = rows.filter((row) => row.type === "probe");
          const pointers = rows.filter((row) => row.type === "pointer");
          expect(pointers.length).toBe(transition === "stay" ? 1 : 2);
          expect(pointers.every((row) => row.trusted)).toBe(true);
          expect(probes.map((probe) => probe.constraints)).toEqual([
            kind === "microphone" ? { audio: true } : { video: true },
          ]);
          expect(rows.filter((row) => row.type === "stop")).toHaveLength(1);
          expect(record.probesAfterSettlement).toBe(transition === "stay" ? 1 : 0);
          if (transition !== "stay") {
            expect(record.probesBeforeFreshGesture).toBe(0);
          }
          expect(record.finalRoute).toBe("/settings/appearance");
          record.status = "pass";
        } catch (error) {
          record.error = error instanceof Error ? error.message : String(error);
          throw error;
        } finally {
          record.requests = gateway ? await gateway.getRequests() : [];
          record.finalEvents ??= await events(page).catch(() => []);
          try {
            await suite.closeBrowserContext(context);
            record.contextClosed = true;
          } finally {
            await writeFile(
              path.join(artifactDir, "observations.json"),
              `${JSON.stringify(record, null, 2)}\n`,
            );
          }
        }
      });
    }
  }
});
