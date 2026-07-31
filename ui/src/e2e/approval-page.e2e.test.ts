import { copyFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page, type Video } from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type {
  AllowedApprovalSnapshot,
  PendingApprovalSnapshot,
} from "../../../packages/gateway-protocol/src/index.js";
import {
  canRunPlaywrightChromium,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
  type MockGatewayControls,
} from "../test-helpers/control-ui-e2e.ts";

const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const chromiumAvailable = canRunPlaywrightChromium(chromiumExecutablePath);
const allowMissingChromium = process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM === "1";
const describeControlUiE2e = chromiumAvailable || !allowMissingChromium ? describe : describe.skip;

const APPROVAL_ID = "Approval:Mobile/東京 100% 🦞";
const APPROVAL_NOW_MS = Date.UTC(2026, 6, 10, 18, 0, 0);
const ARTIFACT_DIR = path.resolve(".artifacts/control-ui-e2e/approval-page");
const MOBILE_RAW_VIDEO_DIR = path.join(ARTIFACT_DIR, "mobile-raw");
const MOBILE_VIEWPORT = { height: 844, width: 390 } as const;
const DESKTOP_VIEWPORT = { height: 800, width: 1200 } as const;

type ApprovalSurface = {
  context: BrowserContext;
  gateway: MockGatewayControls;
  page: Page;
  pageErrors: string[];
  rawVideoDir?: string;
};

let browser: Browser | undefined;
let server: ControlUiE2eServer | undefined;
const openContexts = new Set<BrowserContext>();
const rawVideoDirs = new Set<string>();

function approvalPath(basePath: string): string {
  return `${basePath}/approve/${encodeURIComponent(APPROVAL_ID)}`;
}

function approvalUrl(basePath: string): string {
  return new URL(approvalPath(basePath), server?.baseUrl ?? "http://127.0.0.1/").href;
}

function pendingApproval(basePath: string): PendingApprovalSnapshot {
  const commandLines = Array.from(
    { length: 14 },
    (_value, index) =>
      `step-${String(index + 1).padStart(2, "0")}: curl --header "Authorization: <redacted>" https://example.invalid/review`,
  );
  return {
    id: APPROVAL_ID,
    status: "pending",
    urlPath: approvalPath(basePath),
    createdAtMs: APPROVAL_NOW_MS - 30_000,
    expiresAtMs: APPROVAL_NOW_MS + 5 * 60_000,
    presentation: {
      kind: "exec",
      commandText: commandLines.join("\n"),
      commandPreview: 'curl --header "Authorization: <redacted>" …',
      warningText: "This command requests external network access.",
      host: "gateway",
      nodeId: null,
      agentId: "main",
      allowedDecisions: ["allow-once", "deny"],
    },
  };
}

function allowedApproval(pending: PendingApprovalSnapshot): AllowedApprovalSnapshot {
  return {
    ...pending,
    status: "allowed",
    decision: "allow-once",
    reason: "user",
    resolvedAtMs: APPROVAL_NOW_MS,
  };
}

function requireBrowser(): Browser {
  if (!browser) {
    throw new Error("Control UI E2E browser is not running");
  }
  return browser;
}

async function createSurface(params: {
  basePath: string;
  deferredMethods?: string[];
  pending: PendingApprovalSnapshot;
  recordVideo?: boolean;
  viewport: { height: number; width: number };
}): Promise<ApprovalSurface> {
  const rawVideoDir = params.recordVideo ? MOBILE_RAW_VIDEO_DIR : undefined;
  if (rawVideoDir) {
    await mkdir(ARTIFACT_DIR, { recursive: true });
    await rm(rawVideoDir, { force: true, recursive: true });
    await mkdir(rawVideoDir, { recursive: true });
    rawVideoDirs.add(rawVideoDir);
  }
  const context = await requireBrowser().newContext({
    colorScheme: "dark",
    hasTouch: params.viewport.width <= MOBILE_VIEWPORT.width,
    isMobile: params.viewport.width <= MOBILE_VIEWPORT.width,
    locale: "en-US",
    reducedMotion: "reduce",
    serviceWorkers: "block",
    viewport: params.viewport,
    ...(rawVideoDir ? { recordVideo: { dir: rawVideoDir, size: params.viewport } } : {}),
  });
  openContexts.add(context);
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  await page.clock.setFixedTime(new Date(APPROVAL_NOW_MS));
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(String(error)));
  const gateway = await installMockGateway(page, {
    basePath: params.basePath,
    deferredMethods: params.deferredMethods,
    methodResponses: {
      "approval.get": { approval: params.pending },
    },
  });
  return { context, gateway, page, pageErrors, rawVideoDir };
}

