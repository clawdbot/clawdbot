import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import { deletePersonalGitHubSessionReceipts } from "../state/github-personal-publication-lifecycle.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { getSessionRepositoryWorkspaceStore } from "../state/session-repository-workspaces.js";
import {
  callPersonalPublicationRpc,
  createPersonalPublicationFixture,
  personalPublicationAccount,
} from "./github-personal-publication.test-support.js";
import {
  SESSION_ID,
  SESSION_KEY,
  commandResult,
  createTestGitHubPublicationCoordinator,
  githubPublicationTestMocks,
  installGitHubPublicationTestHarness,
  root,
} from "./github-publication.test-support.js";
import {
  claimRepositoryGitHubPublication,
  listRepositoryGitHubPublications,
  readRepositoryGitHubPublication,
} from "./github-repository-publication-store.js";
import {
  REQUEST,
  seedActivePlacement,
} from "./worker-environments/placement-dispatch-test-fixtures.js";
import { createWorkerSessionPlacementStore } from "./worker-environments/placement-store.js";
import type { SessionRepositoryCheckpointPayload } from "./worker-environments/session-repository-checkpoints.js";

const mocks = githubPublicationTestMocks();
const checkpoint = vi.hoisted(() => vi.fn());
vi.mock("./worker-environments/session-repository-checkpoints.js", () => ({
  withSessionRepositoryCheckpoint: (...args: unknown[]) => checkpoint(...args),
}));
const baseCommit = "a".repeat(40);
const baseTree = "b".repeat(40);
const url = "https://github.com/owner/repository/pull/1";

async function repositoryFixture(
  requestedRef?: string,
  session = { sessionId: SESSION_ID, sessionKey: SESSION_KEY },
) {
  const store = getSessionRepositoryWorkspaceStore();
  let currentSessionId = session.sessionId;
  let archivedAt: number | undefined;
  let workspace = store.create({
    agentId: "main",
    sessionKey: session.sessionKey,
    url: "https://github.com/owner/repository.git",
    requestedRef,
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
        sessionId: currentSessionId,
        repositoryWorkspaceId: workspace.workspaceId,
        archivedAt,
      },
    };
  });
  const payloads = new Map<string, { publicationStagingRoot: string; publicationDigest: string }>();
  const trees = new Map<string, string>();
  const capture = async (content: string | null, suffix: string) => {
    const bytes = Buffer.from(content ?? "");
    const sha = createHash("sha1")
      .update("blob " + bytes.length + "\0")
      .update(bytes)
      .digest("hex");
    const workspaceTree =
      content === null
        ? baseTree
        : createHash("sha1")
            .update("tree-fixture:" + sha)
            .digest("hex");
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
    trees.set(sha, workspaceTree);
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
      const sha = createHash("sha1")
        .update("blob " + bytes.length + "\0")
        .update(bytes)
        .digest("hex");
      runtime.uploaded.set(sha, bytes);
      return commandResult(JSON.stringify({ sha }));
    }
    if (endpoint.endsWith("/git/trees")) {
      expect(body.base_tree).toBe(baseTree);
      expect(body.tree).toHaveLength(1);
      expect(body.tree[0]).toMatchObject({ path: "counter.txt", mode: "100644", type: "blob" });
      return commandResult(JSON.stringify({ sha: trees.get(body.tree[0].sha) }));
    }
    if (endpoint.endsWith("/git/commits")) {
      expect(body.parents).toHaveLength(1);
      expect(body.parents[0] === baseCommit || commits.has(body.parents[0])).toBe(true);
      expect(body.message).toContain("OpenClaw-Publication:");
      const sha = createHash("sha1").update(JSON.stringify(body)).digest("hex");
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
        url,
        userId: runtime.accountId,
        state: runtime.closePullRequest ? "closed" : "open",
        body: body.body,
        headSha: runtime.head!,
        headRef: workspace.branch,
        baseRef: body.base,
      };
      return commandResult(JSON.stringify({ html_url: url }), runtime.closePullRequest ? 1 : 0);
    }
    throw new Error("Unexpected GitHub endpoint " + endpoint);
  });
  const placements = createWorkerSessionPlacementStore({ database: openOpenClawStateDatabase() });
  return {
    runtime,
    capture,
    first,
    casRequests,
    workspace,
    placements,
    closeSession: (kind: "archive" | "reset") => {
      if (kind === "archive") {
        archivedAt = Date.now();
      } else {
        currentSessionId = "reset-" + session.sessionId;
      }
    },
    coordinator: createTestGitHubPublicationCoordinator({ placements }),
  };
}

