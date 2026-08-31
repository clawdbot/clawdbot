import { mkdir } from "node:fs/promises";
import path from "node:path";
import { errors, type Locator, type Page } from "playwright";
import { expect } from "vitest";
import {
  controlUiSessionPath,
  controlUiSessionUrl,
  installMockGateway as installControlUiMockGateway,
  type ControlUiMockGatewayScenario,
  type MockGatewayControls,
  waitForConfirmModal,
  waitForControlUiRoute,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { waitForCommittedComposerDraft } from "./settle.test-support.ts";

export { controlUiSessionPath, controlUiSessionUrl, waitForConfirmModal };

const NEW_SESSION_FEATURE_METHODS = [
  "chat.metadata",
  "chat.startup",
  "sessions.create",
  "sessions.dispatch",
] as const;

export function installMockGateway(
  page: Page,
  scenario: ControlUiMockGatewayScenario = {},
): Promise<MockGatewayControls> {
  return installControlUiMockGateway(page, {
    ...scenario,
    featureMethods: scenario.featureMethods ?? [...NEW_SESSION_FEATURE_METHODS],
  });
}

export const WORKSPACE = "/home/peter/openclaw";
export const PICKED = "/home/peter/openclaw/packages";
export const SOURCE_REPO = "/tmp/source-repo";
export const TARGET_REPO = "/tmp/target-repo";
export const REFRESHED_RESEARCH_WORKSPACE = "/home/peter/research-next";
export const MOVED_WORKSPACE = "/home/peter/openclaw-next";
const LOCATOR_TEXT_READ_TIMEOUT_MS = 500;
const LOCATOR_TEXT_POLL_TIMEOUT_MS = 10_000;

export const captureUiProofEnabled = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const uiProofArtifactDir = path.join(
  process.cwd(),
  ".artifacts",
  "control-ui-e2e",
  "cloud-worker-session",
);
export const reconnectProofArtifactDir = path.join(
  process.cwd(),
  ".artifacts",
  "control-ui-e2e",
  "initial-prompt-reconnect",
);
export const projectProofArtifactDir = path.join(
  process.cwd(),
  ".artifacts",
  "control-ui-e2e",
  "project-registry",
);
export const newSessionComposerProofArtifactDir = path.join(
  process.cwd(),
  ".artifacts",
  "control-ui-e2e",
  "new-session-slash-menu",
);
const environmentMetadataProofArtifactDir = path.join(
  process.cwd(),
  ".artifacts",
  "control-ui-e2e",
  "environment-metadata",
);
const deviceRuntimeProofArtifactDir = path.join(
  process.cwd(),
  ".artifacts",
  "control-ui-e2e",
  "device-runtime-gating",
);

export async function prepareProjectUiProof() {
  if (captureUiProofEnabled) {
    await prepareUiProof(projectProofArtifactDir);
  }
}
export async function prepareNewSessionComposerUiProof() {
  if (captureUiProofEnabled) {
    await prepareUiProof(newSessionComposerProofArtifactDir);
  }
}
export const ONE_PIXEL_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/woAAn8B9FD5fHAAAAAASUVORK5CYII=";
export const SESSION_LIST_DEFAULTS = {
  contextTokens: null,
  model: "gpt-5.5",
  modelProvider: "openai",
};

type LocatorTextPoll = ReturnType<typeof expect.poll<Promise<string | null>>>;

export function pollLocatorText(locator: Locator): LocatorTextPoll {
  return expect.poll(
    async () => {
      try {
        return await locator.textContent({ timeout: LOCATOR_TEXT_READ_TIMEOUT_MS });
      } catch (error) {
        if (error instanceof errors.TimeoutError) {
          return null;
        }
        throw error;
      }
    },
    { timeout: LOCATOR_TEXT_POLL_TIMEOUT_MS },
  );
}

export function createNewSessionPageE2eSuite() {
  return createControlUiE2eSuite({
    name: "Control UI new-session page mocked Gateway E2E",
    unavailableMessage: (executablePath) =>
      `Playwright Chromium is unavailable at ${executablePath}`,
  });
}

export function createdSessionListResult(sessionKey: string) {
  return {
    count: 1,
    defaults: SESSION_LIST_DEFAULTS,
    path: "",
    sessions: [
      {
        contextTokens: null,
        displayName: "Created session",
        key: sessionKey,
        kind: "direct",
        model: "gpt-5.5",
        modelProvider: "openai",
        totalTokens: 0,
        updatedAt: Date.now(),
      },
    ],
    ts: Date.now(),
  };
}

export async function expectPendingSessionPlacementStartupBeforeRuntime(
  page: Page,
  gateway: MockGatewayControls,
  sessionKey: string,
) {
  await waitForCommittedChatRoute(page);
  expect(page.url()).toContain(controlUiSessionPath(sessionKey));
  const startupStatus = page.locator('.chat-thread .chat-working-indicator[role="status"]');
  await expect.poll(() => startupStatus.count()).toBe(1);
  await pollLocatorText(startupStatus).toContain("Provisioning environment…");
  expect(await page.locator(".chat-cloud-startup, .agent-chat__composer-status-band").count()).toBe(
    0,
  );
  await expect
    .poll(() => page.locator(".agent-chat__composer-combobox textarea").isDisabled())
    .toBe(true);
  expect(await gateway.getRequests("sessions.dispatch")).toHaveLength(0);
  expect(await gateway.getRequests("sessions.send")).toHaveLength(0);
  await captureUiProof(page, "02-cloud-startup-chunk-pending.png");
  return startupStatus;
}

export async function captureUiProof(page: Page, fileName: string) {
  if (!captureUiProofEnabled) {
    return;
  }
  await captureProof(page, uiProofArtifactDir, fileName);
}

export async function captureProjectUiProof(page: Page, fileName: string) {
  if (!captureUiProofEnabled) {
    return;
  }
  await captureProof(page, projectProofArtifactDir, fileName);
}

export async function captureNewSessionComposerUiProof(page: Page, fileName: string) {
  if (!captureUiProofEnabled) {
    return;
  }
  await captureProof(page, newSessionComposerProofArtifactDir, fileName);
}

export async function captureEnvironmentMetadataUiProof(page: Page) {
  const proofName = process.env.OPENCLAW_ENVIRONMENT_METADATA_PROOF;
  if (proofName !== "before" && proofName !== "after") {
    return;
  }
  await captureProof(page, environmentMetadataProofArtifactDir, `${proofName}.png`);
}

export async function captureDeviceRuntimeUiProof(page: Page, fileName: string) {
  if (!captureUiProofEnabled) {
    return;
  }
  await captureProof(page, deviceRuntimeProofArtifactDir, fileName);
}

async function prepareUiProof(artifactDir: string) {
  await mkdir(artifactDir, { recursive: true });
}

async function captureProof(page: Page, artifactDir: string, fileName: string) {
  await prepareUiProof(artifactDir);
  await page.screenshot({
    animations: "disabled",
    fullPage: true,
    path: path.join(artifactDir, fileName),
  });
}

export async function pastePng(target: Locator, count = 1) {
  await target.evaluate(
    (element, { base64, fileCount }) => {
      const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
      const clipboard = new DataTransfer();
      for (let index = 0; index < fileCount; index += 1) {
        const fileName = fileCount === 1 ? "pixel.png" : `pixel-${index + 1}.png`;
        clipboard.items.add(new File([bytes], fileName, { type: "image/png" }));
      }
      element.dispatchEvent(
        new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: clipboard }),
      );
    },
    { base64: ONE_PIXEL_PNG_B64, fileCount: count },
  );
}

