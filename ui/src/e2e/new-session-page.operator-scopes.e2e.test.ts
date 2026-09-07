import { expect, it } from "vitest";
import {
  createControlUiE2eContextOptions,
  tooltipTitleText,
} from "./control-ui-e2e-suite.test-support.ts";
import {
  SESSION_LIST_DEFAULTS,
  createNewSessionPageE2eSuite,
  installMockGateway,
  pollLocatorText,
} from "./new-session-page.test-support.ts";

const suite = createNewSessionPageE2eSuite();

async function openDraft(
  operatorScopes: string[],
  featureMethods = [
    "chat.metadata",
    "chat.startup",
    "projects.list",
    "sessions.create",
    "sessions.dispatch",
  ],
) {
  const context = await suite.browser.newContext(createControlUiE2eContextOptions());
  const page = await context.newPage();
  const gateway = await installMockGateway(page, {
    featureMethods,
    operatorScopes,
    methodResponses: {
      "environments.list": {
        environments: [
          {
            id: "node:writer-runner",
            type: "node",
            label: "Writer runner",
            status: "available",
            sessionHost: true,
            workerSlots: { total: 1, available: 1 },
          },
        ],
        profiles: [{ id: "aws", providerId: "crabbox" }],
      },
      "projects.list": { projects: [] },
      "worktrees.branches": { branches: [], repositoryStatus: "git" },
      "sessions.create": { key: "agent:main:operator-scope-proof", runStarted: true },
    },
  });
  await page.goto(`${suite.server.baseUrl}new`);
  await page.locator(".new-session-page__message").fill("scope proof");
  return { context, gateway, page };
}

