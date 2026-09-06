// Control UI tests cover the session diff panel (sessions.diff RPC).
import path from "node:path";
import type { BrowserContext } from "playwright";
import { beforeEach, expect, it } from "vitest";
import { CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT } from "../../../src/gateway/control-ui-contract.js";
import { SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD } from "../lib/session-pull-requests.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import {
  controlUiBundledSettingsStorageKey,
  controlUiSessionUrl,
  installMockGateway,
  navigateToControlUiSession,
} from "../test-helpers/control-ui-e2e.ts";
import {
  activateChatHeaderPanelAction,
  openChatSidePanelType,
} from "./chat-side-panel.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "session diff panel",
  trackBrowserContexts: true,
  unavailableMessage: (executablePath) => `Playwright Chromium is unavailable at ${executablePath}`,
});
const captureProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
let artifactDir: string;
beforeEach(() => {
  if (captureProof) {
    artifactDir = createControlUiE2eArtifactDir("diff-highlighting");
  }
});

async function newBrowserContext(): Promise<BrowserContext> {
  return await suite.newBrowserContext({
    colorScheme: "light",
    locale: "en-US",
    serviceWorkers: "block",
    viewport: { height: 800, width: 1180 },
  });
}

const APP_PATCH = [
  "diff --git a/src/app.ts b/src/app.ts",
  "index 1111111..2222222 100644",
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -30,3 +30,4 @@",
  " // context line",
  '-const message = "removed line";',
  '+const message = "replacement line";',
  '+console.log("extra line");',
  " // trailing context",
  "",
].join("\n");

const APP_FILE_TEXT = [
  ...Array.from({ length: 29 }, (_, index) => `// unchanged line ${index + 1}`),
  "// context line",
  'const message = "replacement line";',
  'console.log("extra line");',
  "// trailing context",
  "",
].join("\n");

const NOTES_PATCH = [
  "diff --git a/notes.md b/notes.md",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/notes.md",
  "@@ -0,0 +1,2 @@",
  "+# Notes",
  "+scratch",
  "",
].join("\n");

const SESSION_DIFF_RESPONSE = {
  sessionKey: "main",
  root: "/tmp/checkout",
  branch: "feature/panel",
  baseRef: "main",
  files: [
    {
      path: "src/app.ts",
      status: "modified",
      additions: 2,
      deletions: 1,
      patch: APP_PATCH,
    },
    {
      path: "notes.md",
      status: "added",
      additions: 2,
      deletions: 0,
      untracked: true,
      patch: NOTES_PATCH,
    },
  ],
  additions: 4,
  deletions: 1,
};

async function waitForSessionDiff(page: import("playwright").Page): Promise<void> {
  await expect.poll(() => page.locator(".session-diff").count()).toBe(1);
  await expect
    .poll(() => page.locator(".session-diff__filename").allTextContents())
    .toEqual(["app.ts", "notes.md"]);
}

async function seedPersistedReviewLayouts(
  page: import("playwright").Page,
  sessionKeys: string[],
): Promise<void> {
  await page.addInitScript(
    ({ key, persistedSessionKeys }) => {
      const layout = {
        columns: [
          {
            id: "side-panel-column",
            side: "right",
            panels: [{ id: "detail", slot: "detail" }],
            activePanelId: "detail",
            height: 360,
            width: 360,
          },
        ],
        open: true,
        expanded: false,
      };
      localStorage.setItem(
        key,
        JSON.stringify({
          sessionKey: persistedSessionKeys[0],
          lastActiveSessionKey: persistedSessionKeys[0],
          sidebarSessionLayouts: Object.fromEntries(
            persistedSessionKeys.map((sessionKey) => [sessionKey, layout]),
          ),
        }),
      );
    },
    {
      key: controlUiBundledSettingsStorageKey(suite.server.baseUrl),
      persistedSessionKeys: sessionKeys,
    },
  );
}

