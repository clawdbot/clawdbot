import os from "node:os";
import { describe, expect, it, vi } from "vitest";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import {
  BASE_HEAD,
  BRANCH,
  NEW_HEAD,
  OLD_HEAD,
  SESSION_ID,
  SESSION_KEY,
  commandCalls,
  commands,
  createTestGitHubPublicationCoordinator as createGitHubPublicationCoordinator,
  githubPublicationTestMocks,
  installGitHubPublicationTestHarness,
  root,
  setPublicationSessionTitle,
} from "./github-publication.test-support.js";
import { createWorkerSessionPlacementStore } from "./worker-environments/placement-store.js";

const mocks = githubPublicationTestMocks();

describe("Gateway GitHub publication naming", () => {
  installGitHubPublicationTestHarness();
  it.each([
    {
      name: "automatic sidebar label",
      automatic: true,
      label: "Fix sidebar branch naming",
      displayName: "Previous summary",
      slug: "fix-sidebar-branch-naming",
    },
    {
      name: "automatic display name",
      automatic: true,
      displayName: "Fix sidebar branch naming",
      slug: "fix-sidebar-branch-naming",
    },
    { name: "automatic non-ASCII title", automatic: true, label: "日本語の要約" },
    { name: "automatic title unavailable", automatic: true },
    { name: "explicit or preexisting branch", label: "Do not rename this branch" },
  ])("publishes $name through exact HTTPS and freezes its destination", async (naming) => {
    setPublicationSessionTitle(naming);
    const database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
    const placements = createWorkerSessionPlacementStore({ database });
    const coordinator = createGitHubPublicationCoordinator({ placements });
    const request = {
      sessionKey: SESSION_KEY,
      agentId: "main",
      idempotencyKey: "publish-1",
      title: "Publish the reconciled fix",
    };

    const first = await coordinator.requestForSession(request);
    const branch = first.status === "published" ? first.branch : undefined;
    if (naming.slug) {
      expect(branch).toMatch(new RegExp(`^openclaw/${naming.slug}-[a-f0-9]{12}$`, "u"));
    } else {
      expect(branch).toBe(BRANCH);
    }
    expect(first).toEqual({
      requestId: expect.any(String),
      status: "published",
      url: "https://github.com/openclaw/openclaw/pull/125200",
      repository: "openclaw/openclaw",
      branch,
      headCommit: NEW_HEAD,
    });
    expect(commands.some((argv) => argv.includes("https://github.com/openclaw/openclaw.git"))).toBe(
      true,
    );
    expect(commands.some((argv) => argv.some((arg) => arg.includes("roboclaw-token")))).toBe(false);
    expect(
      commands.some(
        (argv) =>
          argv[0] === "git" &&
          argv.includes("credential.helper=!gh auth git-credential") &&
          argv.includes("push"),
      ),
    ).toBe(true);
    for (const argv of commands.filter(
      (candidate) =>
        candidate.includes("update-ref") ||
        candidate.includes("read-tree") ||
        candidate.includes("add") ||
        candidate.includes("reset") ||
        candidate.includes("push"),
    )) {
      expect(argv, argv.join(" ")).toContain(`core.hooksPath=${os.devNull}`);
    }
    for (const argv of commands.filter(
      (candidate) =>
        candidate.includes("read-tree") || candidate.includes("add") || candidate.includes("reset"),
    )) {
      expect(argv).toContain("core.fsmonitor=false");
    }
    const push = commands.find((argv) => argv.includes("push"));
    expect(push).toEqual(
      expect.arrayContaining([
        "--no-follow-tags",
        "--recurse-submodules=no",
        `${NEW_HEAD}:refs/heads/${branch}`,
      ]),
    );
    expect(push).not.toContain(`HEAD:refs/heads/${branch}`);
    expect(commands.find((argv) => argv.includes("update-ref"))).toEqual(
      expect.arrayContaining([`refs/heads/${BRANCH}`, NEW_HEAD, OLD_HEAD]),
    );
    expect(mocks.updateIndex).toHaveBeenCalledWith(
      expect.objectContaining({ branch: BRANCH, headCommit: NEW_HEAD }),
    );
    const fetchCommand = commands.find((argv) => argv.includes("fetch"));
    expect(fetchCommand).toEqual(
      expect.arrayContaining([
        `core.hooksPath=${os.devNull}`,
        "core.fsmonitor=false",
        "maintenance.auto=false",
        "gc.auto=0",
        "--no-auto-maintenance",
        "--recurse-submodules=no",
      ]),
    );
    const post = commandCalls.find(({ argv }) => argv.includes("POST"));
    expect(post?.argv).toEqual([
      "gh",
      "api",
      "--hostname",
      "github.com",
      "--method",
      "POST",
      "repos/openclaw/openclaw/pulls",
      "--input",
      "-",
    ]);
    expect(JSON.parse(post?.input ?? "null")).toEqual({
      title: "Publish the reconciled fix",
      body: `Published by the Gateway after authoritative workspace reconciliation.\n\n## Worked on by\n\n- @alice\n\n<!-- openclaw-publication:${first.requestId} -->`,
      head: `openclaw:${branch}`,
      base: "main",
      draft: true,
    });
    const persisted = database.db
      .prepare("SELECT * FROM github_publication_requests WHERE session_id = ?")
      .get(SESSION_ID);
    expect(JSON.stringify(persisted)).not.toContain("GH_CONFIG_DIR");
    expect(JSON.stringify(persisted)).not.toContain("token");
    expect(persisted).toMatchObject({ source_branch: BRANCH, branch });

    const [{ loadControlUiSessionPullRequests }, { githubJson, pullListItem, requestUrl }] =
      await Promise.all([
        import("./control-ui-session-prs.js"),
        import("./control-ui-session-prs.test-support.js"),
      ]);
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(githubJson([pullListItem({ merged_at: "2026-08-27T00:00:00Z" })]));
    const resolveBranchLanding = vi.fn(async () => ({
      pushedSha: NEW_HEAD,
      statsBase: BASE_HEAD,
      hasLandedPullRequest: false,
      provenNewPushedWork: false,
    }));
    const sidebar = await loadControlUiSessionPullRequests(
      { sessionKey: SESSION_KEY, refresh: true },
      {
        fetchImpl,
        resolveGitRoot: async () => "/repo/worktree",
        gitOutput: async (_root, args) => {
          if (args[0] === "rev-parse") {
            return BRANCH;
          }
          if (args[0] === "remote") {
            return "git@github.com:openclaw/openclaw.git";
          }
          if (args[0] === "symbolic-ref") {
            return "origin/main";
          }
          return args[0] === "rev-list" ? "1" : null;
        },
        resolveBranchLanding,
        runGit: async () => ({
          stdout: "1 file changed, 2 insertions(+)",
          stderr: "",
          code: 0,
          signal: null,
          killed: false,
          termination: "exit",
          timeoutMs: 120_000,
        }),
      },
    );
    expect(new URL(requestUrl(fetchImpl.mock.calls[0]?.[0])).searchParams.get("head")).toBe(
      `openclaw:${branch}`,
    );
    expect(sidebar.pullRequests[0]).toMatchObject({ branch, number: 103469 });
    expect(sidebar.branch).toMatchObject({ branch, additions: 2, changedFiles: 1 });
    expect(resolveBranchLanding).toHaveBeenCalledWith(
      "/repo/worktree",
      expect.objectContaining({ branch }),
    );

    const commandCount = commands.length;
    setPublicationSessionTitle({ automatic: naming.automatic, label: "A changed sidebar title" });
    closeOpenClawStateDatabaseForTest();
    const reopened = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
    const afterRestart = createGitHubPublicationCoordinator({
      placements: createWorkerSessionPlacementStore({ database: reopened }),
    });
    await expect(afterRestart.requestForSession(request)).resolves.toEqual(first);
    expect(commands).toHaveLength(commandCount);
    await expect(
      afterRestart.requestForSession({ ...request, idempotencyKey: "publish-again" }),
    ).resolves.toMatchObject({ status: "published", branch });
  });
});