describe("repository checkpoint GitHub publication", () => {
  installGitHubPublicationTestHarness();
  afterEach(() => vi.unstubAllGlobals());

  it("publishes the accepted checkpoint with an absent-ref lease and replays the same receipt", async () => {
    const f = await repositoryFixture();
    const input = { agentId: "main", sessionKey: SESSION_KEY, idempotencyKey: "shared" };
    const published = await f.coordinator.requestForSession(input);
    expect(published).toMatchObject({ status: "published", url, publisher: { accountId: 42 } });
    expect(f.runtime.uploaded.get(f.first.sha)).toEqual(Buffer.from("accepted first\n"));
    expect(f.casRequests[0]).toMatchObject({ beforeOid: "0".repeat(40), force: false });
    expect(await f.coordinator.requestForSession(input)).toEqual(published);
    expect(f.runtime.effects).toEqual(["push", "pull_request"]);
    expect(mocks.findWorktree).not.toHaveBeenCalled();
    expect(mocks.resolveRepository).not.toHaveBeenCalled();
  });

  it("replays the current receipt when another same-key call finishes before reservation", async () => {
    const f = await repositoryFixture();
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const secondAdmitted = createDeferredCore();
    const enterSecondReservation = createDeferredCore();
    const capture = checkpoint.getMockImplementation()!;
    checkpoint.mockImplementationOnce(async (...args) => {
      entered.resolve();
      await release.promise;
      return await capture(...args);
    });
    const reserve = f.placements.withRepositoryWorkspaceReservation.bind(f.placements);
    let reservations = 0;
    vi.spyOn(f.placements, "withRepositoryWorkspaceReservation").mockImplementation(
      async <T>(
        identity: Parameters<typeof reserve>[0],
        run: (assertCurrent: () => void) => Promise<T>,
      ) => {
        if (++reservations === 2) {
          // The real lease rejects contention; delay this admitted request before
          // acquisition so it carries a stale receipt across the awaited boundary.
          secondAdmitted.resolve();
          await enterSecondReservation.promise;
        }
        return await reserve(identity, run);
      },
    );
    const input = { agentId: "main", sessionKey: SESSION_KEY, idempotencyKey: "concurrent-shared" };
    const first = f.coordinator.requestForSession(input);
    void first.catch(entered.reject);
    let second: typeof first | undefined;
    try {
      await entered.promise;
      second = f.coordinator.requestForSession(input);
      void second.catch(secondAdmitted.reject);
      await secondAdmitted.promise;
      release.resolve();
      const published = await first;
      enterSecondReservation.resolve();
      expect(await second).toEqual(published);
      expect(published.status).toBe("published");
      expect(listRepositoryGitHubPublications()).toHaveLength(1);
      expect(f.runtime.effects).toEqual(["push", "pull_request"]);
    } finally {
      release.resolve();
      enterSecondReservation.resolve();
      await Promise.allSettled([first, ...(second ? [second] : [])]);
    }
  });

  it.each(["topic", "refs/tags/release", baseCommit])(
    "publishes unchanged pinned ref %s when its merge-base has a different tree",
    async (ref) => {
      const f = await repositoryFixture(ref);
      await f.capture(null, "unchanged-pinned-source");
      f.runtime.baseHead = "d".repeat(40);
      f.runtime.baseHeadTree = "c".repeat(40);
      f.runtime.mergeBase = "e".repeat(40);
      f.runtime.mergeBaseTree = "c".repeat(40);
      const result = await f.coordinator.requestForSession({
        agentId: "main",
        sessionKey: SESSION_KEY,
        idempotencyKey: "related-ref",
      });
      expect(result.status).toBe("published");
      expect(f.runtime.pr?.baseRef).toBe(ref === "topic" ? "topic" : "main");
      expect(f.runtime.uploaded.size).toBe(0);
      expect(readRepositoryGitHubPublication(result.requestId)?.workspace_tree).toBe(baseTree);
      expect(f.casRequests[0]).toMatchObject({ beforeOid: "0".repeat(40), force: false });
    },
  );

  it("rejects a missing common ancestor before uploading or changing references", async () => {
    const f = await repositoryFixture();
    f.runtime.commonHistory = false;
    const result = await f.coordinator.requestForSession({
      agentId: "main",
      sessionKey: SESSION_KEY,
      idempotencyKey: "unrelated-ref",
    });
    expect(result.status).toBe("failed");
    expect(f.runtime.uploaded.size).toBe(0);
    expect(f.runtime.effects).toEqual([]);
  });

  it.each([false, true])(
    "reports no changes for an unchanged pinned ancestor (PR base advanced: %s)",
    async (advanced) => {
      const f = await repositoryFixture();
      if (advanced) {
        f.runtime.baseHead = "d".repeat(40);
        f.runtime.baseHeadTree = "c".repeat(40);
      }
      await f.capture(null, "unchanged-pr-base");
      const result = await f.coordinator.requestForSession({
        agentId: "main",
        sessionKey: SESSION_KEY,
        idempotencyKey: "unchanged-pr-base",
      });
      expect(result).toMatchObject({ status: "failed", code: "no_changes" });
      expect(f.runtime.uploaded.size).toBe(0);
      expect(f.runtime.effects).toEqual([]);
    },
  );

  it("distinguishes an unchanged published tree from a complete revert to the PR base", async () => {
    const f = await repositoryFixture();
    const publish = (idempotencyKey: string) =>
      f.coordinator.requestForSession({
        agentId: "main",
        sessionKey: SESSION_KEY,
        idempotencyKey,
      });
    const first = await publish("before-revert");
    expect(first.status).toBe("published");
    const previousHead = f.runtime.head;
    expect(await publish("unchanged-prior-head")).toMatchObject({
      status: "failed",
      code: "no_changes",
    });
    expect(f.casRequests).toHaveLength(1);
    await f.capture(null, "complete-revert");
    const reverted = await publish("complete-revert");
    expect(reverted).toMatchObject({ status: "published", url });
    expect(readRepositoryGitHubPublication(reverted.requestId)).toMatchObject({
      workspace_tree: baseTree,
      previous_head_commit: previousHead,
      source_head_commit: baseCommit,
    });
    expect(f.runtime.head).not.toBe(previousHead);
    expect(f.casRequests[1]).toMatchObject({
      beforeOid: previousHead,
      afterOid: f.runtime.head,
      force: false,
    });
    expect(f.runtime.effects).toEqual(["push", "pull_request", "push"]);
    f.runtime.head = "f".repeat(40);
    expect(await publish("foreign-head-after-revert")).toMatchObject({
      status: "failed",
      code: "push_rejected",
    });
    expect(f.casRequests).toHaveLength(2);
  });

  it("does not recreate a deleted branch when a prior published head was recorded", async () => {
    const f = await repositoryFixture();
    await f.coordinator.requestForSession({
      agentId: "main",
      sessionKey: SESSION_KEY,
      idempotencyKey: "before-delete",
    });
    f.runtime.head = null;
    await f.capture("next accepted change\n", "after-delete");
    const result = await f.coordinator.requestForSession({
      agentId: "main",
      sessionKey: SESSION_KEY,
      idempotencyKey: "after-delete",
    });
    expect(result).toMatchObject({ status: "failed", code: "push_rejected" });
    expect(f.runtime.head).toBeNull();
    expect(f.casRequests).toHaveLength(1);
    expect(f.runtime.effects).toEqual(["push", "pull_request"]);
  });

  it("extends its recorded pushed head after the earlier PR was closed before confirmation", async () => {
    const f = await repositoryFixture();
    f.runtime.closePullRequest = true;
    const failed = await f.coordinator.requestForSession({
      agentId: "main",
      sessionKey: SESSION_KEY,
      idempotencyKey: "closed-before-confirmation",
    });
    expect(failed).toMatchObject({ status: "failed", code: "github_rejected" });
    const pushedHead = f.runtime.head;
    expect(pushedHead).not.toBeNull();
    expect(readRepositoryGitHubPublication(failed.requestId)).toMatchObject({
      pushed_head_commit: pushedHead,
      last_effect: "pull_request",
      effect_state: "observed",
    });
    f.runtime.closePullRequest = false;
    await f.capture("accepted after closed PR\n", "after-closed-pr");
    const published = await f.coordinator.requestForSession({
      agentId: "main",
      sessionKey: SESSION_KEY,
      idempotencyKey: "fresh-after-closed-pr",
    });
    expect(published.status).toBe("published");
    expect(f.casRequests[1]).toMatchObject({ beforeOid: pushedHead, force: false });
    expect(f.runtime.effects).toEqual(["push", "pull_request", "push", "pull_request"]);
  });

  it("records a recovered push response even when authority closes during its observation", async () => {
    const f = await repositoryFixture();
    f.runtime.interruptPush = true;
    let current = true;
    const request = {
      agentId: "main",
      sessionKey: SESSION_KEY,
      idempotencyKey: "lost-push-response",
      assertCurrent: () => {
        if (!current) {
          throw new Error("Publication authority closed");
        }
      },
    };
    const first = await f.coordinator.requestForSession(request);
    expect(first.status).toBe("requested");
    expect(readRepositoryGitHubPublication(first.requestId)?.pushed_head_commit).toBeNull();
    f.runtime.afterHeadObservation = () => {
      current = false;
    };
    expect((await f.coordinator.requestForSession(request)).status).toBe("requested");
    expect(readRepositoryGitHubPublication(first.requestId)?.pushed_head_commit).toBe(
      f.runtime.head,
    );
    expect(f.runtime.effects).toEqual(["push"]);
  });

  it.each(["archive", "reset"] as const)(
    "retires a pending receipt after %s and continues a later session's publication",
    async (kind) => {
      const stale = await repositoryFixture();
      stale.runtime.interruptPush = true;
      const first = await stale.coordinator.requestForSession({
        agentId: "main",
        sessionKey: SESSION_KEY,
        idempotencyKey: "stale-before-recovery",
      });
      expect(first.status).toBe("requested");
      const retained = claimRepositoryGitHubPublication(
        readRepositoryGitHubPublication(first.requestId)!,
        "retained-execution",
        () => {},
      );
      stale.closeSession(kind);
      const validSession = {
        sessionId: "valid-later-session",
        sessionKey: "agent:main:valid-later",
      };
      const valid = await repositoryFixture(undefined, validSession);
      valid.runtime.interruptPush = true;
      const second = await valid.coordinator.requestForSession({
        agentId: "main",
        sessionKey: validSession.sessionKey,
        idempotencyKey: "valid-after-stale",
      });
      expect(second.status).toBe("requested");
      await valid.coordinator.resumeSessionRequests();
      expect(readRepositoryGitHubPublication(first.requestId)).toMatchObject({
        status: "failed",
        error_code: "session_changed",
        execution_id: null,
      });
      expect(retained.ownsExecution()).toBe(false);
      expect(() => retained.recordEffect("push", { headCommit: stale.runtime.head! })).toThrow();
      expect(readRepositoryGitHubPublication(second.requestId)?.status).toBe("published");
      expect(valid.runtime.effects).toEqual(["push", "pull_request"]);
      expect(stale.runtime.effects).toEqual(["push"]);
    },
  );

  it.each(["pending result", "reservation", "identity mismatch"] as const)(
    "continues later publications when the first session has a %s and reports hard failures",
    async (blocker) => {
      const blocked = await repositoryFixture(undefined, REQUEST);
      blocked.runtime.interruptPush = true;
      const first = await blocked.coordinator.requestForSession({
        agentId: REQUEST.agentId,
        sessionKey: REQUEST.sessionKey,
        idempotencyKey: "blocked-first",
      });
      expect(first.status).toBe("requested");
      const released = createDeferredCore();
      let held: Promise<void> | undefined;
      try {
        if (blocker === "pending result") {
          seedActivePlacement(blocked.placements, {
            environmentId: "pending-publication-worker",
            ownerEpoch: 7,
            executionMode: "remote-exec",
          });
          const pendingClaim = blocked.placements.claimTurn({
            sessionId: REQUEST.sessionId,
            sessionKey: REQUEST.sessionKey,
            agentId: REQUEST.agentId,
            claimId: "pending-result-claim",
            runId: "pending-result-run",
            owner: { kind: "local", environmentId: "pending-publication-worker", ownerEpoch: 7 },
          });
          blocked.placements.markWorkspaceResultPending(pendingClaim);
          expect(blocked.placements.clearLocalTurnClaimsAfterRestart()).toBe(1);
          expect(blocked.placements.get(REQUEST.sessionId)?.turnClaim).toBeNull();
          expect(blocked.placements.listPendingWorkspaceResults()).toHaveLength(1);
        } else if (blocker === "reservation") {
          const entered = createDeferredCore();
          held = blocked.placements.withWorkspaceExclusion(REQUEST.sessionId, async () => {
            entered.resolve();
            await released.promise;
          });
          void held.catch(entered.reject);
          await entered.promise;
        } else {
          blocked.placements.startDispatch({ ...REQUEST, agentId: "different-agent" });
        }
        const validSession = {
          sessionId: "valid-after-blocked",
          sessionKey: "agent:main:valid-after-blocked",
        };
        const valid = await repositoryFixture(undefined, validSession);
        valid.runtime.interruptPush = true;
        const second = await valid.coordinator.requestForSession({
          agentId: "main",
          sessionKey: validSession.sessionKey,
          idempotencyKey: "valid-after-blocked",
        });
        expect(second.status).toBe("requested");
        expect(
          listRepositoryGitHubPublications({ pending: true }).map((row) => row.request_id),
        ).toEqual([first.requestId, second.requestId]);
        const recovery = valid.coordinator.resumeSessionRequests();
        if (blocker === "identity mismatch") {
          await expect(recovery).rejects.toThrow("placement identity changed");
        } else {
          await recovery;
        }
        expect(readRepositoryGitHubPublication(first.requestId)?.status).toBe("requested");
        expect(readRepositoryGitHubPublication(second.requestId)?.status).toBe("published");
        expect(blocked.runtime.effects).toEqual(["push"]);
        expect(valid.runtime.effects).toEqual(["push", "pull_request"]);
      } finally {
        released.resolve();
        await held;
      }
    },
  );

  it.each(["worker-turn", "remote-exec"] as const)(
    "publishes the accepted checkpoint for an in-turn %s request under its exact remote claim",
    async (executionMode) => {
      const f = await repositoryFixture(undefined, REQUEST);
      seedActivePlacement(f.placements, {
        environmentId: "in-turn-worker",
        ownerEpoch: 7,
        executionMode,
      });
      const claim = f.placements.claimTurn({
        sessionId: REQUEST.sessionId,
        sessionKey: REQUEST.sessionKey,
        agentId: REQUEST.agentId,
        claimId: "in-turn-publication",
        runId: "in-turn-run",
        owner: {
          kind: executionMode === "remote-exec" ? "local" : "worker",
          environmentId: "in-turn-worker",
          ownerEpoch: 7,
        },
      });
      const requested = await f.coordinator.requestForSession({
        sessionKey: REQUEST.sessionKey,
        agentId: REQUEST.agentId,
        expectedRunId: claim.runId,
        idempotencyKey: "in-turn-" + executionMode,
      });
      expect(requested.status).toBe("requested");
      expect(readRepositoryGitHubPublication(requested.requestId)).toMatchObject({
        claim_id: claim.claimId,
        run_id: claim.runId,
        environment_id: "in-turn-worker",
        owner_epoch: 7,
        placement_generation: claim.placementGeneration,
        checkpoint_ref: null,
      });
      expect(f.runtime.effects).toEqual([]);
      const accepted = await f.capture("completed turn change\n", "in-turn-completed");
      f.placements.markWorkspaceResultPending(claim);
      await f.coordinator.prepareClaimWorkspace(claim);
      f.placements.acceptWorkspaceResult(claim);
      expect(await f.coordinator.processClaim(claim)).toEqual([
        expect.objectContaining({ requestId: requested.requestId, status: "published" }),
      ]);
      expect(f.runtime.uploaded.get(accepted.sha)).toEqual(Buffer.from("completed turn change\n"));
      expect(f.runtime.uploaded.has(f.first.sha)).toBe(false);
      expect(f.runtime.effects).toEqual(["push", "pull_request"]);
    },
  );

  it.each([null, "worker-turn", "remote-exec"] as const)(
    "rejects a stale supplied run ID with %s placement while preserving direct session requests",
    async (executionMode) => {
      const f = await repositoryFixture(undefined, REQUEST);
      if (executionMode) {
        seedActivePlacement(f.placements, {
          environmentId: "run-scoped-worker",
          ownerEpoch: 7,
          executionMode,
        });
        f.placements.claimTurn({
          sessionId: REQUEST.sessionId,
          sessionKey: REQUEST.sessionKey,
          agentId: REQUEST.agentId,
          claimId: "current-claim",
          runId: "current-run",
          owner: {
            kind: executionMode === "remote-exec" ? "local" : "worker",
            environmentId: "run-scoped-worker",
            ownerEpoch: 7,
          },
        });
      }
      const input = {
        sessionKey: REQUEST.sessionKey,
        agentId: REQUEST.agentId,
        idempotencyKey: "stale-supplied-run",
      };
      await expect(
        f.coordinator.requestForSession({ ...input, expectedRunId: "stale-run" }),
      ).rejects.toThrow("run identity changed");
      expect(listRepositoryGitHubPublications()).toEqual([]);
      expect(mocks.prepareIdentity).not.toHaveBeenCalled();
      expect(f.runtime.effects).toEqual([]);
      const direct = await f.coordinator.requestForSession(input);
      expect(direct.status).toBe(executionMode ? "requested" : "published");
      expect(readRepositoryGitHubPublication(direct.requestId)?.claim_id).toBeNull();
    },
  );

  it("does not treat a pure Gateway-local claim as a repository worker owner", async () => {
    const f = await repositoryFixture();
    const claim = f.placements.claimTurn({
      sessionId: SESSION_ID,
      sessionKey: SESSION_KEY,
      agentId: "main",
      claimId: "gateway-local",
      runId: "gateway-local-run",
      owner: { kind: "local" },
    });
    await expect(
      f.coordinator.requestForSession({
        sessionKey: SESSION_KEY,
        agentId: "main",
        expectedRunId: claim.runId,
        idempotencyKey: "gateway-local",
      }),
    ).rejects.toThrow("session authority changed");
    expect(mocks.prepareIdentity).not.toHaveBeenCalled();
    expect(listRepositoryGitHubPublications()).toEqual([]);
  });

  it.each(["mismatched environment", "replaced claim"] as const)(
    "rejects a remote-exec publication with a %s before recording an intent",
    async (mismatch) => {
      const f = await repositoryFixture(undefined, REQUEST);
      seedActivePlacement(f.placements, {
        environmentId: "owned-worker",
        ownerEpoch: 7,
        executionMode: "remote-exec",
      });
      const input = {
        sessionId: REQUEST.sessionId,
        sessionKey: REQUEST.sessionKey,
        agentId: REQUEST.agentId,
        claimId: "owned-claim",
        runId: "owned-run",
        owner: { kind: "local" as const, environmentId: "owned-worker", ownerEpoch: 7 },
      };
      const claim = f.placements.claimTurn(input);
      if (mismatch === "replaced claim") {
        const prepare = mocks.prepareIdentity.getMockImplementation()!;
        mocks.prepareIdentity.mockImplementationOnce(async (...args) => {
          const identity = await prepare(...args);
          f.placements.releaseTurn(claim);
          f.placements.claimTurn({
            ...input,
            claimId: "replacement-claim",
            runId: "replacement-run",
          });
          return identity;
        });
      }
      await expect(
        f.coordinator.requestForClaim({
          claim:
            mismatch === "mismatched environment"
              ? { ...claim, owner: { ...claim.owner, environmentId: "other-worker" } }
              : claim,
          sessionKey: REQUEST.sessionKey,
          agentId: REQUEST.agentId,
          idempotencyKey: "closed-remote-owner",
        }),
      ).rejects.toThrow("session authority changed");
      expect(listRepositoryGitHubPublications()).toEqual([]);
      expect(f.runtime.effects).toEqual([]);
    },
  );

  it.each(["placement_generation", "environment_id", "owner_epoch"] as const)(
    "does not bind, process, or defer a request whose %s belongs to a different claim",
    async (column) => {
      const f = await repositoryFixture();
      let placement = f.placements.startDispatch({
        sessionId: SESSION_ID,
        sessionKey: SESSION_KEY,
        agentId: "main",
        executionMode: "worker-turn",
      });
      placement = f.placements.transition({
        sessionId: SESSION_ID,
        from: "requested",
        to: "provisioning",
        expectedGeneration: placement.generation,
        patch: { environmentId: "publication-worker" },
      });
      placement = f.placements.transition({
        sessionId: SESSION_ID,
        from: "provisioning",
        to: "syncing",
        expectedGeneration: placement.generation,
        patch: { workerBundleHash: "b".repeat(64) },
      });
      placement = f.placements.transition({
        sessionId: SESSION_ID,
        from: "syncing",
        to: "starting",
        expectedGeneration: placement.generation,
        patch: {
          workspaceBaseManifestRef: "sha256:" + "1".repeat(64),
          remoteWorkspaceDir: "/worker/workspace",
        },
      });
      f.placements.transition({
        sessionId: SESSION_ID,
        from: "starting",
        to: "active",
        expectedGeneration: placement.generation,
        patch: { activeOwnerEpoch: 7 },
      });
      const claim = f.placements.claimTurn({
        sessionId: SESSION_ID,
        sessionKey: SESSION_KEY,
        agentId: "main",
        claimId: "publication-claim",
        runId: "publication-run",
        owner: { kind: "worker", environmentId: "publication-worker", ownerEpoch: 7 },
      });
      const accepted = await f.coordinator.requestForClaim({
        claim,
        sessionKey: SESSION_KEY,
        agentId: "main",
        idempotencyKey: "different-claim",
      });
      const db = openOpenClawStateDatabase().db;
      db.prepare(
        "UPDATE github_repository_publication_requests SET " + column + " = ? WHERE request_id = ?",
      ).run(column === "environment_id" ? "different-worker" : 999, accepted.requestId);
      await f.coordinator.prepareClaimWorkspace(claim);
      expect(readRepositoryGitHubPublication(accepted.requestId)?.checkpoint_ref).toBeNull();
      expect(await f.coordinator.processClaim(claim)).toEqual([]);
      f.coordinator.deferClaimPreparation(claim);
      expect(readRepositoryGitHubPublication(accepted.requestId)?.claim_id).toBe(claim.claimId);
      f.coordinator.deferOrphanedRequests();
      expect(readRepositoryGitHubPublication(accepted.requestId)?.claim_id).toBeNull();
      expect(f.runtime.effects).toEqual([]);
    },
  );

  it("requires the same personal owner after restart and publishes its retained checkpoint after a later turn", async () => {
    const f = await repositoryFixture();
    const person = await createPersonalPublicationFixture();
    f.runtime.accountId = personalPublicationAccount.accountId;
    f.runtime.interruptPush = true;
    const request = {
      sessionKey: SESSION_KEY,
      idempotencyKey: "personal",
      selection: {
        source: "personal",
        generation: person.generation,
        account: personalPublicationAccount,
      },
    };
    const first = (await callPersonalPublicationRpc(person, "sessions.github.publish", request))[1];
    expect(first.status).toBe("needs_confirmation");
    const original = readRepositoryGitHubPublication(first.requestId)!;
    expect(original.pushed_head_commit).toBeNull();
    await f.capture("later unselected change\n", "later");
    person.coordinator = createTestGitHubPublicationCoordinator({ placements: person.placements });
    const pending = person.coordinator.personalStatus(
      person.action,
      person.action,
      first.requestId,
    );
    expect(pending.confirmation?.workspaceTree).toBe(f.first.workspaceTree);
    expect(() =>
      person.coordinator.personalStatus(
        { ...person.action, owner: person.otherOwner },
        person.action,
        first.requestId,
      ),
    ).toThrow();
    const confirmed = await callPersonalPublicationRpc(person, "sessions.github.confirm", {
      sessionKey: SESSION_KEY,
      requestId: first.requestId,
      generation: person.generation,
      account: personalPublicationAccount,
      requestDigest: pending.confirmation!.requestDigest,
    });
    expect(confirmed[0], JSON.stringify(confirmed[2])).toBe(true);
    expect(confirmed[1]).toMatchObject({ status: "published", url });
    expect(readRepositoryGitHubPublication(first.requestId)?.checkpoint_ref).toBe(
      original.checkpoint_ref,
    );
    expect(readRepositoryGitHubPublication(first.requestId)?.pushed_head_commit).toBe(
      f.runtime.head,
    );
    expect(f.runtime.effects).toEqual(["push", "pull_request"]);
    expect(f.runtime.uploaded.size).toBe(1);
  });

  it("does not overwrite a branch changed after observation", async () => {
    const f = await repositoryFixture();
    f.runtime.changeHeadDuringPush = true;
    const result = await f.coordinator.requestForSession({
      agentId: "main",
      sessionKey: SESSION_KEY,
      idempotencyKey: "ref-race",
    });
    expect(result.status).toBe("requested");
    expect(f.runtime.head).toBe("f".repeat(40));
    expect(f.runtime.effects).toEqual([]);
    expect(f.casRequests[0]).toMatchObject({ beforeOid: "0".repeat(40) });
    expect(listRepositoryGitHubPublications()[0]).toMatchObject({
      last_effect: "push",
      effect_state: "dispatched",
    });
  });

  it.each(["shared", "personal"] as const)(
    "fences a retained %s execution when its session receipts are deleted",
    async (source) => {
      const f = await repositoryFixture();
      f.runtime.interruptPush = true;
      let requestId: string;
      if (source === "personal") {
        const person = await createPersonalPublicationFixture();
        f.runtime.accountId = personalPublicationAccount.accountId;
        const result = await person.coordinator.requestPersonalForSession(
          {
            sessionKey: SESSION_KEY,
            idempotencyKey: "delete-personal",
            selection: {
              source: "personal",
              generation: person.generation,
              account: personalPublicationAccount,
            },
          },
          person.action,
        );
        requestId = result.requestId;
      } else {
        requestId = (
          await f.coordinator.requestForSession({
            agentId: "main",
            sessionKey: SESSION_KEY,
            idempotencyKey: "delete-shared",
          })
        ).requestId;
      }
      const row = readRepositoryGitHubPublication(requestId)!;
      const execution = claimRepositoryGitHubPublication(row, "current-instance", () => {});
      deletePersonalGitHubSessionReceipts({ agentId: "main", sessionKeys: [SESSION_KEY] });
      expect(execution.ownsExecution()).toBe(false);
      expect(() => execution.recordEffect("push")).toThrow();
      expect(() => execution.recordEffect("push", { headCommit: "e".repeat(40) })).toThrow();
    },
  );
});
