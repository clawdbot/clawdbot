import { expect, it } from "vitest";
import {
  WORKSPACE,
  captureProjectUiProof,
  captureUiProofEnabled,
  createNewSessionPageE2eSuite,
  installMockGateway,
  pollLocatorText,
  prepareProjectUiProof,
  projectProofArtifactDir,
} from "./new-session-page.test-support.ts";

const suite = createNewSessionPageE2eSuite();

suite.define(() => {
  it("keeps GitHub selection inert and clones only when the session starts", async () => {
    await prepareProjectUiProof();
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      ...(captureUiProofEnabled
        ? {
            recordVideo: {
              dir: projectProofArtifactDir,
              size: { height: 900, width: 1280 },
            },
            viewport: { height: 900, width: 1280 },
          }
        : {}),
    });
    const page = await context.newPage();
    const clonedProject = {
      id: "openclaw",
      displayName: "OpenClaw",
      repoRoot: "/state/projects/fingerprint/openclaw",
      originUrl: "https://github.com/openclaw/openclaw.git",
      source: "cloned",
    };
    const gateway = await installMockGateway(page, {
      workspace: WORKSPACE,
      workspaceGit: true,
      deferredMethods: ["projects.add"],
      featureMethods: [
        "chat.metadata",
        "chat.startup",
        "projects.add",
        "projects.list",
        "projects.searchRemote",
        "sessions.create",
        "worktrees.branches",
      ],
      methodResponses: {
        "projects.list": { projects: [] },
        "projects.searchRemote": {
          credential: "missing",
          projects: [
            {
              name: "openclaw",
              fullName: "openclaw/openclaw",
              description: "Personal AI assistant",
              cloneUrl: "https://github.com/openclaw/openclaw.git",
              webUrl: "https://github.com/openclaw/openclaw",
              private: false,
            },
          ],
        },
        "worktrees.branches": {
          branches: [{ kind: "local", name: "main" }],
          defaultBranch: "main",
          repositoryStatus: "git",
        },
        "sessions.create": { key: "agent:main:cloned-project-e2e" },
      },
    });

    try {
      await page.goto(`${suite.server.baseUrl}new`);
      await gateway.waitForRequest("projects.list");
      const trigger = page.locator("#new-session-project-trigger");
      const place = page.locator("wa-popover.new-session-page__project-popover");
      await trigger.click();
      const search = place.getByRole("searchbox", {
        name: "Search projects or paste a Git URL",
      });
      await search.fill("openclaw");

      const searchRequest = await gateway.waitForRequest("projects.searchRemote");
      expect(searchRequest.params).toEqual({ query: "openclaw" });
      await place.getByText("GH_TOKEN is not configured; public GitHub results only.").waitFor();
      await place.getByRole("button", { name: /openclaw\/openclaw/u }).click();

      expect(await gateway.getRequests("projects.add")).toHaveLength(0);
      await pollLocatorText(trigger.locator(".new-session-page__trigger-label")).toBe(
        "openclaw/openclaw",
      );
      expect(await trigger.getAttribute("data-project-id")).toBeNull();

      await page.locator(".new-session-page__message").fill("inspect the cloned project");
      await page.getByRole("button", { name: "Start session" }).click();
      const addRequest = await gateway.waitForRequest("projects.add");
      expect(addRequest.params).toEqual({ gitUrl: "https://github.com/openclaw/openclaw.git" });
      await captureProjectUiProof(page, "project-cloning.png");
      expect(await gateway.getRequests("sessions.create")).toHaveLength(0);
      await gateway.resolveDeferred("projects.add", clonedProject);

      const create = await gateway.waitForRequest("sessions.create");
      expect(create.params).toMatchObject({
        agentId: "main",
        message: "inspect the cloned project",
        projectId: "openclaw",
      });
      expect(create.params).not.toHaveProperty("cwd");
    } finally {
      await context.close();
    }
  });
});