async function closeRecordedSurface(surface: ApprovalSurface, targetName: string): Promise<void> {
  const video: Video | null = surface.page.video();
  openContexts.delete(surface.context);
  await surface.context.close().catch(() => {});
  if (!video || !surface.rawVideoDir) {
    return;
  }
  const rawVideoPath = await video.path();
  await copyFile(rawVideoPath, path.join(ARTIFACT_DIR, targetName));
  rawVideoDirs.delete(surface.rawVideoDir);
  await rm(surface.rawVideoDir, { force: true, recursive: true });
}

async function waitForApprovalPage(page: Page): Promise<void> {
  await page.locator("openclaw-approval-page").waitFor();
  await page.getByText("Waiting for your decision", { exact: true }).waitFor();
}

async function expectStandaloneApprovalPage(page: Page): Promise<void> {
  expect(await page.locator("openclaw-approval-page").count()).toBe(1);
  expect(await page.locator(".approval-page").count()).toBe(1);
  expect(await page.locator("openclaw-app-shell, .shell").count()).toBe(0);
  expect(await page.locator("openclaw-app-topbar, openclaw-app-sidebar").count()).toBe(0);
  expect(await page.locator("openclaw-exec-approval").count()).toBe(0);
}

async function expectNoDecisionButtons(page: Page): Promise<void> {
  await expect
    .poll(async () => {
      const allowCount = await page.getByRole("button", { name: "Allow once" }).count();
      const denyCount = await page.getByRole("button", { name: "Deny" }).count();
      return allowCount + denyCount;
    })
    .toBe(0);
}

async function waitForStableApprovalPaint(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
  });
  if (page.viewportSize()?.width !== MOBILE_VIEWPORT.width) {
    return;
  }
  await expect
    .poll(async () => {
      const bounds = await page.locator(".approval-page__card").boundingBox();
      return Boolean(
        bounds && bounds.x >= 10 && bounds.width >= 350 && bounds.x + bounds.width <= 380,
      );
    })
    .toBe(true);
}

async function expectMobilePendingLayout(page: Page): Promise<void> {
  const allowButton = page.getByRole("button", { name: "Allow once" });
  const denyButton = page.getByRole("button", { name: "Deny" });
  const [allowBounds, denyBounds] = await Promise.all([
    allowButton.boundingBox(),
    denyButton.boundingBox(),
  ]);
  if (!allowBounds || !denyBounds) {
    throw new Error("Approval decision buttons are missing layout bounds");
  }
  expect(allowBounds.height).toBeGreaterThanOrEqual(44);
  expect(denyBounds.height).toBeGreaterThanOrEqual(44);

  const metrics = await page.evaluate(() => {
    const root = document.querySelector<HTMLElement>(".approval-page");
    const card = document.querySelector<HTMLElement>(".approval-page__card");
    const preview = document.querySelector<HTMLElement>(".approval-page__preview");
    if (!root || !card || !preview) {
      throw new Error("Approval page layout elements are missing");
    }
    const rootBounds = root.getBoundingClientRect();
    const cardBounds = card.getBoundingClientRect();
    const previewBounds = preview.getBoundingClientRect();
    const backLink = document.querySelector<HTMLElement>(".approval-page__back-link");
    if (!backLink) {
      throw new Error("Approval page back link is missing");
    }
    const backLinkBounds = backLink.getBoundingClientRect();
    return {
      backLinkTop: backLinkBounds.top,
      cardBottom: cardBounds.bottom,
      cardLeft: cardBounds.left,
      cardRight: cardBounds.right,
      documentOverflow: document.documentElement.scrollWidth - window.innerWidth,
      previewClientHeight: preview.clientHeight,
      previewRight: previewBounds.right,
      previewScrollHeight: preview.scrollHeight,
      rootLeft: rootBounds.left,
      rootRight: rootBounds.right,
      viewportWidth: window.innerWidth,
    };
  });
  expect(metrics.documentOverflow).toBeLessThanOrEqual(0);
  expect(metrics.rootLeft).toBeGreaterThanOrEqual(0);
  expect(metrics.cardLeft).toBeGreaterThanOrEqual(0);
  expect(metrics.rootRight).toBeLessThanOrEqual(metrics.viewportWidth);
  expect(metrics.cardRight).toBeLessThanOrEqual(metrics.viewportWidth);
  expect(metrics.previewRight).toBeLessThanOrEqual(metrics.viewportWidth);
  expect(metrics.previewScrollHeight).toBeGreaterThanOrEqual(metrics.previewClientHeight);
  expect(metrics.backLinkTop).toBeGreaterThanOrEqual(metrics.cardBottom + 10);
}

