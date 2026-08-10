import { expect, it } from "vitest";
import {
  SESSION_LIST_DEFAULTS,
  createNewSessionPageE2eSuite,
  installMockGateway,
  pollLocatorText,
} from "./new-session-page.test-support.ts";

const suite = createNewSessionPageE2eSuite();

async function openDraft(
  operatorScopes: string[],
  featureMethods = ["chat.metadata", "chat.startup", "sessions.create", "sessions.dispatch"],
) {
  const context = await suite.browser.newContext({
    locale: "en-US",
    serviceWorkers: "block",
    viewport: { height: 900, width: 1280 },
  });
  const page = await context.newPage();
  const gateway = await installMockGateway(page, {
    featureMethods,
    operatorScopes,
    methodResponses: {
      "sessions.create": { key: "agent:main:operator-scope-proof", runStarted: true },
    },
  });
  await page.goto(`${suite.server.baseUrl}new`);
  await page.locator(".new-session-page__message").fill("scope proof");
  return { context, gateway, page };
}

suite.define(() => {
  it("keeps read-scoped operators out of new-session entry and submission paths", async () => {
    const { context, gateway, page } = await openDraft(["operator.read"]);
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
      expect(await gateway.getRequests("sessions.create")).toHaveLength(0);
    } finally {
      await context.close();
    }
  });

  it("allows write-scoped normal creation while keeping incognito admin-only", async () => {
    const { context, gateway, page } = await openDraft(["operator.read", "operator.write"]);
    try {
      const submit = page.getByRole("button", { name: "Start session" });
      const incognito = page.getByRole("switch", { name: "Incognito" });

      await expect.poll(() => page.locator(".sidebar-brand__new-thread").isEnabled()).toBe(true);
      await expect.poll(() => submit.isEnabled()).toBe(true);
      await expect.poll(() => incognito.isDisabled()).toBe(true);
      await submit.click();

      await expect(gateway.waitForRequest("sessions.create")).resolves.toMatchObject({
        params: { agentId: "main", message: "scope proof" },
      });
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
      const trigger = page.locator("#new-session-place-trigger");
      await trigger.click();
      const browse = page.getByRole("button", { name: "Browse folders" });
      await expect.poll(() => browse.isEnabled()).toBe(true);
      await browse.click();
      await expect(gateway.waitForRequest("fs.listDir")).resolves.toMatchObject({
        params: { path: workspace },
      });
      await page.getByRole("button", { name: "Parent folder" }).click();
      await page.getByRole("button", { name: "app", exact: true }).click();
      expect(await page.locator('[data-value="recent::/private/repo"]').count()).toBe(0);

      await page.locator(".new-session-page__message").fill("work in the package");
      await page.getByRole("button", { name: "Start session" }).click();
      await expect(gateway.waitForRequest("sessions.create")).resolves.toMatchObject({
        params: { cwd: contained, message: "work in the package" },
      });
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
      await page.locator("#new-session-place-trigger").click();
      await page.getByRole("button", { name: "Browse folders" }).click();
      await page.getByRole("button", { name: "packages" }).click();
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
      await page.locator("#new-session-place-trigger").click();
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
