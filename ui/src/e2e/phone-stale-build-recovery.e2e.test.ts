// Phone stale-build proof covers artifact identity, reconnect retention, and service workers.
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, expect, it } from "vitest";
import { ConnectErrorDetailCodes } from "../../../packages/gateway-protocol/src/connect-error-details.js";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiViewportScreenshot } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  controlUiBundledGatewayUrl,
  installMockGateway,
  waitForControlUiRoute,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import {
  closeContext,
  installPhoneRecoveryRequestObserver,
  observeGatewayRequests,
  observeInstalledArtifact,
  observePhoneProofServiceWorker,
  phoneProofIdentity,
  resetPhoneRecoveryRequestObserver,
  startPhoneProofServer,
  type PhoneRecoveryObservation,
  waitForObservedGatewayRequest,
  waitForPhoneProofServiceWorker,
} from "./login-gate-e2e.test-support.ts";
import { phoneProofCleanup } from "./phone-stale-build-recovery.test-support.ts";

const proofIdentity = phoneProofIdentity();
const proofBuildId = proofIdentity.expectedRevisionSha
  ? `phone-proof-${proofIdentity.expectedRevisionSha.slice(0, 12)}-${proofIdentity.expectedRevisionSha.slice(12)}-artifact`
  : "phone-proof-local-artifact";
const suite = createControlUiE2eSuite({
  name: "Control UI phone stale-build recovery E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not installed or cannot start at ${executablePath}. Run \`pnpm --dir ui exec playwright install --with-deps chromium\`, or set OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM=1 only when intentionally skipping this lane.`,
});
const RETAINED_IMAGE_ALT = "Generated image retained after timeout";
const RETAINED_TIMEOUT_TEXT =
  "Provider timed out after the request started. Retry the turn, or increase its configured timeout.";
let RECOVERY_ARTIFACT_DIR: string;

beforeEach(() => {
  RECOVERY_ARTIFACT_DIR = createControlUiE2eArtifactDir("zombie-reload");
});

