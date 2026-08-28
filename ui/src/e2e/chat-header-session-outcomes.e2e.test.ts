import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import { beforeAll, expect, it } from "vitest";
import {
  chatSessionListResponse,
  controlUiSessionPath,
  createChatFlowE2eSuite,
  installMockGateway,
} from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();
const captureProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const proofDir = path.join(
  process.cwd(),
  ".artifacts",
  "control-ui-e2e",
  "header-outcomes-followup",
);

async function capture(page: Page, name: string): Promise<void> {
  if (captureProof) {
    await page.screenshot({ path: path.join(proofDir, name) });
  }
}

async function navigateAwayAndBack(page: Page, sessionA: string, sessionB: string): Promise<void> {
  for (const sessionKey of [sessionB, sessionA]) {
    await page
      .locator(
        `.sidebar-recent-session[data-session-key="${sessionKey}"] a.sidebar-recent-session__link`,
      )
      .click();
    await expect.poll(() => new URL(page.url()).pathname).toBe(controlUiSessionPath(sessionKey));
    await expect
      .poll(() =>
        page
          .locator(".chat-pane-cache__pane--visible")
          .evaluate((pane) => (pane as HTMLElement & { sessionKey?: string }).sessionKey),
      )
      .toBe(sessionKey);
  }
}

function proofContextOptions() {
  return {
    locale: "en-US",
    serviceWorkers: "block" as const,
    viewport: { height: 900, width: 1280 },
    ...(captureProof ? { recordVideo: { dir: proofDir, size: { height: 900, width: 1280 } } } : {}),
  };
}

async function installPlacementGateway(page: Page, sessionA: string, sessionB: string) {
  return installMockGateway(page, {
    featureMethods: ["chat.startup", "sessions.reclaim"],
    historyMessages: [{ role: "assistant", content: "Placement outcome proof." }],
    methodResponses: {
      "sessions.list": chatSessionListResponse([
        {
          key: sessionA,
          kind: "direct",
          label: "Session A",
          updatedAt: 2,
          placement: {
            state: "active",
            generation: 1,
            createdAtMs: 1,
            updatedAtMs: 1,
            stateChangedAtMs: 1,
            environmentId: "worker:one",
            activeOwnerEpoch: 1,
            workerBundleHash: "a".repeat(64),
            workspaceBaseManifestRef: "base-manifest",
            remoteWorkspaceDir: "/workspace/session-a",
          },
        },
        { key: sessionB, kind: "direct", label: "Session B", updatedAt: 1 },
      ]),
    },
    sessionKey: sessionA,
  });
}

async function startPlacementReclaim(
  page: Page,
  gateway: Awaited<ReturnType<typeof installMockGateway>>,
): Promise<void> {
  await page.goto(`${suite.server.baseUrl}chat`);
  await gateway.deferNext("sessions.reclaim");
  await page.getByRole("button", { name: "Runs on Cloud" }).click();
  await page.getByText("Stop cloud worker…", { exact: true }).click();
  await page.getByRole("button", { name: "Stop worker" }).click();
  await gateway.waitForRequest("sessions.reclaim");
}

