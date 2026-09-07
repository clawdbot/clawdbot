import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { BrowserContext, Page } from "playwright";
import { expect, vi } from "vitest";
import { ConnectErrorDetailCodes } from "../../../packages/gateway-protocol/src/connect-error-details.js";
import {
  installMockGateway,
  startProductionControlUiE2eServer,
} from "../test-helpers/control-ui-e2e.ts";

const RECORDED_GATEWAY_REQUESTS_KEY = "openclaw.control-ui-e2e.phone-recovery-requests";

type ObservedAssetLink = {
  elementId: string | null;
  pathname: string | null;
  url: string | null;
  version: string | null;
};

type InstalledArtifactObservation = {
  bodyDisplay: string;
  buildId: string | null;
  font: ObservedAssetLink;
  icon: ObservedAssetLink;
  theme: ObservedAssetLink;
};

export type ServiceWorkerObservation = {
  controlled: boolean;
  controllerScriptUrl: string | null;
  controllerState: string | null;
  registrations: Array<{
    activeScriptUrl: string | null;
    activeState: string | null;
    scope: string;
  }>;
  supported: boolean;
};

export type ObservedGatewayRequest = {
  documentOrdinal: number;
  method: "chat.history" | "chat.send" | "chat.startup" | "connect" | "sessions.assignOwner";
  requestId: string;
};

export type PhoneRecoveryObservation = {
  schemaVersion: 3;
  proofRevision: "base" | "head" | "local";
  serviceWorker: "normal" | "blocked";
  targetPath: string;
  scenarioCompleted: boolean;
  documentRequests: Array<{
    method: string;
    pathname: string;
    recoveryMarker: boolean;
    url: string;
  }>;
  documentResponses: Array<{
    cacheControl: string | undefined;
    fromWorker: boolean;
    requestUrl: string;
    status: number;
  }>;
  expectedRevisionSha: string | null;
  gatewayRequests: ObservedGatewayRequest[];
  installedArtifacts: Array<
    InstalledArtifactObservation & {
      documentOrdinal: number;
    }
  >;
  serviceWorkerState?: {
    final: ServiceWorkerObservation;
    initial: ServiceWorkerObservation;
  };
  reloadRequired?: {
    actionCount: number;
    access: {
      ariaLive: string | null | undefined;
      disabled: boolean;
      height: number;
      insideFencedOutlet: boolean;
      tabIndex: number;
      width: number;
    };
    focused: boolean;
    terminalInvocationCount: number;
  };
  recovered?: {
    actionCount: number;
    routePath: string;
  };
  assignment?: {
    assignmentMutationCount: number;
    expectedOwner: string;
    modelWakeCount: number;
    selectedOwners: string[];
    visible: boolean;
  };
  failureRetention?: {
    generatedImage: {
      alt: string;
      artifactId: string;
      artifactDownloadRequestCount: number;
      blockedUnticketedRequestCount: number;
      loadedAfterReconnect: boolean;
      loadedBeforeReconnect: boolean;
      mediaRequestUrls: string[];
      naturalWidth: number;
      renderedSrc: string;
      requestCount: number;
      sourcePathname: string;
    };
    reconnect: {
      assignmentMutationCount: number;
      connectRequestCount: number;
      connectRequestIds: string[];
      modelWakeCount: number;
      transcriptRequestCount: number;
    };
    timeoutDelivery: {
      retainedAfterReconnect: boolean;
      text: string;
      visibleBeforeReconnect: boolean;
    };
  };
  final?: {
    appShellCount: number;
    connectRequestCount: number;
    loginGateCount: number;
    mainInert: boolean | null;
    modelWakeCount: number;
    recoveryActionCount: number;
    reloadCount: number | null;
    routePath: string;
    routerOutletInert: boolean | null;
    terminalInvocationCount: number;
  };
};

function isPhoneProofRevision(
  value: string | undefined,
): value is PhoneRecoveryObservation["proofRevision"] {
  return value === "base" || value === "head" || value === "local";
}

export function phoneProofIdentity(): Pick<
  PhoneRecoveryObservation,
  "expectedRevisionSha" | "proofRevision"
