import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  canRunPlaywrightChromium,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
} from "../test-helpers/control-ui-e2e.ts";

const executablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const available = canRunPlaywrightChromium(executablePath);
const allowMissing = process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM === "1";
const suite = available || !allowMissing ? describe : describe.skip;
const captureUiProofEnabled = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const collapsedSessionSectionsStorageKey = "openclaw:sidebar:sessions:collapsed-sections";
const uiProofArtifactDir = path.join(
  process.cwd(),
  ".artifacts",
  "control-ui-e2e",
  "native-session-discovery",
);

let browser: Browser;
let server: ControlUiE2eServer;

suite("native session sidebar", () => {
  beforeAll(async () => {
    if (!available) {
      throw new Error(`Playwright Chromium is unavailable at ${executablePath}`);
    }
    server = await startControlUiE2eServer();
    browser = await chromium.launch({ executablePath });
  });

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it("hides empty native hosts and the empty Coding section", async () => {
    const page = await browser.newPage({
      deviceScaleFactor: 2,
      viewport: { height: 1100, width: 1440 },
    });
    await page.addInitScript(
      (key) => localStorage.removeItem(key),
      collapsedSessionSectionsStorageKey,
    );
    await installMockGateway(page, {
      featureMethods: ["chat.metadata", "chat.startup", "sessions.catalog.list"],
      methodResponses: {
        "sessions.catalog.list": {
          catalogs: [
            {
              id: "codex",
              label: "Codex",
              capabilities: { continueSession: true, archive: true },
              hosts: [
                {
                  hostId: "gateway:local",
                  label: "Gateway",
                  kind: "gateway",
                  connected: true,
                  sessions: [
                    {
                      threadId: "thread-shared",
                      name: "Shared gateway session",
                      cwd: "/workspace/openclaw",
                      status: "idle",
                      archived: false,
                      canContinue: true,
                      canArchive: true,
                    },
                  ],
                },
                {
                  hostId: "node:remote",
                  label: "Remote Workstation",
                  kind: "node",
                  connected: true,
                  nodeId: "remote",
                  sessions: [
                    {
                      threadId: "thread-remote",
                      name: "Remote-only session",
                      cwd: "/workspace/remote",
                      status: "idle",
                      archived: false,
                      canContinue: false,
                      canArchive: false,
                    },
                  ],
                },
                {
                  hostId: "node:empty",
                  label: "Empty Workstation",
                  kind: "node",
                  connected: true,
                  nodeId: "empty",
                  sessions: [],
                },
              ],
            },
          ],
        },
      },
    });

    try {
      await page.goto(`${server.baseUrl}chat`);
      await page.evaluate(() => {
        document.documentElement.setAttribute("data-theme", "openknot");
        document.documentElement.setAttribute("data-theme-mode", "dark");
      });
      const sessionGroups = page.locator(".sidebar-recent-sessions");
      const section = sessionGroups.locator(':scope > [data-session-section="catalog:codex"]');
      await section.waitFor({ state: "visible" });
      await section.getByText("Shared gateway session", { exact: true }).waitFor();
      await section.getByText("Remote-only session", { exact: true }).waitFor();
      if (captureUiProofEnabled) {
        await mkdir(uiProofArtifactDir, { recursive: true });
        await sessionGroups.screenshot({
          animations: "disabled",
          path: path.join(uiProofArtifactDir, "08-after-deduplicated-session-hosts.png"),
        });
      }

      expect(await sessionGroups.locator(':scope > [data-session-section="work"]').count()).toBe(0);
      expect(await section.getByText("Shared gateway session", { exact: true }).count()).toBe(1);
      expect(await section.locator('[data-session-catalog-host="node:remote"]').count()).toBe(1);
      expect(await section.locator('[data-session-catalog-host="node:empty"]').count()).toBe(0);
    } finally {
      await page.close();
    }
  });
});