describeControlUiE2e("Control UI standalone approval page", () => {
  beforeAll(async () => {
    if (!chromiumAvailable) {
      throw new Error(`Playwright Chromium is unavailable at ${chromiumExecutablePath}`);
    }
    server = await startControlUiE2eServer();
    browser = await chromium.launch({ executablePath: chromiumExecutablePath });
  });

  afterEach(async () => {
    await Promise.all([...openContexts].map((context) => context.close().catch(() => {})));
    openContexts.clear();
    await Promise.all(
      [...rawVideoDirs].map((rawVideoDir) => rm(rawVideoDir, { force: true, recursive: true })),
    );
    rawVideoDirs.clear();
  });

  afterAll(async () => {
    await browser?.close().catch(() => {});
    await server?.close();
  });

  it("keeps one canonical winner across conflicting surfaces and terminal reload", async () => {
    const pending = pendingApproval("");
    const terminal = allowedApproval(pending);
    const mobile = await createSurface({
      basePath: "",
      deferredMethods: ["approval.resolve"],
      pending,
      recordVideo: true,
      viewport: MOBILE_VIEWPORT,
    });
    const desktop = await createSurface({
      basePath: "",
      deferredMethods: ["approval.resolve"],
      pending,
      viewport: DESKTOP_VIEWPORT,
    });

    try {
      const [mobileResponse, desktopResponse] = await Promise.all([
        mobile.page.goto(approvalUrl("")),
        desktop.page.goto(approvalUrl("")),
      ]);
      expect(mobileResponse?.status()).toBe(200);
      expect(desktopResponse?.status()).toBe(200);
      await Promise.all([waitForApprovalPage(mobile.page), waitForApprovalPage(desktop.page)]);

      const [mobileGet, desktopGet] = await Promise.all([
        mobile.gateway.waitForRequest("approval.get"),
        desktop.gateway.waitForRequest("approval.get"),
      ]);
      expect(mobileGet.params).toEqual({ id: APPROVAL_ID });
      expect(desktopGet.params).toEqual({ id: APPROVAL_ID });
      expect(new URL(mobile.page.url()).pathname).toBe(approvalPath(""));
      await Promise.all([
        expectStandaloneApprovalPage(mobile.page),
        expectStandaloneApprovalPage(desktop.page),
      ]);
      await expectMobilePendingLayout(mobile.page);
      expect(await mobile.page.title()).toBe("Command approval — OpenClaw");
      await waitForStableApprovalPaint(mobile.page);
      await mobile.page.screenshot({
        path: path.join(ARTIFACT_DIR, "01-pending-mobile.png"),
      });
      await mobile.page.getByRole("button", { name: "Allow once" }).scrollIntoViewIfNeeded();
      await waitForStableApprovalPaint(mobile.page);
      await mobile.page.screenshot({
        path: path.join(ARTIFACT_DIR, "01b-pending-actions-mobile.png"),
      });

      await Promise.all([
        mobile.page.getByRole("button", { name: "Allow once" }).click(),
        desktop.page.getByRole("button", { name: "Deny" }).click(),
      ]);
      const [mobileResolve, desktopResolve] = await Promise.all([
        mobile.gateway.waitForRequest("approval.resolve"),
        desktop.gateway.waitForRequest("approval.resolve"),
      ]);
      expect(mobileResolve.params).toEqual({
        id: APPROVAL_ID,
        kind: "exec",
        decision: "allow-once",
      });
      expect(desktopResolve.params).toEqual({
        id: APPROVAL_ID,
        kind: "exec",
        decision: "deny",
      });

      await Promise.all([
        mobile.gateway.setMethodResponse("approval.get", { approval: terminal }),
        desktop.gateway.setMethodResponse("approval.get", { approval: terminal }),
      ]);
      await Promise.all([
        mobile.gateway.resolveDeferred("approval.resolve", {
          applied: true,
          approval: terminal,
        }),
        desktop.gateway.resolveDeferred("approval.resolve", {
          applied: false,
          approval: terminal,
        }),
      ]);

      await Promise.all([
        mobile.page.getByRole("heading", { name: "Approved here", exact: true }).waitFor(),
        desktop.page.getByRole("heading", { name: "Resolved elsewhere", exact: true }).waitFor(),
      ]);
      await Promise.all([
        expectNoDecisionButtons(mobile.page),
        expectNoDecisionButtons(desktop.page),
      ]);
      const terminalFocus = await mobile.page.evaluate(() => {
        const active = document.activeElement as HTMLElement | null;
        const bounds = active?.getBoundingClientRect();
        return {
          bottom: bounds?.bottom ?? Number.POSITIVE_INFINITY,
          id: active?.id ?? null,
          top: bounds?.top ?? Number.NEGATIVE_INFINITY,
          viewportHeight: window.innerHeight,
        };
      });
      expect(terminalFocus.id).toBe("approval-page-title");
      expect(terminalFocus.top).toBeGreaterThanOrEqual(0);
      expect(terminalFocus.bottom).toBeLessThanOrEqual(terminalFocus.viewportHeight);
      expect(await mobile.page.title()).toBe("Approved here — OpenClaw");
      await waitForStableApprovalPaint(mobile.page);
      await mobile.page.screenshot({
        path: path.join(ARTIFACT_DIR, "02-competing-answer-terminal.png"),
      });
      await waitForStableApprovalPaint(desktop.page);
      await desktop.page.screenshot({
        path: path.join(ARTIFACT_DIR, "02b-competing-answer-loser-desktop.png"),
      });

      const terminalReload = await mobile.page.reload();
      expect(terminalReload?.status()).toBe(200);
      await mobile.gateway.waitForRequest("approval.get");
      await mobile.page.getByRole("heading", { name: "Approved", exact: true }).waitFor();
      expect(await mobile.page.title()).toBe("Approved — OpenClaw");
      expect(new URL(mobile.page.url()).pathname).toBe(approvalPath(""));
      await expectStandaloneApprovalPage(mobile.page);
      await expectNoDecisionButtons(mobile.page);
      await waitForStableApprovalPaint(mobile.page);
      await mobile.page.screenshot({
        path: path.join(ARTIFACT_DIR, "03-terminal-reload-mobile.png"),
      });

      expect(mobile.pageErrors).toEqual([]);
      expect(desktop.pageErrors).toEqual([]);
    } finally {
      await closeRecordedSurface(mobile, "approval-page-mobile.webm");
    }
  });

  it("preserves a mounted deep link across the authentication gate", async () => {
    const basePath = "/openclaw";
    const pending = pendingApproval(basePath);
    const surface = await createSurface({
      basePath,
      deferredMethods: ["connect"],
      pending,
      viewport: MOBILE_VIEWPORT,
    });

    const response = await surface.page.goto(approvalUrl(basePath));
    expect(response?.status()).toBe(200);
    await surface.gateway.waitForRequest("connect");
    await surface.page.locator("openclaw-login-gate").waitFor();
    expect(new URL(surface.page.url()).pathname).toBe(approvalPath(basePath));
    expect(await surface.gateway.getRequests("approval.get")).toHaveLength(0);

    await surface.gateway.resolveDeferred("connect");
    await waitForApprovalPage(surface.page);
    const request = await surface.gateway.waitForRequest("approval.get");
    expect(request.params).toEqual({ id: APPROVAL_ID });
    expect(new URL(surface.page.url()).pathname).toBe(approvalPath(basePath));
    await expectStandaloneApprovalPage(surface.page);
    expect(surface.pageErrors).toEqual([]);
  });

  it("uses the page Gateway without replacing a saved remote selection", async () => {
    const pending = pendingApproval("");
    const surface = await createSurface({
      basePath: "",
      pending,
      viewport: MOBILE_VIEWPORT,
    });
    const appUrl = new URL(server?.baseUrl ?? "http://127.0.0.1/");
    const pageGatewayScope = `ws://${appUrl.host}`;
    const selectionKey = `openclaw.control.currentGateway.v1:${pageGatewayScope}`;
    const pageGateway = `ws://${appUrl.hostname}:18789`;
    const pageSettingsKey = `openclaw.control.settings.v1:${pageGateway}`;
    const pageSettings = JSON.stringify({
      gatewayUrl: pageGateway,
      theme: "claw",
      sessionKey: "agent:page:saved",
    });
    const remoteGateway = "wss://saved-remote.example.test";
    const remoteSettingsKey = `openclaw.control.settings.v1:${remoteGateway}`;
    await surface.page.addInitScript(
      ({
        nextPageSettings,
        nextPageSettingsKey,
        nextRemoteGateway,
        nextRemoteSettingsKey,
        nextSelectionKey,
      }) => {
        localStorage.setItem(nextPageSettingsKey, nextPageSettings);
        localStorage.setItem(
          nextRemoteSettingsKey,
          JSON.stringify({ gatewayUrl: nextRemoteGateway }),
        );
        localStorage.setItem(nextSelectionKey, nextRemoteGateway);
      },
      {
        nextPageSettings: pageSettings,
        nextPageSettingsKey: pageSettingsKey,
        nextRemoteGateway: remoteGateway,
        nextRemoteSettingsKey: remoteSettingsKey,
        nextSelectionKey: selectionKey,
      },
    );

    await surface.page.goto(
      `${approvalUrl("")}#token=approval-document-token&session=agent%3Aapproval%3Atemporary`,
    );
    await waitForApprovalPage(surface.page);
    const startupHash = new URLSearchParams(new URL(surface.page.url()).hash.slice(1));
    expect(startupHash.has("token")).toBe(false);
    expect(startupHash.get("session")).toBe("agent:approval:temporary");
    const socketUrls = await surface.gateway.getSocketUrls();
    expect(socketUrls.length).toBeGreaterThan(0);
    expect(new URL(socketUrls.at(-1) ?? "ws://invalid").origin).toBe(pageGateway);
    expect(await surface.page.evaluate((key) => localStorage.getItem(key), selectionKey)).toBe(
      remoteGateway,
    );
    expect(await surface.page.evaluate((key) => localStorage.getItem(key), pageSettingsKey)).toBe(
      pageSettings,
    );
    expect(surface.pageErrors).toEqual([]);
  });

  it("renders changed Gateway content after reload instead of a hard-coded fixture", async () => {
    const pending = pendingApproval("");
    if (pending.presentation.kind !== "exec") {
      throw new Error("Expected an exec approval fixture");
    }
    const surface = await createSurface({
      basePath: "",
      pending,
      viewport: MOBILE_VIEWPORT,
    });

    await surface.page.goto(approvalUrl(""));
    await waitForApprovalPage(surface.page);
    const changed = {
      ...pending,
      presentation: {
        ...pending.presentation,
        commandText: "printf 'fixture changed at the Gateway'",
        warningText: "Changed warning from the live approval fixture.",
      },
    } satisfies PendingApprovalSnapshot;
    await surface.gateway.setMethodResponse("approval.get", { approval: changed });

    await surface.page.reload();
    await surface.gateway.waitForRequest("approval.get");
    await surface.page.getByText("Changed warning from the live approval fixture.").waitFor();
    await surface.page
      .getByText("printf 'fixture changed at the Gateway'", { exact: true })
      .waitFor();
    expect(surface.pageErrors).toEqual([]);
  });

  it("fails closed on malformed Gateway data", async () => {
    const surface = await createSurface({
      basePath: "",
      pending: pendingApproval(""),
      viewport: MOBILE_VIEWPORT,
    });
    await surface.page.goto(approvalUrl(""));
    await waitForApprovalPage(surface.page);
    await surface.gateway.setMethodResponse("approval.get", {
      approval: { id: APPROVAL_ID, status: "pending" },
    });

    await surface.page.reload();
    await surface.page.getByRole("heading", { name: "Approval unavailable" }).waitFor();
    await expectStandaloneApprovalPage(surface.page);
    await expectNoDecisionButtons(surface.page);
    expect(surface.pageErrors).toEqual([]);
  });

  it("retains context but disables decisions through a reconnect", async () => {
    const pending = pendingApproval("");
    const surface = await createSurface({
      basePath: "",
      pending,
      viewport: MOBILE_VIEWPORT,
    });
    await surface.page.goto(approvalUrl(""));
    await waitForApprovalPage(surface.page);
    const initialConnectCount = (await surface.gateway.getRequests("connect")).length;
    await surface.gateway.deferNext("connect");

    await surface.gateway.closeLatest(1012, "test reconnect");
    await Promise.all([
      surface.page.getByText("Connection interrupted", { exact: true }).waitFor(),
      expect
        .poll(async () => (await surface.gateway.getRequests("connect")).length)
        .toBeGreaterThan(initialConnectCount),
    ]);
    expect(await surface.page.locator(".approval-page__preview").textContent()).toContain(
      "step-01",
    );
    expect(await surface.page.getByRole("button", { name: "Allow once" }).isDisabled()).toBe(true);
    await surface.page
      .getByText(
        "OpenClaw cannot confirm or record a decision while disconnected. Reconnect to check the current status.",
        { exact: true },
      )
      .waitFor();

    await surface.gateway.resolveDeferred("connect");
    await surface.gateway.waitForRequest("approval.get");
    await expect
      .poll(() => surface.page.getByRole("button", { name: "Allow once" }).isEnabled())
      .toBe(true);
    expect(surface.pageErrors).toEqual([]);
  });
});