> {
  const configuredRevision = process.env.OPENCLAW_PHONE_PROOF_REVISION?.trim();
  if (configuredRevision !== undefined && !isPhoneProofRevision(configuredRevision)) {
    throw new Error("OPENCLAW_PHONE_PROOF_REVISION must be base, head, or local");
  }
  const proofRevision = configuredRevision ?? "local";
  const expectedSha = process.env.OPENCLAW_PHONE_PROOF_EXPECTED_SHA?.trim() ?? "";
  if (proofRevision !== "local" && !expectedSha) {
    throw new Error(
      "OPENCLAW_PHONE_PROOF_EXPECTED_SHA is required for base and head proof revisions",
    );
  }
  if (expectedSha && !/^[a-f0-9]{40}$/u.test(expectedSha)) {
    throw new Error("OPENCLAW_PHONE_PROOF_EXPECTED_SHA must be a full lowercase commit SHA");
  }
  if (expectedSha) {
    const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: process.cwd(),
      encoding: "utf8",
    }).trim();
    const actualSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf8",
    }).trim();
    if (actualSha !== expectedSha) {
      throw new Error(`Phone proof expected ${expectedSha}, but the checkout is ${actualSha}`);
    }
    const allowedProofPaths = new Set([
      "ui/src/e2e/login-gate-e2e.test-support.ts",
      "ui/src/e2e/login-gate.e2e.test.ts",
      "ui/src/e2e/phone-stale-build-recovery.e2e.test.ts",
      "ui/src/e2e/phone-stale-build-recovery.test-support.ts",
      "ui/src/e2e/stale-build-recovery.e2e.test.ts",
      "ui/src/test-helpers/control-ui-e2e-screenshot.ts",
    ]);
    const changedPaths = [
      ...execFileSync("git", ["diff", "--name-only", "-z", "HEAD"], {
        cwd: repoRoot,
        encoding: "utf8",
      }).split("\0"),
      ...execFileSync("git", ["ls-files", "--others", "--exclude-standard", "-z"], {
        cwd: repoRoot,
        encoding: "utf8",
      }).split("\0"),
    ].filter(Boolean);
    const unexpectedPath = changedPaths.find((filePath) => !allowedProofPaths.has(filePath));
    if (unexpectedPath) {
      throw new Error(`Phone proof checkout has an unrelated source change: ${unexpectedPath}`);
    }
  }
  return {
    expectedRevisionSha: expectedSha || null,
    proofRevision,
  };
}

export async function startPhoneProofServer(buildId: string) {
  const buildDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-login-gate-e2e-"));
  try {
    const server = await startProductionControlUiE2eServer(buildDir, buildId);
    return {
      baseUrl: server.baseUrl,
      close: async () => {
        try {
          await server.close();
        } finally {
          await rm(buildDir, { force: true, recursive: true });
        }
      },
    };
  } catch (error) {
    await rm(buildDir, { force: true, recursive: true });
    throw error;
  }
}

export async function observePhoneProofServiceWorker(
  page: Page,
): Promise<ServiceWorkerObservation> {
  return page.evaluate(async () => {
    if (!("serviceWorker" in navigator)) {
      return {
        controlled: false,
        controllerScriptUrl: null,
        controllerState: null,
        registrations: [],
        supported: false,
      };
    }
    const registrations = await navigator.serviceWorker.getRegistrations();
    return {
      controlled: navigator.serviceWorker.controller !== null,
      controllerScriptUrl: navigator.serviceWorker.controller?.scriptURL ?? null,
      controllerState: navigator.serviceWorker.controller?.state ?? null,
      registrations: registrations.map((registration) => ({
        activeScriptUrl: registration.active?.scriptURL ?? null,
        activeState: registration.active?.state ?? null,
        scope: registration.scope,
      })),
      supported: true,
    };
  });
}

export async function waitForPhoneProofServiceWorker(
  page: Page,
  expected: PhoneRecoveryObservation["serviceWorker"],
): Promise<ServiceWorkerObservation> {
  // Playwright's waitForFunction treats an async predicate's Promise as truthy.
  // Poll and return the same snapshot so activation cannot race a second read.
  return vi.waitFor(
    async () => {
      const observation = await observePhoneProofServiceWorker(page);
      expect(observation).toMatchObject(
        expected === "normal"
          ? {
              supported: true,
              controlled: true,
              controllerState: "activated",
              registrations: [{ activeState: "activated" }],
            }
          : { controlled: false, controllerState: null, registrations: [] },
      );
      return observation;
    },
    { timeout: 30_000 },
  );
}

export async function observeInstalledArtifact(page: Page): Promise<InstalledArtifactObservation> {
  return page.evaluate(async () => {
    await document.fonts.ready;
    const observeLink = (selector: string) => {
      const link = document.querySelector<HTMLLinkElement>(selector);
      const url = link ? new URL(link.href) : null;
      return {
        elementId: link?.id || null,
        pathname: url?.pathname ?? null,
        url: url?.href ?? null,
        version: url?.searchParams.get("v") ?? null,
      };
    };
    return {
      bodyDisplay: getComputedStyle(document.body).display,
      buildId: document.documentElement.getAttribute("data-openclaw-control-ui-build-id"),
      font: observeLink('link[id^="openclaw-typeface-"]'),
      icon: observeLink('link[rel="icon"][type="image/svg+xml"]'),
      theme: observeLink("#openclaw-theme-palette-absolutely"),
    };
  });
}

export async function observeGatewayRequests(page: Page): Promise<ObservedGatewayRequest[]> {
  return (await page.evaluate((key) => {
    const value = JSON.parse(sessionStorage.getItem(key) ?? "[]") as unknown;
    return Array.isArray(value) ? value : [];
  }, RECORDED_GATEWAY_REQUESTS_KEY)) as ObservedGatewayRequest[];
}

export async function resetPhoneRecoveryRequestObserver(page: Page): Promise<void> {
  await page.evaluate((key) => {
    sessionStorage.setItem(key, "[]");
    sessionStorage.setItem("openclaw.control-ui-e2e.build-rejection-loads", "0");
  }, RECORDED_GATEWAY_REQUESTS_KEY);
}