export async function waitForCommittedNewSessionDraft(
  page: Page,
  expectedText: string | null,
  expectedAttachments: number | readonly string[],
): Promise<void> {
  const params = new URL(page.url()).searchParams;
  const scopeKey = JSON.stringify([
    params.get("agent")?.trim() ?? "",
    params.get("catalog")?.trim() ?? "",
    params.get("group")?.trim() ?? "",
  ]);
  await waitForCommittedComposerDraft(page, scopeKey, expectedText, expectedAttachments);
}

export async function replaceGatewayClient(page: Page) {
  await page.evaluate(() => {
    const app = document.querySelector("openclaw-app") as HTMLElement & {
      runtime?: { context: { gateway: { connect: () => void } } };
    };
    if (!app.runtime) {
      throw new Error("OpenClaw application runtime is unavailable");
    }
    app.runtime.context.gateway.connect();
  });
}

export async function openNewSessionPlusMenu(page: Page) {
  const composer = page.locator(".new-session-page__composer");
  const menu = composer.locator("wa-dropdown.agent-chat__capability-menu");
  await composer.getByRole("button", { name: "Add attachment" }).click();
  await expect.poll(() => menu.getAttribute("data-view")).toBe("root");
  return menu;
}

export async function navigateInApp(page: Page, routeId: string, search = "") {
  await page.evaluate(
    ({ targetRouteId, targetSearch }) => {
      const app = document.querySelector("openclaw-app") as HTMLElement & {
        runtime?: {
          context: {
            navigate: (routeId: string, options?: { search?: string }) => void;
          };
        };
      };
      if (!app.runtime) {
        throw new Error("OpenClaw application runtime is unavailable");
      }
      app.runtime.context.navigate(targetRouteId, { search: targetSearch });
    },
    { targetRouteId: routeId, targetSearch: search },
  );
}

/**
 * Chat first pushes its base path and then commits the canonical session path.
 * A repeated URL alone cannot prove that the router has finished, so require
 * the successful active match and browser location to agree before leaving.
 */
export async function waitForCommittedChatRoute(page: Page) {
  await waitForControlUiRoute(page, { pathnamePrefix: "/chat/", routeId: "chat" });
}

export async function choosePackagesFolder(page: Page) {
  await page.locator("#new-session-project-trigger").click();
  await page.getByRole("button", { name: "Browse folders" }).click();
  await page.locator(".new-session-page__browser-entry", { hasText: "packages" }).click();
  await page.getByRole("button", { name: "Use this folder" }).click();
}