suite.define(() => {
  it("opens a renamed session diff when Review is added from the panel menu", async () => {
    const context = await newBrowserContext();
    const page = await context.newPage();
    await installMockGateway(page, {
      featureMethods: ["chat.metadata", "chat.startup", "sessions.diff"],
      methodResponses: {
        "sessions.files.list": {
          sessionKey: "main",
          root: "/tmp/checkout",
          gitCheckout: true,
          files: [],
          browser: { path: "", entries: [] },
        },
        "sessions.diff": {
          ...SESSION_DIFF_RESPONSE,
          files: [
            {
              path: "example.ts",
              oldPath: "example.html",
              status: "renamed",
              additions: 1,
              deletions: 1,
              patch:
                '@@ -1 +1 @@\n-<section data-mode="before">Hello</section>\n+const value = "after";',
            },
          ],
          additions: 1,
        },
      },
    });
    await page.goto(`${suite.server.baseUrl}chat`);

    await openChatSidePanelType(page, "Files");
    await openChatSidePanelType(page, "Review");

    await expect
      .poll(() => page.locator(".session-diff__old-path").textContent())
      .toContain("example.html");
    await expect
      .poll(() => page.locator(".chat-diff__row--del .tok-propertyName").textContent())
      .toBe("data-mode");
    await expect
      .poll(() => page.locator(".chat-diff__row--add .tok-keyword").textContent())
      .toBe("const");
  });

  it("requests the default session diff once across subsequent pane renders", async () => {
    const context = await newBrowserContext();
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      featureMethods: ["chat.metadata", "chat.startup", "sessions.diff"],
      methodResponses: {
        "sessions.files.list": {
          sessionKey: "main",
          root: "/tmp/checkout",
          gitCheckout: true,
          files: [],
          browser: { path: "", entries: [] },
        },
        "sessions.diff": SESSION_DIFF_RESPONSE,
      },
    });
    await page.goto(`${suite.server.baseUrl}chat`);

    await openChatSidePanelType(page, "Files");
    await openChatSidePanelType(page, "Review");
    await waitForSessionDiff(page);
    await expect.poll(async () => (await gateway.getRequests("sessions.diff")).length).toBe(1);

    await openChatSidePanelType(page, "Tasks");
    await expect
      .poll(() => page.locator(".tabstrip-tab__label").allTextContents())
      .toContain("Tasks");
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        }),
    );

    expect(await gateway.getRequests("sessions.diff")).toHaveLength(1);
  });

  it("loads the session diff into a persisted empty Review panel", async () => {
    const sessionKey = "agent:main:persisted-review";
    const context = await newBrowserContext();
    const page = await context.newPage();
    await seedPersistedReviewLayouts(page, [sessionKey]);
    await installMockGateway(page, {
      sessionKey,
      featureMethods: ["chat.metadata", "chat.startup", "sessions.diff"],
      methodResponses: {
        "sessions.files.list": {
          sessionKey,
          root: "/tmp/checkout",
          gitCheckout: true,
          files: [],
          browser: { path: "", entries: [] },
        },
        "sessions.diff": { ...SESSION_DIFF_RESPONSE, sessionKey },
      },
    });

    await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));

    await waitForSessionDiff(page);
  });

  it("shows each session's diff and retains its local view state when navigating away", async () => {
    const firstSessionKey = "agent:main:first-review";
    const secondSessionKey = "agent:main:second-review";
    const context = await newBrowserContext();
    const page = await context.newPage();
    await seedPersistedReviewLayouts(page, [firstSessionKey, secondSessionKey]);
    const gateway = await installMockGateway(page, {
      sessionKey: firstSessionKey,
      featureMethods: ["chat.metadata", "chat.startup", "sessions.diff"],
      methodResponses: {
        "sessions.list": {
          count: 2,
          defaults: { contextTokens: null, model: "gpt-5.5", modelProvider: "openai" },
          path: "",
          sessions: [
            { key: firstSessionKey, kind: "direct", updatedAt: 2 },
            { key: secondSessionKey, kind: "direct", updatedAt: 1 },
          ],
          ts: Date.now(),
        },
        "sessions.files.list": {
          cases: [firstSessionKey, secondSessionKey].map((sessionKey) => ({
            match: { sessionKey },
            response: {
              sessionKey,
              root: "/tmp/checkout",
              gitCheckout: true,
              files: [],
              browser: { path: "", entries: [] },
            },
          })),
        },
        "sessions.diff": {
          cases: [
            {
              match: { sessionKey: firstSessionKey },
              response: { ...SESSION_DIFF_RESPONSE, sessionKey: firstSessionKey },
            },
            {
              match: { sessionKey: secondSessionKey },
              response: {
                ...SESSION_DIFF_RESPONSE,
                sessionKey: secondSessionKey,
                files: [
                  {
                    path: "second.md",
                    status: "added",
                    additions: 2,
                    deletions: 0,
                    untracked: true,
                    patch: NOTES_PATCH.replaceAll("notes.md", "second.md"),
                  },
                ],
                additions: 2,
                deletions: 0,
              },
            },
          ],
        },
      },
    });
    await page.goto(controlUiSessionUrl(suite.server.baseUrl, firstSessionKey));
    await waitForSessionDiff(page);
    const firstFileToggle = page.locator(".session-diff__file-toggle").first();
    await firstFileToggle.click();
    await expect.poll(() => firstFileToggle.getAttribute("aria-expanded")).toBe("false");

    await navigateToControlUiSession(page, secondSessionKey);

    await expect
      .poll(() =>
        page
          .locator('openclaw-chat-pane[aria-hidden="false"] .session-diff__filename')
          .allTextContents(),
      )
      .toEqual(["second.md"]);
    await expect
      .poll(async () => (await gateway.getRequests("sessions.diff")).at(-1)?.params)
      .toMatchObject({ sessionKey: secondSessionKey });
    expect(
      await firstFileToggle.evaluate((element) =>
        element.closest("openclaw-chat-pane")?.getAttribute("aria-hidden"),
      ),
    ).toBe("true");

    await navigateToControlUiSession(page, firstSessionKey);
    await expect
      .poll(() =>
        page
          .locator('openclaw-chat-pane[aria-hidden="false"] .session-diff__filename')
          .allTextContents(),
      )
      .toEqual(["app.ts", "notes.md"]);
    expect(await firstFileToggle.getAttribute("aria-expanded")).toBe("false");
    expect(await gateway.getRequests("sessions.diff")).toHaveLength(2);
  });

  it("opens the session diff from the branch change stats", async () => {
    const context = await newBrowserContext();
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      featureMethods: [
        "chat.metadata",
        "chat.startup",
        "sessions.diff",
        SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD,
      ],
      methodResponses: {
        [SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD]: { subscribed: true },
        "sessions.files.list": {
          sessionKey: "main",
          root: "/tmp/checkout",
          gitCheckout: true,
          files: [],
          browser: { path: "", entries: [] },
        },
        "sessions.diff": SESSION_DIFF_RESPONSE,
      },
    });
    await page.goto(`${suite.server.baseUrl}chat`);
    let watchedKey = "";
    await expect
      .poll(async () => {
        const requests = await gateway.getRequests(SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD);
        const params = requests.at(-1)?.params as { sessionKeys?: unknown } | undefined;
        const first = Array.isArray(params?.sessionKeys) ? params.sessionKeys[0] : undefined;
        watchedKey = typeof first === "string" ? first : "";
        return watchedKey;
      })
      .not.toBe("");
    expect(await gateway.getRequests("sessions.files.list")).toHaveLength(0);
    await gateway.emitGatewayEvent(CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT, {
      sessions: {
        [watchedKey]: {
          pullRequests: [],
          branch: {
            owner: "openclaw",
            repo: "openclaw",
            branch: "feature/panel",
            additions: 142,
            deletions: 198,
          },
          rateLimited: false,
          status: "ready",
        },
      },
    });

    await page
      .locator('.chat-pr[data-state="branch"]')
      .getByRole("button", { name: "Show session changes" })
      .click();

    await waitForSessionDiff(page);
    expect(await gateway.getRequests("sessions.files.list")).toHaveLength(0);
  });

  it("lets Review report a non-git session without listing workspace files", async () => {
    const context = await newBrowserContext();
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      featureMethods: ["chat.metadata", "chat.startup", "sessions.diff"],
      methodResponses: {
        "sessions.diff": {
          sessionKey: "main",
          root: "/tmp/plain-workspace",
          files: [],
          additions: 0,
          deletions: 0,
          unavailableReason: "not_git",
        },
      },
    });
    await page.goto(`${suite.server.baseUrl}chat`);
    expect(await gateway.getRequests("sessions.files.list")).toHaveLength(0);
    expect(await gateway.getRequests("sessions.diff")).toHaveLength(0);

    await openChatSidePanelType(page, "Review");

    await expect
      .poll(() => page.locator(".session-diff .session-diff__note").textContent())
      .toContain("not a git checkout");
    expect(await gateway.getRequests("sessions.files.list")).toHaveLength(0);
    expect(await gateway.getRequests("sessions.diff")).toHaveLength(1);
  });

  it("opens the diff sidebar with per-file patches and gap markers", async () => {
    const context = await newBrowserContext();
    const page = await context.newPage();
    const metadata = {
      aheadCount: 2,
      commits: [
        { sha: "def5678", subject: "Second feature change" },
        { sha: "abc1234", subject: "First feature change" },
      ],
      mergeBase: { sha: "0011223", subject: "Initial commit" },
    };
    const gateway = await installMockGateway(page, {
      featureMethods: ["chat.metadata", "chat.startup", "sessions.diff", "sessions.files.get"],
      methodResponses: {
        "sessions.files.get": {
          sessionKey: "main",
          root: "/tmp/checkout",
          file: {
            path: "src/app.ts",
            workspacePath: "src/app.ts",
            name: "app.ts",
            kind: "modified",
            missing: false,
            previewKind: "text",
            contentEncoding: "utf8",
            content: APP_FILE_TEXT,
          },
        },
        "sessions.diff": {
          cases: [
            {
              match: { scope: "uncommitted" },
              response: {
                sessionKey: "main",
                root: "/tmp/checkout",
                branch: "feature/panel",
                baseRef: "main",
                ...metadata,
                files: [
                  {
                    path: "notes.md",
                    status: "added",
                    additions: 2,
                    deletions: 0,
                    untracked: true,
                    patch: NOTES_PATCH,
                  },
                ],
                additions: 2,
                deletions: 0,
              },
            },
            {
              match: { scope: "commit", commit: "abc1234" },
              response: {
                sessionKey: "main",
                root: "/tmp/checkout",
                branch: "feature/panel",
                baseRef: "main",
                ...metadata,
                files: [
                  {
                    path: "src/app.ts",
                    status: "modified",
                    additions: 2,
                    deletions: 1,
                    patch: APP_PATCH,
                  },
                ],
                additions: 2,
                deletions: 1,
              },
            },
            {
              match: { scope: "all" },
              response: {
                sessionKey: "main",
                root: "/tmp/checkout",
                branch: "feature/panel",
                baseRef: "main",
                ...metadata,
                files: [
                  {
                    path: "src/app.ts",
                    status: "modified",
                    additions: 2,
                    deletions: 1,
                    patch: APP_PATCH,
                  },
                  {
                    path: "notes.md",
                    status: "added",
                    additions: 2,
                    deletions: 0,
                    untracked: true,
                    patch: NOTES_PATCH,
                  },
                  {
                    path: "logo.png",
                    status: "modified",
                    additions: 0,
                    deletions: 0,
                    binary: true,
                  },
                ],
                additions: 4,
                deletions: 1,
              },
            },
          ],
        },
      },
    });
    await page.goto(`${suite.server.baseUrl}chat`);

    await activateChatHeaderPanelAction(page, "Show session changes");

    const panel = page.locator(".session-diff");
    await expect.poll(() => panel.count()).toBe(1);
    const panelSurface = page.locator('[data-panel-slot="detail"]').filter({ has: panel });
    await expect
      .poll(() => panelSurface.evaluate((element) => element.getBoundingClientRect().width))
      .toBe(480);
    await expect
      .poll(() => panel.locator(".session-diff__branch-label").textContent())
      .toBe("main → feature/panel");
    await expect
      .poll(async () =>
        (await panel.locator(".session-diff__summary .chat-diffstat").textContent())?.replace(
          /\s/g,
          "",
        ),
      )
      .toBe("+3~1");

    const files = panel.locator(".session-diff__file");
    await expect.poll(() => files.count()).toBe(3);

    const modified = files.first();
    await expect
      .poll(() => modified.locator(".session-diff__filename").textContent())
      .toBe("app.ts");
    await expect.poll(() => modified.locator(".session-diff__directory").textContent()).toBe("src");
    // Hunk starting at old line 30 renders a leading expandable gap marker.
    await expect
      .poll(() => modified.locator(".chat-diff__row--skip").first().textContent())
      .toContain("29 unmodified lines");
    await expect
      .poll(() => modified.locator(".chat-diff__row--add").first().textContent())
      .toContain("replacement line");
    await expect
      .poll(() => modified.locator(".chat-diff__row--add .tok-keyword").textContent())
      .toBe("const");
    expect(
      await modified
        .locator(".chat-diff__row--add .tok-keyword")
        .evaluate(
          (token) => getComputedStyle(token).color !== getComputedStyle(token.parentElement!).color,
        ),
    ).toBe(true);
    if (captureProof) {
      await panelSurface.screenshot({ path: path.join(artifactDir, "unified-light.png") });
    }

    await modified.getByRole("button", { name: "Show next 20 unmodified lines" }).click();
    await expect.poll(async () => (await gateway.getRequests("sessions.diff")).length).toBe(2);
    await expect
      .poll(async () => (await gateway.getRequests("sessions.files.get"))[0]?.params)
      .toMatchObject({ path: "src/app.ts" });
    await expect
      .poll(() => modified.locator(".chat-diff__row").first().textContent())
      .toContain("unchanged line 1");
    await expect
      .poll(() => modified.locator(".chat-diff__row--skip").first().textContent())
      .toContain("9 unmodified lines");
    await modified.getByRole("button", { name: "Show previous 9 unmodified lines" }).click();
    await expect.poll(() => modified.locator(".chat-diff__row--skip").count()).toBe(0);
    await expect.poll(async () => (await gateway.getRequests("sessions.files.get")).length).toBe(1);
    await expect.poll(async () => (await gateway.getRequests("sessions.diff")).length).toBe(3);

    const untracked = files.nth(1);
    await expect
      .poll(() => untracked.locator(".session-diff__badge").textContent())
      .toContain("untracked");

    const binary = files.nth(2);
    await expect
      .poll(() => binary.locator(".session-diff__note").textContent())
      .toContain("Binary file");

    await panel.getByRole("button", { name: "Change view options" }).click();
    await page.getByRole("menuitem", { name: "Switch to Split Diff" }).click();
    await expect.poll(() => modified.locator(".session-diff-split").count()).toBe(1);
    await expect
      .poll(() => modified.locator(".session-diff-split__side--right .tok-keyword").textContent())
      .toBe("const");
    if (captureProof) {
      await page.emulateMedia({ colorScheme: "dark" });
      await page.evaluate(() => {
        document.documentElement.dataset.themeMode = "dark";
        document.documentElement.dataset.themeResolved = "dark";
      });
      await modified
        .locator(".session-diff-split__side--right .tok-keyword")
        .scrollIntoViewIfNeeded();
      await panelSurface.screenshot({ path: path.join(artifactDir, "split-dark.png") });
    }
    await panel.getByRole("button", { name: "Change view options" }).click();
    await page.getByRole("menuitem", { name: "Switch to Unified Diff" }).click();
    await expect.poll(() => modified.locator(".chat-diff").count()).toBe(1);
    // View-only toggles reuse parsed patches after the expansion revalidations.
    await expect.poll(async () => (await gateway.getRequests("sessions.diff")).length).toBe(3);

    // Collapsing a file hides its diff body.
    await modified.locator(".session-diff__file-toggle").click();
    await expect.poll(() => modified.locator(".chat-diff").count()).toBe(0);
    await panel.getByRole("button", { name: "Refresh changes" }).click();
    await expect.poll(async () => (await gateway.getRequests("sessions.diff")).length).toBe(4);
    // Refresh keeps the current collapse state instead of expanding every file.
    await expect.poll(() => modified.locator(".chat-diff").count()).toBe(0);
    await modified.locator(".session-diff__file-toggle").click();
    await expect.poll(() => modified.locator(".chat-diff").count()).toBe(1);

    // The section-title button opens the same scope menu as the footer.
    await panel.locator(".session-diff__section-title").click();
    await page
      .locator('openclaw-session-diff-menu wa-dropdown-item[value="scope:uncommitted"]')
      .click();
    await expect
      .poll(() => panel.locator(".session-diff__section-title span").textContent())
      .toBe("Uncommitted");
    await expect.poll(() => panel.locator(".session-diff__file").count()).toBe(1);
    await expect
      .poll(async () => (await gateway.getRequests("sessions.diff")).at(-1)?.params)
      .toMatchObject({ scope: "uncommitted" });

    await panel.locator(".session-diff__footer").click();
    await page
      .locator('openclaw-session-diff-menu wa-dropdown-item[value="scope:commit:abc1234"]')
      .click();
    await expect
      .poll(() => panel.locator(".session-diff__section-title span").textContent())
      .toBe("abc1234 First feature change");
    await expect
      .poll(async () => (await gateway.getRequests("sessions.diff")).at(-1)?.params)
      .toMatchObject({ scope: "commit", commit: "abc1234" });
    await expect.poll(() => panel.locator(".session-diff__gap-controls").count()).toBe(0);
  });

  it("refreshes an open Review after checkout creation without listing workspace files", async () => {
    const context = await newBrowserContext();
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      featureMethods: ["chat.metadata", "chat.startup", "sessions.diff"],
      methodResponses: {
        "sessions.diff": {
          sessionKey: "main",
          files: [],
          additions: 0,
          deletions: 0,
          unavailableReason: "not_git",
        },
      },
    });
    await page.goto(`${suite.server.baseUrl}chat`);
    expect(await gateway.getRequests("sessions.files.list")).toHaveLength(0);
    await activateChatHeaderPanelAction(page, "Show session changes");
    await expect
      .poll(() => page.locator(".session-diff .session-diff__note").textContent())
      .toContain("not a git checkout");
    expect(await gateway.getRequests("sessions.diff")).toHaveLength(1);

    await gateway.setMethodResponse("sessions.diff", {
      sessionKey: "main",
      root: "/tmp/checkout",
      branch: "feature/panel",
      baseRef: "main",
      files: [
        {
          path: "notes.md",
          status: "added",
          additions: 2,
          deletions: 0,
          untracked: true,
          patch: NOTES_PATCH,
        },
      ],
      additions: 2,
      deletions: 0,
    });
    await gateway.emitChatFinal({ runId: "git-init-run", text: "Initialized repository." });
    await expect.poll(async () => (await gateway.getRequests("sessions.diff")).length).toBe(2);
    await expect
      .poll(() => page.locator(".session-diff__filename").allTextContents())
      .toEqual(["notes.md"]);
    expect(await gateway.getRequests("sessions.files.list")).toHaveLength(0);
  });
});
