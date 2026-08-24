import { mkdir } from "node:fs/promises";
import path from "node:path";
import {
  buildControlUiFocusPath,
  type ControlUiFocusBuildTarget,
} from "@openclaw/session-url-contract";
import type { Page, Route, Video } from "playwright";
import { expect, it } from "vitest";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import {
  defaultControlUiFeatureMethods,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const artifactDir = path.resolve(".artifacts/control-ui-e2e/lazy-custom-element-recovery");
const captureUiProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const viewport = { height: 900, width: 1280 };
const sessionKey = "agent:main:dashboard:12345678-90ab-cdef-1234-567890abcdef";

const suite = createControlUiE2eSuite({
  name: "Control UI lazy custom-element recovery",
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not installed or cannot start at ${executablePath}. Run \`pnpm --dir ui exec playwright install --with-deps chromium\`.`,
});

async function installChunkFailure(page: Page, chunk: RegExp) {
  let headCount = 0;
  let chunkRequestCount = 0;
  await page.route("**/*", async (route) => {
    if (route.request().method() !== "HEAD") {
      await route.fallback();
      return;
    }
    headCount += 1;
    if (headCount === 1) {
      await route.fulfill({ status: 503 });
      return;
    }
    await route.fallback();
  });
  await page.route(chunk, async (route: Route) => {
    chunkRequestCount += 1;
    if (chunkRequestCount === 1) {
      await route.abort("internetdisconnected");
      return;
    }
    await route.fallback();
  });
  return { chunkRequestCount: () => chunkRequestCount, headCount: () => headCount };
}

function focusPath(target: ControlUiFocusBuildTarget): string {
  const resolvedPath = buildControlUiFocusPath(target, "");
  if (!resolvedPath) {
    throw new Error(`Could not build focus path for ${target.kind}`);
  }
  return resolvedPath;
}

async function expectRealChunkFailure(page: Page, label: string) {
  const error = page.locator(".lazy-view-error");
  await error.waitFor();
  const text = await error.textContent();
  expect(text).toContain(label);
  expect(text).toContain("Failed to fetch dynamically imported module");
  await error.getByRole("button", { name: "Retry", exact: true }).waitFor();
  await error.getByRole("button", { name: "Close", exact: true }).waitFor();
  return error;
}

async function retryThroughReload(page: Page, error: ReturnType<Page["locator"]>): Promise<void> {
  const reloaded = page.waitForEvent("domcontentloaded");
  await error.getByRole("button", { name: "Retry", exact: true }).click();
  await reloaded;
}

const focusedCases = [
  {
    name: "terminal",
    label: "terminal panel",
    path: focusPath({ kind: "terminal" }),
    chunk: /\/assets\/terminal-panel-registration-[^/?]+\.js(?:\?.*)?$/u,
    gateway: {
      featureMethods: [...defaultControlUiFeatureMethods, "terminal.open"],
      methodResponses: {
        "terminal.list": { sessions: [] },
        "terminal.open": {
          agentId: "main",
          confined: false,
          cwd: "/workspace",
          sessionId: "lazy-terminal-e2e",
          shell: "/bin/bash",
        },
      },
      terminalEnabled: true,
    },
    ready: (page: Page) => page.locator("openclaw-terminal-panel .tp-header").waitFor(),
  },
  {
    name: "desktop",
    label: "desktop panel",
    path: focusPath({ kind: "desktop", control: false }),
    chunk: /\/assets\/desktop-panel-[^/?]+\.js(?:\?.*)?$/u,
    gateway: {
      featureMethods: [...defaultControlUiFeatureMethods, "desktop.observe", "environments.list"],
      methodResponses: {
        "environments.list": {
          environments: [{ id: "gateway", type: "local", status: "available", desktop: true }],
        },
      },
    },
    ready: (page: Page) => page.getByText("Desktop sources", { exact: true }).waitFor(),
  },
  {
    name: "dashboard",
    label: "dashboard document",
    path: focusPath({ kind: "dashboard", path: "/dashboard/main/12345678" }),
    chunk: /\/assets\/board-document-[^/?]+\.js(?:\?.*)?$/u,
    gateway: {
      sessionKey,
      featureMethods: [...defaultControlUiFeatureMethods, "board.get"],
      methodResponses: {
        "sessions.resolve": { ok: true, key: sessionKey },
        "sessions.describe": {
          session: {
            key: sessionKey,
            kind: "direct",
            boardFace: "dashboard",
            displayName: "Lazy dashboard",
            updatedAt: 1,
          },
        },
        "board.get": { sessionKey, revision: 1, tabs: [], widgets: [] },
      },
    },
    ready: (page: Page) => page.locator("openclaw-board-document openclaw-board-view").waitFor(),
  },
];

suite.define(() => {
  for (const testCase of focusedCases) {
    it(`reloads the focused ${testCase.name} after its real hashed chunk fails`, async () => {
      await suite.withPage(
        { locale: "en-US", serviceWorkers: "block", viewport },
        async ({ page }) => {
          const failure = await installChunkFailure(page, testCase.chunk);
          await installMockGateway(page, testCase.gateway);
          let documentRequests = 0;
          page.on("request", (request) => {
            if (request.resourceType() === "document") {
              documentRequests += 1;
            }
          });

          expect(
            (await page.goto(new URL(testCase.path, suite.server.baseUrl).href))?.status(),
          ).toBe(200);
          const error = await expectRealChunkFailure(page, testCase.label);
          const failedPathname = new URL(page.url()).pathname;
          expect(failure.chunkRequestCount()).toBe(1);
          await expect.poll(failure.headCount).toBe(1);
          expect(documentRequests).toBe(1);

          await retryThroughReload(page, error);
          await testCase.ready(page);

          await expect.poll(failure.chunkRequestCount).toBe(2);
          expect(new URL(page.url()).pathname).toBe(failedPathname);
          expect(documentRequests).toBe(2);
        },
      );
    });
  }

  it("restores the command-palette action after a real stale-chunk reload", async () => {
    if (captureUiProof) {
      await mkdir(artifactDir, { recursive: true });
    }
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport,
      ...(captureUiProof ? { recordVideo: { dir: artifactDir, size: viewport } } : {}),
    });
    let video: Video | null = null;
    try {
      const page = await context.newPage();
      if (captureUiProof) {
        video = page.video();
      }
      const failure = await installChunkFailure(
        page,
        /\/assets\/command-palette-[^/?]+\.js(?:\?.*)?$/u,
      );
      await installMockGateway(page);
      await page.goto(`${suite.server.baseUrl}chat`);
      await waitForControlUiGatewayReady(page);

      await page.evaluate(() => {
        window.dispatchEvent(new CustomEvent("openclaw:command-palette-open"));
      });
      const error = await expectRealChunkFailure(page, "command palette");
      await expect.poll(failure.headCount).toBe(1);
      expect(failure.chunkRequestCount()).toBe(1);
      if (captureUiProof) {
        await page.screenshot({
          fullPage: true,
          path: path.join(artifactDir, "failure.png"),
        });
      }

      await retryThroughReload(page, error);
      await page.getByRole("combobox", { name: "Search chats and commands…" }).waitFor();

      await expect.poll(failure.chunkRequestCount).toBe(2);
      expect(await page.locator("openclaw-command-palette").count()).toBe(1);
      if (captureUiProof) {
        await page.waitForTimeout(250);
        await page.screenshot({
          fullPage: true,
          path: path.join(artifactDir, "recovered.png"),
        });
      }
    } finally {
      await suite.closeBrowserContext(context);
      if (captureUiProof && video) {
        await video.saveAs(path.join(artifactDir, "recovery.webm"));
      }
    }
  });
});