suite.define(() => {
  it("keeps read-scoped operators out of new-session entry and submission paths", async () => {
    const { context, gateway, page } = await openDraft(
      ["operator.read"],
      ["chat.metadata", "chat.startup", "projects.list", "sessions.create", "sessions.dispatch"],
    );
    try {
      const sidebarCreate = page.locator(".sidebar-brand__new-thread");
      const submit = page.getByRole("button", { name: "Start session" });
      const incognito = page.getByRole("switch", { name: "Incognito" });

      await expect.poll(() => sidebarCreate.isDisabled()).toBe(true);
      await expect.poll(() => submit.isDisabled()).toBe(true);
      await expect.poll(() => incognito.isDisabled()).toBe(true);
      expect(await incognito.getAttribute("title")).toBe(
        "This action requires operator.admin access.",
      );
      await submit.click({ force: true });
      const projectRequests = await gateway.getRequests("projects.list");
      expect(projectRequests).toHaveLength(1);
      expect(projectRequests[0]?.params).toEqual({});
      expect(await gateway.getRequests("sessions.create")).toHaveLength(0);
    } finally {
      await context.close();
    }
  });

  it("allows write-scoped Fast Mode creation while keeping incognito admin-only", async () => {
    const { context, gateway, page } = await openDraft(["operator.read", "operator.write"]);
    try {
      await expect(gateway.waitForRequest("projects.list")).resolves.toMatchObject({
        params: {},
      });
      const submit = page.getByRole("button", { name: "Start session" });
      const incognito = page.getByRole("switch", { name: "Incognito" });
      const effort = page.locator('[data-chat-thinking-select="true"]');

      await expect.poll(() => page.locator(".sidebar-brand__new-thread").isEnabled()).toBe(true);
      await expect.poll(() => submit.isEnabled()).toBe(true);
      await expect.poll(() => incognito.isDisabled()).toBe(true);
      await page.locator("#new-session-where-trigger").click();
      const where = page.locator("wa-popover.new-session-page__where-popover");
      await where.getByRole("button", { name: /Writer runner/u }).waitFor();
      expect(await where.locator('[data-value="cloud:aws"]').count()).toBe(0);
      expect(await where.locator('[data-value="connect-machine"]').count()).toBe(0);
      await page.keyboard.press("Escape");
      await effort.click();
      const fastMode = page.locator("[data-chat-speed-toggle]");
      await expect.poll(() => fastMode.isEnabled()).toBe(true);
      await expect.poll(() => fastMode.getAttribute("data-chat-speed-toggle")).toBe("on");
      await expect.poll(() => fastMode.getAttribute("aria-checked")).toBe("false");
      await fastMode.click();
      await expect.poll(() => fastMode.getAttribute("data-chat-speed-toggle")).toBe("off");
      await expect.poll(() => fastMode.getAttribute("aria-checked")).toBe("true");
      await submit.click();

      await expect(gateway.waitForRequest("sessions.create")).resolves.toMatchObject({
        params: { agentId: "main", fastMode: true, message: "scope proof" },
      });
    } finally {
      await context.close();
    }
  });

  it("creates a Full-access session when the connected operator has admin scope", async () => {
    const { context, gateway, page } = await openDraft([
      "operator.admin",
      "operator.read",
      "operator.write",
    ]);
    try {
      const permission = page.locator('[data-chat-permission-select="true"]');
      await permission.click();
      await page.locator('[data-chat-permission-option="full"]').click();
      await expect.poll(() => permission.getAttribute("data-chat-select-value")).toBe("full");
      await page.getByRole("button", { name: "Start session" }).click();

      await expect(gateway.waitForRequest("sessions.create")).resolves.toMatchObject({
        params: { agentId: "main", message: "scope proof", permissionMode: "full" },
      });
      await expect.poll(() => page.url()).toContain("/chat/");
      expect(await gateway.getRequests("sessions.create")).toHaveLength(1);
    } finally {
      await context.close();
    }
  });

  it("rejects a retained Full-access selection after reconnecting without admin scope", async () => {
    const { context, gateway, page } = await openDraft([
      "operator.admin",
      "operator.read",
      "operator.write",
    ]);
    try {
      const permission = page.locator('[data-chat-permission-select="true"]');
      await permission.click();
      await page.locator('[data-chat-permission-option="full"]').click();
      await expect.poll(() => permission.getAttribute("data-chat-select-value")).toBe("full");

      await gateway.setOperatorScopes(["operator.read", "operator.write"]);
      await gateway.closeLatest(1001, "permission scope downgraded");
      await expect.poll(async () => (await gateway.getRequests("connect")).length).toBe(2);

      const submit = page.getByRole("button", { name: "Start session" });
      await expect.poll(() => submit.isDisabled()).toBe(true);
      expect(await permission.getAttribute("data-chat-select-value")).toBe("full");
      await permission.click();
      const fullAccess = page.locator('[data-chat-permission-option="full"]');
      await expect.poll(() => fullAccess.getAttribute("disabled")).not.toBeNull();
      await expect
        .poll(() => tooltipTitleText(fullAccess))
        .toBe("Full access requires operator.admin access.");
      await page.keyboard.press("Escape");
      await page.locator(".new-session-page__message").press("Enter");

      await pollLocatorText(
        page.locator('.new-session-page__blocked-submit[role="status"]'),
      ).toContain("This action requires operator.admin access.");
      expect(await gateway.getRequests("sessions.create")).toHaveLength(0);
    } finally {
      await context.close();
    }
  });

  it("shows paired devices, cloud profiles, and Connect to admins", async () => {
    const { context, page } = await openDraft([
      "operator.read",
      "operator.write",
      "operator.admin",
    ]);
    try {
      await page.locator("#new-session-where-trigger").click();
      const where = page.locator("wa-popover.new-session-page__where-popover");
      await where.locator('[data-value="device:writer-runner"]').waitFor();
      await where.locator('[data-value="cloud:aws"]').waitFor();
      await where.locator('[data-value="connect-machine"]').waitFor();
    } finally {
      await context.close();
    }
  });

  it("lets read-scoped operators search projects without exposing clone actions", async () => {
    const context = await suite.browser.newContext({ locale: "en-US", serviceWorkers: "block" });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      featureMethods: ["projects.add", "projects.list", "projects.searchRemote"],
      operatorScopes: ["operator.read"],
      methodResponses: {
        "projects.list": { projects: [] },
        "projects.searchRemote": {
          credential: "missing",
          projects: [
            {
              name: "openclaw",
              fullName: "openclaw/openclaw",
              cloneUrl: "https://github.com/openclaw/openclaw.git",
              webUrl: "https://github.com/openclaw/openclaw",
              private: false,
            },
          ],
        },
      },
    });
    try {
      await page.goto(`${suite.server.baseUrl}new`);
      await gateway.waitForRequest("projects.list");
      await page.locator("#new-session-project-trigger").click();
      const place = page.locator("wa-popover.new-session-page__project-popover");
      await place.getByRole("searchbox").fill("openclaw");
      await gateway.waitForRequest("projects.searchRemote");

      const remote = place.getByRole("button", { name: /openclaw\/openclaw/u });
      await expect.poll(() => remote.isDisabled()).toBe(true);
      await remote.click({ force: true });
      expect(await gateway.getRequests("projects.add")).toHaveLength(0);
    } finally {
      await context.close();
    }
  });

  it("lets write-scoped operators browse and restore only workspace-contained folders", async () => {
    const context = await suite.browser.newContext({ locale: "en-US", serviceWorkers: "block" });
    const page = await context.newPage();
    const workspace = "/home/peter/openclaw";
    const contained = `${workspace}/packages/app`;
    const gateway = await installMockGateway(page, {
      workspace,
      workspaceGit: true,
      featureMethods: [
        "chat.metadata",
        "chat.startup",
        "fs.listDir",
        "sessions.create",
        "worktrees.branches",
      ],
      operatorScopes: ["operator.read", "operator.write"],
      methodResponses: {
        "fs.listDir": {
          path: workspace,
          home: "/home/peter",
          entries: [{ name: "packages", path: `${workspace}/packages` }],
        },
        "sessions.list": {
          count: 2,
          defaults: SESSION_LIST_DEFAULTS,
          path: "",
          sessions: [
            { key: "agent:main:inside", kind: "direct", updatedAt: 2, execCwd: contained },
            { key: "agent:main:outside", kind: "direct", updatedAt: 1, execCwd: "/private/repo" },
          ],
          ts: Date.now(),
        },
        "worktrees.branches": { branches: [], repositoryStatus: "not_git" },
        "sessions.create": { key: "agent:main:write-workspace" },
      },
    });
    try {
      await page.goto(`${suite.server.baseUrl}new`);
      const trigger = page.locator("#new-session-project-trigger");
      await trigger.click();
      const browse = page.getByRole("button", { name: "Browse folders" });
      await expect.poll(() => browse.isEnabled()).toBe(true);
      await browse.click();
      await expect(gateway.waitForRequest("fs.listDir")).resolves.toMatchObject({
        params: { path: workspace },
      });
      await page.getByRole("button", { name: "Parent folder" }).click();
      await page.getByRole("button", { name: "app", exact: true }).click();
      expect(await page.locator('[data-value="recent:/private/repo"]').count()).toBe(0);

      await page.locator(".new-session-page__message").fill("work in the package");
      await page.getByRole("button", { name: "Start session" }).click();
      await expect(gateway.waitForRequest("sessions.create")).resolves.toMatchObject({
        params: { cwd: contained, message: "work in the package" },
      });
    } finally {
      await context.close();
    }
  });

  it("explains when browsing outside the workspace requires admin scope", async () => {
    const context = await suite.browser.newContext({ locale: "en-US", serviceWorkers: "block" });
    const page = await context.newPage();
    const workspace = "/home/peter/openclaw";
    const gateway = await installMockGateway(page, {
      workspace,
      workspaceGit: true,
      featureMethods: ["chat.metadata", "chat.startup", "fs.listDir", "worktrees.branches"],
      operatorScopes: ["operator.read", "operator.write"],
      methodResponses: {
        "fs.listDir": { path: workspace, home: "/home/peter", entries: [] },
        "worktrees.branches": { branches: [], repositoryStatus: "not_git" },
      },
    });
    try {
      await page.goto(`${suite.server.baseUrl}new`);
      await page.locator("#new-session-project-trigger").click();
      await page.getByRole("button", { name: "Browse folders" }).click();
      await expect(gateway.waitForRequest("fs.listDir")).resolves.toMatchObject({
        params: { path: workspace },
      });

      const pathInput = page.locator("input.new-session-page__browser-path");
      await expect.poll(() => pathInput.inputValue()).toBe(workspace);
      await gateway.deferNext("fs.listDir", { path: "/tmp" });
      await pathInput.fill("/tmp");
      await pathInput.press("Enter");
      await expect.poll(async () => (await gateway.getRequests("fs.listDir")).length).toBe(2);
      expect((await gateway.getRequests("fs.listDir"))[1]?.params).toEqual({ path: "/tmp" });
      await gateway.rejectDeferred("fs.listDir", {
        code: "FORBIDDEN",
        message: "Folder access was denied.",
        details: {
          code: "MISSING_SCOPE",
          missingScope: "operator.admin",
          requiredScopes: ["operator.admin"],
        },
      });

      await pollLocatorText(
        page.locator(".new-session-page__browser .new-session-page__error"),
      ).toContain(
        "To browse outside agent workspaces, open Inbox, select Limited access, request admin, then approve in Devices.",
      );
      expect(await pathInput.inputValue()).toBe("/tmp");
      expect(await gateway.getRequests("fs.listDir")).toHaveLength(2);
    } finally {
      await context.close();
    }
  });

  it("keeps a canonical browser selection submittable for a symlinked workspace alias", async () => {
    const context = await suite.browser.newContext({ locale: "en-US", serviceWorkers: "block" });
    const page = await context.newPage();
    const workspaceAlias = "/var/folders/openclaw/workspace-alias";
    const canonicalWorkspace = "/private/var/folders/openclaw/workspace";
    const canonicalFolder = `${canonicalWorkspace}/packages`;
    const gateway = await installMockGateway(page, {
      workspace: workspaceAlias,
      workspaceGit: true,
      featureMethods: [
        "chat.metadata",
        "chat.startup",
        "fs.listDir",
        "sessions.create",
        "worktrees.branches",
      ],
      operatorScopes: ["operator.read", "operator.write"],
      methodResponses: {
        "fs.listDir": {
          cases: [
            {
              match: { path: workspaceAlias },
              response: {
                path: canonicalWorkspace,
                home: "/Users/peter",
                entries: [{ name: "packages", path: canonicalFolder }],
              },
            },
            {
              match: { path: canonicalFolder },
              response: {
                path: canonicalFolder,
                parent: canonicalWorkspace,
                home: "/Users/peter",
                entries: [],
              },
            },
          ],
        },
        "worktrees.branches": { branches: [], repositoryStatus: "not_git" },
        "sessions.create": { key: "agent:main:symlinked-workspace" },
      },
    });
    try {
      await page.goto(`${suite.server.baseUrl}new`);
      await page.locator("#new-session-project-trigger").click();
      await page.getByRole("button", { name: "Browse folders" }).click();
      await page.getByRole("option", { name: "packages" }).click();
      const useFolder = page.getByRole("button", { name: "Use this folder" });
      await expect.poll(() => useFolder.isEnabled()).toBe(true);
      await useFolder.click();

      await page.locator(".new-session-page__message").fill("inspect the canonical checkout");
      const submit = page.getByRole("button", { name: "Start session" });
      await expect.poll(() => submit.isEnabled()).toBe(true);
      await submit.click();
      await expect(gateway.waitForRequest("sessions.create")).resolves.toMatchObject({
        params: {
          cwd: canonicalFolder,
          message: "inspect the canonical checkout",
        },
      });
    } finally {
      await context.close();
    }
  });

  it("submits an unvalidated typed folder so the Gateway error stays actionable", async () => {
    const context = await suite.browser.newContext({ locale: "en-US", serviceWorkers: "block" });
    const page = await context.newPage();
    const workspace = "/home/peter/openclaw";
    const typedFolder = "/private/repo";
    const gateway = await installMockGateway(page, {
      workspace,
      workspaceGit: true,
      deferredMethods: ["sessions.create"],
      featureMethods: [
        "chat.metadata",
        "chat.startup",
        "fs.listDir",
        "sessions.create",
        "worktrees.branches",
      ],
      operatorScopes: ["operator.read", "operator.write"],
      methodResponses: {
        "fs.listDir": { path: workspace, home: "/home/peter", entries: [] },
        "worktrees.branches": { branches: [], repositoryStatus: "not_git" },
        "sessions.create": { key: "agent:main:typed-folder" },
      },
    });
    try {
      await page.goto(`${suite.server.baseUrl}new`);
      await page.locator("#new-session-project-trigger").click();
      await page.getByRole("button", { name: "Browse folders" }).click();
      const pathInput = page.locator("input.new-session-page__browser-path");
      await expect.poll(() => pathInput.inputValue()).toBe(workspace);
      await pathInput.fill(typedFolder);
      const useFolder = page.getByRole("button", { name: "Use this folder" });
      await expect.poll(() => useFolder.isEnabled()).toBe(true);
      await useFolder.click();

      await page.locator(".new-session-page__message").fill("let the Gateway decide");
      const submit = page.getByRole("button", { name: "Start session" });
      await expect.poll(() => submit.isEnabled()).toBe(true);
      await submit.click();
      await expect(gateway.waitForRequest("sessions.create")).resolves.toMatchObject({
        params: { cwd: typedFolder, message: "let the Gateway decide" },
      });
      await gateway.rejectDeferred("sessions.create", {
        code: "FORBIDDEN",
        message: "missing scope: operator.admin",
      });
      await pollLocatorText(page.locator(".new-session-page__error")).toContain(
        "missing scope: operator.admin",
      );
    } finally {
      await context.close();
    }
  });

  it("allows admin-scoped incognito creation with exact dynamic parameters", async () => {
    const { context, gateway, page } = await openDraft([
      "operator.admin",
      "operator.read",
      "operator.write",
    ]);
    try {
      const incognito = page.getByRole("switch", { name: "Incognito" });
      await expect.poll(() => incognito.isEnabled()).toBe(true);
      await incognito.click();
      await page.getByRole("button", { name: "Start session" }).click();

      await expect(gateway.waitForRequest("sessions.create")).resolves.toMatchObject({
        params: { incognito: true, message: "scope proof" },
      });
    } finally {
      await context.close();
    }
  });

  it("blocks creation when the connected Gateway explicitly omits sessions.create", async () => {
    const { context, gateway, page } = await openDraft(
      ["operator.admin", "operator.read", "operator.write"],
      ["chat.metadata", "chat.startup"],
    );
    try {
      await expect.poll(() => page.locator(".sidebar-brand__new-thread").isDisabled()).toBe(true);
      const submit = page.getByRole("button", { name: "Start session" });
      await expect.poll(() => submit.isDisabled()).toBe(true);
      await submit.click({ force: true });
      expect(await gateway.getRequests("sessions.create")).toHaveLength(0);
    } finally {
      await context.close();
    }
  });

  it("blocks creation while the Gateway is disconnected", async () => {
    const { context, gateway, page } = await openDraft([
      "operator.admin",
      "operator.read",
      "operator.write",
    ]);
    try {
      await gateway.setOnline(false);
      await gateway.closeLatest(1001, "new-session scope proof");
      await expect
        .poll(() =>
          page.evaluate(() => {
            const app = document.querySelector("openclaw-app") as HTMLElement & {
              runtime?: { context: { gateway: { snapshot: { phase: string } } } };
            };
            return app.runtime?.context.gateway.snapshot.phase;
          }),
        )
        .toBe("reconnecting");

      const submit = page.getByRole("button", { name: "Start session" });
      await expect.poll(() => submit.isDisabled()).toBe(true);
      await submit.click({ force: true });
      expect(await gateway.getRequests("sessions.create")).toHaveLength(0);
    } finally {
      await gateway.setOnline(true);
      await context.close();
    }
  });
});