export async function waitForObservedGatewayRequest(
  page: Page,
  documentOrdinal: number,
  method: ObservedGatewayRequest["method"],
): Promise<void> {
  await page.waitForFunction(
    ({ key, ordinal, targetMethod }) => {
      const requests = JSON.parse(sessionStorage.getItem(key) ?? "[]") as ObservedGatewayRequest[];
      return requests.some(
        (request) => request.documentOrdinal === ordinal && request.method === targetMethod,
      );
    },
    { key: RECORDED_GATEWAY_REQUESTS_KEY, ordinal: documentOrdinal, targetMethod: method },
  );
}

export async function installPhoneRecoveryRequestObserver(
  page: Page,
  bundledGatewayUrl: string,
): Promise<void> {
  await page.addInitScript(
    ({ gatewayUrl, requestLedgerKey }) => {
      const key = "openclaw.control-ui-e2e.build-rejection-loads";
      const count = Number.parseInt(sessionStorage.getItem(key) ?? "0", 10);
      const documentOrdinal = count + 1;
      sessionStorage.setItem(key, String(documentOrdinal));
      localStorage.setItem(
        `openclaw.control.settings.v1:${gatewayUrl}`,
        JSON.stringify({ gatewayUrl, theme: "absolutely", themeMode: "dark" }),
      );
      const instrumentedPrototypes = new WeakSet<object>();
      const instrument = (constructor: typeof WebSocket) => {
        const prototype = constructor.prototype;
        if (instrumentedPrototypes.has(prototype)) {
          return constructor;
        }
        instrumentedPrototypes.add(prototype);
        const originalSend = Reflect.get(prototype, "send") as WebSocket["send"];
        prototype.send = function (data) {
          if (typeof data === "string") {
            try {
              const frame = JSON.parse(data) as {
                id?: unknown;
                method?: unknown;
                type?: unknown;
              };
              if (
                frame.type === "req" &&
                typeof frame.id === "string" &&
                (frame.method === "connect" ||
                  frame.method === "chat.history" ||
                  frame.method === "chat.send" ||
                  frame.method === "chat.startup" ||
                  frame.method === "sessions.assignOwner")
              ) {
                const existing = JSON.parse(
                  sessionStorage.getItem(requestLedgerKey) ?? "[]",
                ) as ObservedGatewayRequest[];
                existing.push({
                  documentOrdinal,
                  method: frame.method,
                  requestId: frame.id,
                });
                sessionStorage.setItem(requestLedgerKey, JSON.stringify(existing));
              }
            } catch {
              // Non-JSON WebSocket traffic is outside this mock Gateway proof.
            }
          }
          return Reflect.apply(originalSend, this, [data]);
        };
        return constructor;
      };
      let currentWebSocket = instrument(window.WebSocket);
      Object.defineProperty(window, "WebSocket", {
        configurable: true,
        get: () => currentWebSocket,
        set: (nextConstructor: typeof WebSocket) => {
          currentWebSocket = instrument(nextConstructor);
        },
      });
    },
    { gatewayUrl: bundledGatewayUrl, requestLedgerKey: RECORDED_GATEWAY_REQUESTS_KEY },
  );
}

export async function closeContext(context: BrowserContext): Promise<void> {
  await context.close().catch(() => {});
}

export async function renderLoginGate(page: Page, baseUrl: string): Promise<void> {
  const gateway = await installMockGateway(page, { deferredMethods: ["connect"] });
  const response = await page.goto(baseUrl);
  if (response?.status() !== 200) {
    throw new Error(`Control UI fixture returned ${response?.status() ?? "no response"}`);
  }
  await gateway.waitForRequest("connect");
  await gateway.rejectDeferred("connect", {
    code: "INVALID_REQUEST",
    message: "token missing",
    details: { code: ConnectErrorDetailCodes.AUTH_TOKEN_MISSING },
  });
  await page.locator(".login-gate").waitFor();
  await mountLoginGate(page);
}

async function mountLoginGate(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await customElements.whenDefined("openclaw-login-gate");
    const gate = document.createElement("openclaw-login-gate") as HTMLElement & {
      props: Record<string, unknown>;
      updateComplete: Promise<unknown>;
    };
    document.body.dataset.connectCount = "0";
    gate.props = {
      resourceBasePath: "",
      connected: false,
      lastError: "unauthorized: gateway token required",
      lastErrorCode: null,
      hasToken: false,
      hasPassword: false,
      gatewayUrl: "ws://127.0.0.1:18789",
      token: "",
      password: "",
      showGatewayToken: false,
      showGatewayPassword: false,
      onGatewayUrlChange: () => {},
      onTokenChange: () => {},
      onPasswordChange: () => {},
      onToggleGatewayToken: () => {},
      onToggleGatewayPassword: () => {},
      onConnect: () => {
        const current = Number.parseInt(document.body.dataset.connectCount ?? "0", 10);
        document.body.dataset.connectCount = String(current + 1);
      },
    };
    document.body.replaceChildren(gate);
    await gate.updateComplete;
  });
}