suite.define(() => {
  it.each([
    { serviceWorker: "normal", serviceWorkers: "allow" as const },
    { serviceWorker: "blocked", serviceWorkers: "block" as const },
  ] as const)(
    "rearms one bounded build recovery after the visible refresh action with $serviceWorker service-worker state",
    async ({ serviceWorker, serviceWorkers }) => {
      const proofServer = await startPhoneProofServer(proofBuildId);
      await using proofServerCleanup = phoneProofCleanup(() => proofServer.close());
      void proofServerCleanup;
      const context = await suite.browser.newContext({
        hasTouch: true,
        isMobile: true,
        recordVideo: {
          dir: RECOVERY_ARTIFACT_DIR,
          size: { height: 844, width: 390 },
        },
        serviceWorkers,
        viewport: { height: 844, width: 390 },
      });
      await using contextCleanup = phoneProofCleanup(() => closeContext(context));
      void contextCleanup;
      const page = await context.newPage();
      const documentRequests: PhoneRecoveryObservation["documentRequests"] = [];
      const documentResponses: PhoneRecoveryObservation["documentResponses"] = [];
      page.on("request", (request) => {
        if (request.resourceType() === "document") {
          const url = new URL(request.url());
          documentRequests.push({
            method: request.method(),
            pathname: url.pathname,
            recoveryMarker: url.searchParams.has("openclaw_mount_recovery"),
            url: url.href,
          });
        }
      });
      page.on("response", (response) => {
        if (response.request().resourceType() === "document") {
          documentResponses.push({
            cacheControl: response.headers()["cache-control"],
            fromWorker: response.fromServiceWorker(),
            requestUrl: response.request().url(),
            status: response.status(),
          });
        }
      });
      await installPhoneRecoveryRequestObserver(
        page,
        controlUiBundledGatewayUrl(proofServer.baseUrl),
      );
      const retainedImageArtifactId = "artifact_phone_proof_generated_image";
      const retainedImagePath =
        "/api/chat/media/outgoing/agent%3Amain%3Amain/phone-proof-generated/full";
      const retainedImageTicketedUrl = `${retainedImagePath}?mediaTicket=phone-proof`;
      const retainedImageBytes = await readFile(
        path.join(process.cwd(), "docs/assets/openclaw-banner-dark.png"),
      );
      const retainedImageRequestUrls: string[] = [];
      let blockedUnticketedRequestCount = 0;
      await page.route("**/api/chat/media/outgoing/**", async (route) => {
        const requestUrl = new URL(route.request().url());
        if (requestUrl.searchParams.get("mediaTicket") !== "phone-proof") {
          blockedUnticketedRequestCount += 1;
          await route.abort("blockedbyclient");
          return;
        }
        retainedImageRequestUrls.push(requestUrl.href);
        await route.fulfill({ body: retainedImageBytes, contentType: "image/png" });
      });
      const config = { ui: { prefs: { theme: "absolutely", themeMode: "dark" } } };
      const sessionKey = "agent:main:main";
      const gateway = await installMockGateway(page, {
        deferredMethods: ["connect"],
        featureMethods: ["chat.startup", "sessions.assignOwner", "users.list"],
        historyMessages: [
          {
            role: "assistant",
            content: [{ type: "text", text: RETAINED_TIMEOUT_TEXT }],
            timestamp: 1,
          },
          {
            role: "assistant",
            content: [
              {
                type: "image",
                artifactId: retainedImageArtifactId,
                url: retainedImagePath,
                alt: RETAINED_IMAGE_ALT,
                mimeType: "image/png",
                width: 1280,
                height: 358,
              },
            ],
            timestamp: 2,
          },
        ],
        serverBuildId: proofBuildId,
        methodResponses: {
          "artifacts.download": {
            artifact: {
              id: retainedImageArtifactId,
              type: "image",
              title: RETAINED_IMAGE_ALT,
              mimeType: "image/png",
              download: { mode: "url" },
            },
            url: retainedImageTicketedUrl,
            expiresAt: "2099-01-01T00:00:00.000Z",
          },
          "config.get": {
            config,
            hash: "phone-recovery-theme",
            issues: [],
            raw: JSON.stringify(config),
            valid: true,
          },
          "users.list": {
            profiles: [
              {
                id: "profile-ada",
                displayName: "Ada",
                avatarMime: null,
                mergedInto: null,
                createdAt: 1,
                updatedAt: 1,
                emails: [],
                githubIdentity: null,
                hasAvatar: false,
              },
              {
                id: "profile-bob",
                displayName: "Bob",
                avatarMime: null,
                mergedInto: null,
                createdAt: 1,
                updatedAt: 1,
                emails: [],
                githubIdentity: null,
                hasAvatar: false,
              },
            ],
          },
        },
        presenceUsers: [{ self: true, id: "profile-ada", name: "Ada" }],
        sessionKey,
        sessions: [
          {
            key: sessionKey,
            kind: "direct",
            label: "Main",
            createdActor: { type: "human", id: "profile-bob", label: "Bob" },
            owner: { actor: { type: "human", id: "profile-bob", label: "Bob" } },
            updatedAt: 1,
          },
        ],
      });
      const expectedRevisionSha = proofIdentity.expectedRevisionSha;
      const installedArtifacts: PhoneRecoveryObservation["installedArtifacts"] = [];
      let expectedConnectOrdinal = 1;
      const observeCurrentArtifact = async () => {
        const documentOrdinal = documentRequests.length;
        const installedArtifact = await observeInstalledArtifact(page);
        const observation = { documentOrdinal, ...installedArtifact };
        const existing = installedArtifacts.findIndex(
          (item) => item.documentOrdinal === documentOrdinal,
        );
        if (existing >= 0) {
          installedArtifacts[existing] = observation;
        } else {
          installedArtifacts.push(observation);
        }
        if (
          proofIdentity.proofRevision === "head" &&
          expectedRevisionSha &&
          !installedArtifact.buildId?.includes(`-${expectedRevisionSha.slice(0, 12)}-`)
        ) {
          throw new Error(
            `document ${documentOrdinal} loaded ${installedArtifact.buildId ?? "no build"}, expected ${expectedRevisionSha}`,
          );
        }
        return installedArtifact;
      };
      const waitForConnect = async () => {
        await waitForObservedGatewayRequest(page, expectedConnectOrdinal, "connect");
        await gateway.waitForRequest("connect");
        expectedConnectOrdinal += 1;
        await observeCurrentArtifact();
      };
      const mismatch = {
        code: "UNAVAILABLE",
        message: "Control UI updated; reload this page to continue",
        details: {
          code: ConnectErrorDetailCodes.PROTOCOL_MISMATCH,
          gatewayBuildId: "replacement-build",
          reloadRequired: true,
        },
        retryable: false,
      };
      const target = new URL("chat/main", proofServer.baseUrl);

      const observation: PhoneRecoveryObservation = {
        schemaVersion: 3,
        proofRevision: proofIdentity.proofRevision,
        serviceWorker,
        targetPath: target.pathname,
        scenarioCompleted: false,
        documentRequests,
        documentResponses,
        expectedRevisionSha,
        gatewayRequests: [],
        installedArtifacts,
      };

      try {
        await page.goto(target.href);
        const initialServiceWorker = await waitForPhoneProofServiceWorker(page, serviceWorker);
        observation.serviceWorkerState = {
          initial: initialServiceWorker,
          final: initialServiceWorker,
        };
        if (serviceWorker === "normal") {
          expect(initialServiceWorker.controlled).toBe(true);
          expect(initialServiceWorker.controllerState).toBe("activated");
          expect(initialServiceWorker.registrations).toHaveLength(1);
        } else {
          expect(initialServiceWorker.controlled).toBe(false);
          expect(initialServiceWorker.controllerState).toBeNull();
          expect(initialServiceWorker.registrations).toHaveLength(0);
        }
        await gateway.waitForRequest("connect");
        await gateway.resolveDeferred("connect");
        const retainedImage = page.getByAltText(RETAINED_IMAGE_ALT);
        const retainedTimeout = page.getByText(RETAINED_TIMEOUT_TEXT, { exact: true });
        await retainedImage.waitFor({ state: "visible", timeout: 10_000 });
        await retainedTimeout.waitFor({ state: "visible", timeout: 10_000 });
        const imageBeforeReconnect = await retainedImage.evaluate(
          (element) => element instanceof HTMLImageElement && element.complete,
        );
        const timeoutBeforeReconnect = await retainedTimeout.isVisible();
        const connectCountBeforeReconnect = (await gateway.getRequests("connect")).length;
        await gateway.deferNext("connect");
        await gateway.closeLatest(1006, "phone proof timeout-delivery reconnect");
        await gateway.waitForRequest("connect", { after: connectCountBeforeReconnect });
        await gateway.resolveDeferred("connect");
        await retainedImage.waitFor({ state: "visible", timeout: 10_000 });
        await retainedTimeout.waitFor({ state: "visible", timeout: 10_000 });
        const imageAfterReconnect = await retainedImage.evaluate(
          (element) => element instanceof HTMLImageElement && element.complete,
        );
        const timeoutAfterReconnect = await retainedTimeout.isVisible();
        const retentionRequests = await observeGatewayRequests(page);
        const retentionConnects = retentionRequests.filter(
          (request) => request.method === "connect",
        );
        const retentionTranscripts = retentionRequests.filter(
          (request) => request.method === "chat.history" || request.method === "chat.startup",
        );
        const retentionModelWakes = retentionRequests.filter(
          (request) => request.method === "chat.send",
        );
        const retentionAssignmentMutations = retentionRequests.filter(
          (request) => request.method === "sessions.assignOwner",
        );
        expect(imageBeforeReconnect).toBe(true);
        expect(imageAfterReconnect).toBe(true);
        expect(timeoutBeforeReconnect).toBe(true);
        expect(timeoutAfterReconnect).toBe(true);
        expect(retentionConnects).toHaveLength(2);
        expect(new Set(retentionConnects.map((request) => request.requestId)).size).toBe(2);
        expect(retentionTranscripts.length).toBeGreaterThanOrEqual(1);
        expect(retentionModelWakes).toHaveLength(0);
        expect(retentionAssignmentMutations).toHaveLength(0);
        const artifactDownloadRequests = await gateway.getRequests("artifacts.download");
        expect(artifactDownloadRequests.length).toBeGreaterThanOrEqual(1);
        expect(retainedImageRequestUrls.length).toBeGreaterThanOrEqual(1);
        for (const requestUrl of retainedImageRequestUrls) {
          const url = new URL(requestUrl);
          expect(url.pathname).toContain("/api/chat/media/outgoing/");
          expect(url.searchParams.get("mediaTicket")).toBe("phone-proof");
        }
        observation.failureRetention = {
          generatedImage: {
            alt: RETAINED_IMAGE_ALT,
            artifactId: retainedImageArtifactId,
            artifactDownloadRequestCount: artifactDownloadRequests.length,
            blockedUnticketedRequestCount,
            loadedAfterReconnect: imageAfterReconnect,
            loadedBeforeReconnect: imageBeforeReconnect,
            mediaRequestUrls: [...retainedImageRequestUrls],
            naturalWidth: await retainedImage.evaluate((element) =>
              element instanceof HTMLImageElement ? element.naturalWidth : 0,
            ),
            renderedSrc: await retainedImage.evaluate((element) =>
              element instanceof HTMLImageElement ? element.currentSrc : "",
            ),
            requestCount: retainedImageRequestUrls.length,
            sourcePathname: retainedImagePath,
          },
          reconnect: {
            assignmentMutationCount: retentionAssignmentMutations.length,
            connectRequestCount: retentionConnects.length,
            connectRequestIds: retentionConnects.map((request) => request.requestId),
            modelWakeCount: retentionModelWakes.length,
            transcriptRequestCount: retentionTranscripts.length,
          },
          timeoutDelivery: {
            retainedAfterReconnect: timeoutAfterReconnect,
            text: RETAINED_TIMEOUT_TEXT,
            visibleBeforeReconnect: timeoutBeforeReconnect,
          },
        };
        await resetPhoneRecoveryRequestObserver(page);
        documentRequests.length = 0;
        documentResponses.length = 0;
        installedArtifacts.length = 0;
        await gateway.deferNext("connect");
        await page.reload();
        await waitForConnect();
        await gateway.rejectDeferred("connect", mismatch);
        await page.waitForFunction(
          () =>
            sessionStorage.getItem("openclaw.controlUi.staleChunkReloadBuildId") ===
              "replacement-build" &&
            sessionStorage.getItem("openclaw.control-ui-e2e.build-rejection-loads") === "2",
        );

        await waitForConnect();
        await gateway.rejectDeferred("connect", mismatch);
        const recovery = page.getByRole("button", { name: /Server updated/u });
        await recovery.waitFor({ timeout: 10_000 });
        expect(await recovery.count()).toBe(1);
        expect(await page.locator("openclaw-login-gate").count()).toBe(0);
        expect(await page.locator("#control-ui-main").getAttribute("inert")).toBeNull();
        expect(await page.locator("openclaw-router-outlet").getAttribute("inert")).not.toBeNull();
        const recoveryAccess = await recovery.evaluate((button) => {
          const bounds = button.getBoundingClientRect();
          const liveRegion = button.closest<HTMLElement>("[role='status']");
          const outlet = document.querySelector("openclaw-router-outlet");
          return {
            ariaLive: liveRegion?.getAttribute("aria-live"),
            disabled: (button as HTMLButtonElement).disabled,
            height: bounds.height,
            insideFencedOutlet: outlet?.contains(button) ?? false,
            tabIndex: (button as HTMLButtonElement).tabIndex,
            width: bounds.width,
          };
        });
        expect(recoveryAccess).toEqual({
          ariaLive: "polite",
          disabled: false,
          height: expect.any(Number),
          insideFencedOutlet: false,
          tabIndex: 0,
          width: expect.any(Number),
        });
        // Browser layout can represent a CSS 44px target a few millionths below 44.
        const touchTargetRoundingTolerancePx = 0.01;
        expect(recoveryAccess.height).toBeGreaterThanOrEqual(44 - touchTargetRoundingTolerancePx);
        expect(recoveryAccess.width).toBeGreaterThanOrEqual(44 - touchTargetRoundingTolerancePx);
        await recovery.focus();
        const recoveryFocused = await recovery.evaluate(
          (button) => document.activeElement === button,
        );
        expect(recoveryFocused).toBe(true);
        const terminalInvocationCount = (await gateway.getRequests("terminal.open")).length;
        expect(
          await recovery.evaluate((button) => button.closest("[role='status']")?.textContent ?? ""),
        ).not.toMatch(/openclaw (?:triage|update)|terminal command|run .*terminal/iu);
        observation.reloadRequired = {
          actionCount: await recovery.count(),
          access: recoveryAccess,
          focused: recoveryFocused,
          terminalInvocationCount,
        };
        await writeFile(
          path.join(RECOVERY_ARTIFACT_DIR, `01-${serviceWorker}-reload-required.png`),
          await takeControlUiViewportScreenshot(page, page.locator(".shell"), [recovery]),
        );
        expect(terminalInvocationCount).toBe(0);

        const documentCountBeforeFailedProbe = documentRequests.length;
        await page.evaluate(() => {
          const originalFetch = window.fetch.bind(window);
          let remainingFailures = 1;
          window.fetch = async (input, init) => {
            if (remainingFailures > 0 && init?.method === "HEAD") {
              remainingFailures -= 1;
              sessionStorage.setItem("openclaw.control-ui-e2e.failed-refresh-probes", "1");
              return new Response(null, { status: 503 });
            }
            return originalFetch(input, init);
          };
        });
        await recovery.tap();
        await page.waitForFunction(
          () => sessionStorage.getItem("openclaw.control-ui-e2e.failed-refresh-probes") === "1",
        );
        const failedRecovery = page.locator(".sidebar-update-card--floating .sidebar-update-card");
        await expect.poll(() => failedRecovery.getByRole("button").isEnabled()).toBe(true);
        await expect.poll(() => failedRecovery.textContent()).toContain("Retry now");
        await expect.poll(() => failedRecovery.textContent()).toContain("Gateway reconnects");
        expect(documentRequests).toHaveLength(documentCountBeforeFailedProbe);
        expect(
          await failedRecovery.evaluate(
            (card) => card.closest("[role='status']")?.textContent ?? "",
          ),
        ).not.toMatch(/openclaw (?:triage|update)|terminal command|run .*terminal/iu);

        await recovery.tap();
        await expect.poll(() => documentRequests.length).toBe(3);
        expect(documentRequests.map((request) => request.recoveryMarker)).toEqual([
          false,
          true,
          true,
        ]);

        await waitForConnect();
        await gateway.rejectDeferred("connect", mismatch);
        await expect.poll(() => documentRequests.length).toBe(4);
        await waitForConnect();
        await gateway.resolveDeferred("connect");

        await page.locator("openclaw-app-shell").waitFor();
        expect(documentRequests.map((request) => request.recoveryMarker)).toEqual([
          false,
          true,
          true,
          true,
        ]);
        expect(await page.getByRole("button", { name: /Server updated/u }).count()).toBe(0);
        await expect
          .poll(() => page.locator("openclaw-router-outlet").getAttribute("inert"))
          .toBeNull();
        await waitForControlUiRoute(page, { pathname: "/chat/main", routeId: "chat" });
        expect(
          await page.evaluate(() =>
            sessionStorage.getItem("openclaw.control-ui-e2e.build-rejection-loads"),
          ),
        ).toBe("4");
        await expect.poll(() => documentResponses.length).toBe(4);
        expect(
          documentResponses.map(({ cacheControl, fromWorker, status }) => ({
            cacheControl,
            fromWorker,
            status,
          })),
        ).toEqual(
          Array.from({ length: 4 }, () => ({
            cacheControl: "no-cache",
            fromWorker: false,
            status: 200,
          })),
        );
        const installedArtifact = await observeCurrentArtifact();
        expect(installedArtifact.buildId).not.toBeNull();
        expect(installedArtifact.bodyDisplay).toBe("block");
        expect(installedArtifact.icon.pathname).toBe("/favicon.svg");
        expect(installedArtifact.font.pathname).toBe("/fonts/space-grotesk.css");
        expect(installedArtifact.theme.pathname).toBe("/themes/absolutely.css");
        for (const asset of [
          installedArtifact.icon,
          installedArtifact.font,
          installedArtifact.theme,
        ]) {
          expect(asset.url).not.toBeNull();
          expect(asset.version).toBe(installedArtifact.buildId);
        }
        observation.recovered = {
          actionCount: await page.getByRole("button", { name: /Server updated/u }).count(),
          routePath: new URL(page.url()).pathname,
        };
        const actions = page.getByRole("button", { name: "Actions for Main" });
        await writeFile(
          path.join(RECOVERY_ARTIFACT_DIR, `02-${serviceWorker}-recovered.png`),
          await takeControlUiViewportScreenshot(page, page.locator(".shell"), [actions]),
        );
        await actions.tap();
        const assignment = page.getByRole("menuitem", { name: "Assign to…", exact: true });
        await assignment.waitFor();
        await assignment.tap();
        const selectedOwner = page.getByRole("menuitemradio", {
          checked: true,
          exact: true,
          name: "Bob",
        });
        await selectedOwner.waitFor();
        const selectedOwners = await page
          .getByRole("menuitemradio", { checked: true })
          .evaluateAll((owners) =>
            owners.map(
              (owner) => owner.querySelector(".session-menu__text")?.textContent?.trim() ?? "",
            ),
          );
        expect(selectedOwners).toEqual(["Bob"]);
        const observedGatewayRequests = await observeGatewayRequests(page);
        const connectRequests = observedGatewayRequests.filter(
          (request) => request.method === "connect",
        );
        expect(connectRequests).toHaveLength(4);
        expect(connectRequests.map((request) => request.documentOrdinal)).toEqual([1, 2, 3, 4]);
        expect(new Set(connectRequests.map((request) => request.requestId)).size).toBe(4);
        const modelWakeCount = observedGatewayRequests.filter(
          (request) => request.method === "chat.send",
        ).length;
        expect(modelWakeCount).toBe(0);
        const assignmentMutationCount = observedGatewayRequests.filter(
          (request) => request.method === "sessions.assignOwner",
        ).length;
        expect(assignmentMutationCount).toBe(0);
        observation.assignment = {
          assignmentMutationCount,
          expectedOwner: "Bob",
          modelWakeCount,
          selectedOwners,
          visible: await selectedOwner.isVisible(),
        };
        await writeFile(
          path.join(RECOVERY_ARTIFACT_DIR, `03-${serviceWorker}-assignment-menu.png`),
          await takeControlUiViewportScreenshot(page, page.locator(".shell"), [selectedOwner]),
        );
        observation.scenarioCompleted = true;
      } finally {
        if (!page.isClosed()) {
          await observeCurrentArtifact().catch(() => undefined);
          const finalServiceWorker = await observePhoneProofServiceWorker(page).catch(
            () => undefined,
          );
          if (observation.serviceWorkerState && finalServiceWorker) {
            observation.serviceWorkerState.final = finalServiceWorker;
          }
          observation.gatewayRequests = await observeGatewayRequests(page).catch(() => []);
          const connectRequestCount = observation.gatewayRequests.filter(
            (request) => request.method === "connect",
          ).length;
          const modelWakeCount = observation.gatewayRequests.filter(
            (request) => request.method === "chat.send",
          ).length;
          observation.final = {
            appShellCount: await page
              .locator("openclaw-app-shell")
              .count()
              .catch(() => 0),
            connectRequestCount,
            loginGateCount: await page
              .locator("openclaw-login-gate")
              .count()
              .catch(() => 0),
            mainInert: await page
              .locator("#control-ui-main")
              .evaluate((element) => element.hasAttribute("inert"))
              .catch(() => null),
            modelWakeCount,
            recoveryActionCount: await page
              .getByRole("button", { name: /Server updated/u })
              .count()
              .catch(() => 0),
            reloadCount: await page
              .evaluate(() => {
                const value = sessionStorage.getItem(
                  "openclaw.control-ui-e2e.build-rejection-loads",
                );
                if (value === null) {
                  return null;
                }
                const count = Number.parseInt(value, 10);
                return Number.isSafeInteger(count) ? Math.max(0, count - 1) : null;
              })
              .catch(() => null),
            routePath: new URL(page.url()).pathname,
            routerOutletInert: await page
              .locator("openclaw-router-outlet")
              .evaluate((element) => element.hasAttribute("inert"))
              .catch(() => null),
            terminalInvocationCount: (await gateway.getRequests("terminal.open")).length,
          };
        }
        await writeFile(
          path.join(RECOVERY_ARTIFACT_DIR, `observed-${serviceWorker}.json`),
          `${JSON.stringify(observation, null, 2)}\n`,
        );
      }
    },
  );
});
