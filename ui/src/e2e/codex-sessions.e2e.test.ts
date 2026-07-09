// Control UI E2E covers the host-federated, read-only Codex Sessions plugin tab.
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  canRunPlaywrightChromium,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
} from "../test-helpers/control-ui-e2e.ts";

const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const chromiumAvailable = canRunPlaywrightChromium(chromiumExecutablePath);
const allowMissingChromium = process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM === "1";
const describeControlUiE2e = chromiumAvailable || !allowMissingChromium ? describe : describe.skip;

let browser: Browser;
let server: ControlUiE2eServer;

async function captureUiProof(page: Page, fileName: string) {
  if (process.env.OPENCLAW_CAPTURE_UI_PROOF !== "1") {
    return;
  }
  const artifactDir = path.join(process.cwd(), ".artifacts", "control-ui-e2e", "codex-sessions");
  await mkdir(artifactDir, { recursive: true });
  await page.screenshot({ fullPage: true, path: path.join(artifactDir, fileName) });
}

function session(threadId: string, name: string, status = "notLoaded") {
  return {
    archived: false,
    cwd: "/Users/example/Projects/sample-app",
    gitBranch: "codex/session-fleet",
    modelProvider: "openai",
    name,
    recencyAt: 1_783_552_800,
    source: "vscode",
    status,
    threadId,
  };
}

describeControlUiE2e("Codex Sessions mocked Gateway E2E", () => {
  beforeAll(async () => {
    if (!chromiumAvailable) {
      throw new Error(
        `Playwright Chromium is not installed or cannot start at ${chromiumExecutablePath}. Run \`pnpm --dir ui exec playwright install --with-deps chromium\`, or set OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM=1 only when intentionally skipping this lane.`,
      );
    }
    server = await startControlUiE2eServer();
    browser = await chromium.launch({ executablePath: chromiumExecutablePath });
  });

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it("searches, paginates, and switches archives without hiding offline hosts", async () => {
    const context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 980, width: 1440 },
    });
    const page = await context.newPage();
    const devbox = {
      connected: true,
      hostId: "node:devbox",
      kind: "node",
      label: "Development Box",
      nextCursor: "devbox-page-2",
      nodeId: "devbox",
      sessions: [
        session("00000000-0000-4000-8000-000000000001", "Current Codex UI session", "active"),
      ],
    };
    const studio = {
      connected: true,
      endpointId: "local",
      hostId: "gateway:local",
      kind: "gateway",
      label: "Studio Gateway",
      sessions: [session("demo-local-thread", "Local release checklist")],
    };
    const offline = {
      connected: false,
      error: { code: "NODE_OFFLINE", message: "Node is not connected" },
      hostId: "node:travel-mac",
      kind: "node",
      label: "Travel Mac",
      nodeId: "travel-mac",
      sessions: [],
    };
    const gateway = await installMockGateway(page, {
      controlUiTabs: [
        {
          group: "control",
          icon: "terminal",
          id: "sessions",
          label: "Codex Sessions",
          pluginId: "codex-supervisor",
        },
      ],
      methodResponses: {
        "codex-supervisor.sessions.list": {
          cases: [
            {
              match: {
                cursors: { "node:devbox": "devbox-page-2" },
                hostIds: ["node:devbox"],
              },
              response: {
                hosts: [
                  {
                    ...devbox,
                    nextCursor: undefined,
                    sessions: [session("demo-next-thread", "Follow-up on the dev box")],
                  },
                ],
              },
            },
            {
              match: { archived: true },
              response: {
                hosts: [
                  {
                    ...studio,
                    sessions: [
                      {
                        ...session("demo-archived-thread", "Archived migration"),
                        archived: true,
                      },
                    ],
                  },
                  offline,
                ],
              },
            },
            {
              match: { search: "Current" },
              response: { hosts: [{ ...devbox, nextCursor: undefined }] },
            },
            { match: { archived: false }, response: { hosts: [devbox, studio, offline] } },
          ],
        },
      },
    });

    try {
      await page.goto(`${server.baseUrl}plugin?plugin=codex-supervisor&id=sessions`);
      const initialRequest = await gateway.waitForRequest("codex-supervisor.sessions.list");
      expect(initialRequest.params).toEqual({ archived: false, limitPerHost: 40 });

      await expect
        .poll(() =>
          page.getByRole("heading", { name: "Sessions across your computers" }).isVisible(),
        )
        .toBe(true);
      await expect.poll(() => page.getByText("Current Codex UI session").isVisible()).toBe(true);
      await expect
        .poll(() => page.getByText("00000000-0000-4000-8000-000000000001").isVisible())
        .toBe(true);
      await expect.poll(() => page.getByText("Travel Mac").isVisible()).toBe(true);
      await expect.poll(() => page.getByText("Node is not connected").isVisible()).toBe(true);
      await captureUiProof(page, "01-hosts-and-partial-error.png");

      await page.getByRole("button", { name: "Load more" }).click();
      await expect
        .poll(async () => (await gateway.getRequests("codex-supervisor.sessions.list")).length)
        .toBeGreaterThanOrEqual(2);
      await expect.poll(() => page.getByText("Follow-up on the dev box").isVisible()).toBe(true);
      await captureUiProof(page, "02-paginated.png");

      const searchInput = page.getByRole("searchbox", { name: "Search Codex sessions" });
      await searchInput.fill("Current");
      await expect
        .poll(async () =>
          (await gateway.getRequests("codex-supervisor.sessions.list")).some(
            (request) => (request.params as { search?: string })?.search === "Current",
          ),
        )
        .toBe(true);
      await expect.poll(() => page.getByText("Local release checklist").count()).toBe(0);
      await expect.poll(() => page.getByText("Travel Mac").count()).toBe(0);

      await searchInput.fill("");
      await expect
        .poll(async () => {
          const requests = await gateway.getRequests("codex-supervisor.sessions.list");
          return requests.filter(
            (request) =>
              (request.params as { archived?: boolean; search?: string })?.archived === false &&
              !(request.params as { search?: string })?.search,
          ).length;
        })
        .toBeGreaterThanOrEqual(2);
      await expect.poll(() => page.getByText("Local release checklist").isVisible()).toBe(true);
      await expect.poll(() => page.getByText("Travel Mac").isVisible()).toBe(true);
      await page.getByRole("button", { name: "Archived" }).click();
      await expect.poll(() => page.getByText("Archived migration").isVisible()).toBe(true);
      await expect.poll(() => page.getByText("Current Codex UI session").count()).toBe(0);
      await captureUiProof(page, "03-archived.png");
    } finally {
      await context.close();
    }
  });
});
