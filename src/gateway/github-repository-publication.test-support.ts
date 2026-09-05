import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, type Mock } from "vitest";
import { patchSessionEntryCore } from "../config/sessions/session-accessor.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { getSessionRepositoryWorkspaceStore } from "../state/session-repository-workspaces.js";
import {
  SESSION_ID,
  SESSION_KEY,
  commandResult,
  createTestGitHubPublicationCoordinator,
  githubPublicationTestMocks,
  persistPublicationTestSession,
  root,
} from "./github-publication.test-support.js";
import { createWorkerSessionPlacementStore } from "./worker-environments/placement-store.js";
import type { SessionRepositoryCheckpointPayload } from "./worker-environments/session-repository-checkpoints.js";

const mocks = githubPublicationTestMocks();
export const repositoryPublicationTestUrl = "https://github.com/owner/repository/pull/1";

export async function createRepositoryPublicationFixture(
  checkpoint: Mock,
  requestedRef?: string | { kind: "commit" },
  session = { sessionId: SESSION_ID, sessionKey: SESSION_KEY },
) {
  // Only the mock GitHub service accesses this object store. The broker still
  // rejects every Git command and receives only the normalized checkpoint.
  const remote = await fs.mkdtemp(path.join(root, "fixture-github-"));
  const git = (args: string[], input?: string | Buffer) =>
    execFileSync("git", args, {
      cwd: remote,
      input,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: os.devNull,
        GIT_CONFIG_SYSTEM: os.devNull,
        GIT_CONFIG_COUNT: "0",
        GIT_AUTHOR_NAME: "Publication Fixture",
        GIT_AUTHOR_EMAIL: "publication@example.test",
        GIT_COMMITTER_NAME: "Publication Fixture",
        GIT_COMMITTER_EMAIL: "publication@example.test",
        GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
        GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
      },
    }).trim();
  git(["init", "--bare", "--quiet", "--initial-branch=main", "--object-format=sha1"]);
  const baseTree = git(["mktree"], "");
  const baseCommit = git(["commit-tree", baseTree], "fixture base\n");
  const sourceRef = typeof requestedRef === "string" ? requestedRef : requestedRef && baseCommit;
  const store = getSessionRepositoryWorkspaceStore();
  let workspace = store.create({
    agentId: "main",
    sessionKey: session.sessionKey,
    url: "https://github.com/owner/repository.git",
    requestedRef: sourceRef,
    assertCurrent: () => {},
  });
  workspace = store.bindBase({
    workspaceId: workspace.workspaceId,
    expectedRevision: workspace.revision,
    baseCommit,
    baseManifestHash: "sha256:" + "1".repeat(64),
    assertCurrent: () => {},
  });
  const original = mocks.loadSession.getMockImplementation()!;
  mocks.loadSession.mockImplementation((key: string) => {
    const loaded = original(key);
    if (key !== session.sessionKey) {
      return loaded;
    }
    return {
      ...loaded,
      entry: {
        sessionId: session.sessionId,
        repositoryWorkspaceId: workspace.workspaceId,
      },
    };
  });
  const sessionOwner = await persistPublicationTestSession(session.sessionKey);
  const payloads = new Map<string, { publicationStagingRoot: string; publicationDigest: string }>();
  const capture = async (content: string | null, suffix: string) => {
    const bytes = Buffer.from(content ?? "");
    const sha = git(["hash-object", "-w", "--stdin"], bytes);
    const workspaceTree =
      content === null ? baseTree : git(["mktree"], `100644 blob ${sha}\tcounter.txt\n`);
    const publicationStagingRoot = path.join(root, workspace.workspaceId, "checkpoint-" + suffix);
    await fs.mkdir(path.join(publicationStagingRoot, "blobs"), { recursive: true });
    await fs.writeFile(path.join(publicationStagingRoot, "blobs", sha), bytes);
    const raw = JSON.stringify({
      version: 1,
      baseCommit,
      baseTree,
      workspaceTree,
      entries: content === null ? [] : [{ path: "counter.txt", mode: "100644", sha }],
    });
    await fs.writeFile(path.join(publicationStagingRoot, "snapshot.json"), raw);
    const publicationDigest = "sha256:" + createHash("sha256").update(raw).digest("hex");
    const ref = "refs/openclaw/worker-results/" + suffix;
    payloads.set(ref, { publicationStagingRoot, publicationDigest });
    workspace = store.acceptCheckpoint({
      workspaceId: workspace.workspaceId,
      expectedRevision: workspace.revision,
      checkpointRef: ref,
      manifestHash: "sha256:" + createHash("sha256").update(suffix).digest("hex"),
      assertCurrent: () => {},
    });
    return { ref, sha, workspaceTree };
  };
  const first = await capture("accepted first\n", "first");
  checkpoint
    .mockReset()
    .mockImplementation(
      async (
        request: { workspaceId: string; checkpointRef: string; includePublication?: boolean },
        use: (payload: Partial<SessionRepositoryCheckpointPayload>) => Promise<unknown>,
      ) => {
        expect(request.workspaceId).toBe(workspace.workspaceId);
        expect(request.includePublication).toBe(true);
        const payload = payloads.get(request.checkpointRef);
        if (!payload) {
          throw new Error("Unknown checkpoint ref");
        }
        return await use(payload);
      },
    );
  const runtime = {
    head: null as string | null,
    pr: null as {
      url: string;
      userId: number;
      state: string;
      body: string;
      headSha: string;
      headRef: string;
      baseRef: string;
    } | null,
    accountId: 42,
    interruptPush: false,
    closePullRequest: false,
    changeHeadDuringPush: false,
    commonHistory: true,
    baseHead: baseCommit,
    baseHeadTree: baseTree,
    mergeBase: baseCommit,
    mergeBaseTree: baseTree,
    afterPush: () => {},
    afterHeadObservation: () => {},
    uploaded: new Map<string, Buffer>(),
    effects: [] as string[],
  };
  const commits = new Map<
    string,
    { sha: string; tree: { sha: string }; parents: Array<{ sha: string }>; message: string }
  >();
  const casRequests: Array<{ beforeOid: string; afterOid: string; force: boolean }> = [];
  mocks.runCommand.mockImplementation(async (args: string[], options: { input?: string } = {}) => {
    // The whole broker path must work with no Git repository on the Gateway.
    if (args[0] !== "gh") {
      throw new Error("Publication attempted a Gateway Git command");
    }
    const endpoint =
      args.find((arg) => arg.startsWith("repos/")) ?? (args.includes("graphql") ? "graphql" : "");
    const body = options.input ? JSON.parse(options.input) : undefined;
    if (endpoint === "repos/owner/repository") {
      return commandResult(
        JSON.stringify({ fork: false, default_branch: "main", node_id: "repository-node" }),
      );
    }
    if (endpoint.endsWith("/git/commits/" + baseCommit)) {
      return commandResult(JSON.stringify({ sha: baseCommit, tree: { sha: baseTree } }));
    }
    if (endpoint.endsWith("/git/commits/" + runtime.baseHead)) {
      return commandResult(
        JSON.stringify({ sha: runtime.baseHead, tree: { sha: runtime.baseHeadTree } }),
      );
    }
    if (endpoint.endsWith("/git/commits/" + runtime.mergeBase)) {
      return commandResult(
        JSON.stringify({ sha: runtime.mergeBase, tree: { sha: runtime.mergeBaseTree } }),
      );
    }
    if (endpoint.includes("/git/commits/")) {
      return commandResult(JSON.stringify(commits.get(endpoint.split("/").at(-1)!)));
    }
    if (
      endpoint.includes("/git/matching-refs/") &&
      decodeURIComponent(endpoint.split("/git/matching-refs/heads/")[1]!) !== workspace.branch
    ) {
      return commandResult(
        JSON.stringify(
          requestedRef === "topic"
            ? [{ ref: "refs/heads/topic", object: { sha: baseCommit } }]
            : [],
        ),
      );
    }
    if (endpoint.includes("/git/matching-refs/")) {
      const result = commandResult(
        JSON.stringify(
          runtime.head
            ? [{ ref: "refs/heads/" + workspace.branch, object: { sha: runtime.head } }]
            : [],
        ),
      );
      runtime.afterHeadObservation();
      return result;
    }
    if (endpoint.includes("/git/ref/heads/")) {
      return commandResult(
        JSON.stringify({
          ref: "refs/heads/" + decodeURIComponent(endpoint.split("/git/ref/heads/")[1]!),
          object: { sha: runtime.baseHead },
        }),
      );
    }
    if (endpoint.includes("/compare/")) {
      expect(endpoint).toContain("/compare/" + baseCommit + "..." + runtime.baseHead);
      return commandResult(
        JSON.stringify({ sha: runtime.commonHistory ? runtime.mergeBase : null }),
      );
    }
    if (endpoint.endsWith("/git/blobs")) {
      expect(body.encoding).toBe("base64");
      const bytes = Buffer.from(body.content, "base64");
      const sha = git(["hash-object", "-w", "--stdin"], bytes);
      runtime.uploaded.set(sha, bytes);
      return commandResult(JSON.stringify({ sha }));
    }
    if (endpoint.endsWith("/git/trees")) {
      expect(body.base_tree).toBe(baseTree);
      expect(body.tree).toHaveLength(1);
      expect(body.tree[0]).toMatchObject({ path: "counter.txt", mode: "100644", type: "blob" });
      const sha = git(["mktree"], `100644 blob ${body.tree[0].sha}\tcounter.txt\n`);
      return commandResult(JSON.stringify({ sha }));
    }
    if (endpoint.endsWith("/git/commits")) {
      expect(body.parents).toHaveLength(1);
      expect(body.parents[0] === baseCommit || commits.has(body.parents[0])).toBe(true);
      expect(body.message).toContain("OpenClaw-Publication:");
      const sha = git(["commit-tree", body.tree, "-p", body.parents[0]], body.message);
      const commit = {
        sha,
        tree: { sha: body.tree },
        parents: body.parents.map((parentSha: string) => ({ sha: parentSha })),
        message: body.message,
      };
      commits.set(sha, commit);
      return commandResult(JSON.stringify(commit));
    }
    if (endpoint === "graphql") {
      const update = body.variables.input.refUpdates[0];
      casRequests.push(update);
      expect(update.force).toBe(false);
      expect(body.variables.input.repositoryId).toBe("repository-node");
      expect(update.name).toBe("refs/heads/" + workspace.branch);
      if (runtime.changeHeadDuringPush) {
        runtime.head = "f".repeat(40);
      }
      if (update.beforeOid !== (runtime.head ?? "0".repeat(40))) {
        return commandResult(JSON.stringify({ errors: [{ message: "Ref lease failed" }] }), 1);
      }
      runtime.head = update.afterOid;
      if (runtime.pr) {
        runtime.pr.headSha = runtime.head!;
      }
      runtime.effects.push("push");
      runtime.afterPush();
      if (runtime.interruptPush) {
        runtime.interruptPush = false;
        throw new Error("Synthetic lost ref response");
      }
      return commandResult(
        JSON.stringify({
          data: { updateRefs: { clientMutationId: body.variables.input.clientMutationId } },
        }),
      );
    }
    if (endpoint.endsWith("/pulls") && args.includes("state=all")) {
      return commandResult(JSON.stringify(runtime.pr ? [runtime.pr] : []));
    }
    if (endpoint.endsWith("/pulls") && args.includes("POST")) {
      runtime.effects.push("pull_request");
      runtime.pr = {
        url: repositoryPublicationTestUrl,
        userId: runtime.accountId,
        state: runtime.closePullRequest ? "closed" : "open",
        body: body.body,
        headSha: runtime.head!,
        headRef: workspace.branch,
        baseRef: body.base,
      };
      return commandResult(
        JSON.stringify({ html_url: repositoryPublicationTestUrl }),
        runtime.closePullRequest ? 1 : 0,
      );
    }
    throw new Error("Unexpected GitHub endpoint " + endpoint);
  });
  const placements = createWorkerSessionPlacementStore({ database: openOpenClawStateDatabase() });
  return {
    baseCommit,
    baseTree,
    runtime,
    capture,
    first,
    casRequests,
    workspace,
    placements,
    closeSession: async (kind: "archive" | "reset") => {
      if (kind === "archive") {
        await patchSessionEntryCore(
          {
            agentId: "main",
            sessionKey: session.sessionKey,
            storePath: path.join(root, "sessions.json"),
          },
          () => ({ archivedAt: Date.now() }),
        );
      } else {
        await sessionOwner.reset(placements);
      }
    },
    coordinator: createTestGitHubPublicationCoordinator({ placements }),
  };
}