suite.define(() => {
  beforeAll(async () => {
    if (captureProof) {
      await mkdir(proofDir, { recursive: true });
    }
  });

  it("does not resurrect a reveal failure after navigating away", async () => {
    const context = await suite.newBrowserContext(proofContextOptions());
    const page = await context.newPage();
    const sessionA = "agent:main:session-a";
    const sessionB = "agent:main:session-b";
    const gateway = await installMockGateway(page, {
      featureMethods: ["chat.startup", "sessions.files.reveal"],
      historyMessages: [{ role: "assistant", content: "Session outcome proof." }],
      methodResponses: {
        "sessions.list": chatSessionListResponse([
          {
            key: sessionA,
            kind: "direct",
            label: "Session A",
            spawnedCwd: "/workspace/session-a",
            updatedAt: 2,
          },
          {
            key: sessionB,
            kind: "direct",
            label: "Session B",
            spawnedCwd: "/workspace/session-b",
            updatedAt: 1,
          },
        ]),
      },
      sessionKey: sessionA,
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      await gateway.deferNext("sessions.files.reveal");
      await page.getByRole("button", { name: "Workspace actions for session-a" }).click();
      await page.getByRole("menuitem", { name: "Open in file manager" }).click();
      await gateway.waitForRequest("sessions.files.reveal");

      await navigateAwayAndBack(page, sessionA, sessionB);
      await gateway.resolveDeferred("sessions.files.reveal", {
        ok: false,
        error: "Stale reveal failure must stay retired.",
      });
      await page.evaluate(
        () =>
          new Promise<void>((resolve) => {
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
          }),
      );
      await expect
        .poll(() => page.getByText("Stale reveal failure must stay retired.").count())
        .toBe(0);
      await expect
        .poll(() =>
          page.locator(".chat-pane-cache__pane--visible").evaluate((pane) => {
            return (pane as HTMLElement & { state?: { chatError?: string | null } }).state
              ?.chatError;
          }),
        )
        .not.toBe("Stale reveal failure must stay retired.");
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it("does not resurrect a placement reclaim failure after navigating away", async () => {
    const context = await suite.newBrowserContext(proofContextOptions());
    const page = await context.newPage();
    const sessionA = "agent:main:placement-a";
    const sessionB = "agent:main:placement-b";
    const gateway = await installPlacementGateway(page, sessionA, sessionB);

    try {
      await startPlacementReclaim(page, gateway);
      await capture(page, "01-placement-pending.png");

      await navigateAwayAndBack(page, sessionA, sessionB);
      const message = "Stale placement failure must stay retired.";
      await gateway.rejectDeferred("sessions.reclaim", { code: "INVALID_REQUEST", message });
      await expect.poll(() => page.getByText(message).count()).toBe(0);
      await expect
        .poll(() =>
          page.locator(".chat-pane-cache__pane--visible").evaluate((pane) => {
            return (pane as HTMLElement & { state?: { chatError?: string | null } }).state
              ?.chatError;
          }),
        )
        .not.toBe(message);
      await capture(page, "02-placement-returned.png");
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it("keeps a current placement reclaim failure visible and retryable", async () => {
    const context = await suite.newBrowserContext(proofContextOptions());
    const page = await context.newPage();
    const sessionA = "agent:main:placement-current";
    const sessionB = "agent:main:placement-other";
    const gateway = await installPlacementGateway(page, sessionA, sessionB);

    try {
      await startPlacementReclaim(page, gateway);
      const message = "Current placement failure stays actionable.";
      await gateway.rejectDeferred("sessions.reclaim", { code: "INVALID_REQUEST", message });

      const visiblePane = page.locator(".chat-pane-cache__pane--visible");
      await expect
        .poll(() =>
          visiblePane.evaluate(
            (pane) => (pane as HTMLElement & { sessionKey?: string }).sessionKey,
          ),
        )
        .toBe(sessionA);
      await visiblePane
        .getByRole("alert")
        .locator("summary")
        .getByText(message, { exact: true })
        .waitFor();

      await page.getByRole("button", { name: "Runs on Cloud" }).click();
      await page.getByText("Stop cloud worker…", { exact: true }).waitFor();
      await capture(page, "00-placement-current-failure.png");
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it("does not resurrect a sharing failure after navigating away", async () => {
    const context = await suite.newBrowserContext(proofContextOptions());
    const page = await context.newPage();
    const sessionA = "agent:main:sharing-a";
    const sessionB = "agent:main:sharing-b";
    const gateway = await installMockGateway(page, {
      allowedSessionVisibilities: ["shared", "draft"],
      featureMethods: ["chat.startup", "session.visibility.set"],
      historyMessages: [{ role: "assistant", content: "Sharing outcome proof." }],
      methodResponses: {
        "sessions.list": chatSessionListResponse([
          {
            key: sessionA,
            kind: "direct",
            label: "Session A",
            sessionId: "sharing-session-a",
            sharingRole: "owner",
            visibility: "draft",
            updatedAt: 2,
          },
          {
            key: sessionB,
            kind: "direct",
            label: "Session B",
            sessionId: "sharing-session-b",
            sharingRole: "owner",
            visibility: "shared",
            updatedAt: 1,
          },
        ]),
      },
      sessionKey: sessionA,
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      await gateway.deferNext("session.visibility.set");
      await page.getByRole("button", { name: "Session sharing" }).click();
      await page.getByText("Publish draft", { exact: true }).click();
      await gateway.waitForRequest("session.visibility.set");
      await capture(page, "03-sharing-pending.png");

      await navigateAwayAndBack(page, sessionA, sessionB);
      const message = "Stale sharing failure must stay retired.";
      await gateway.rejectDeferred("session.visibility.set", {
        code: "INVALID_REQUEST",
        message,
      });
      await expect.poll(() => page.getByText(message).count()).toBe(0);
      await page.getByRole("button", { name: "Session sharing" }).click();
      await expect.poll(() => page.locator(".chat-pane__sharing-status--error").count()).toBe(0);
      await capture(page, "04-sharing-returned.png");
    } finally {
      await suite.closeBrowserContext(context);
    }
  });
});
