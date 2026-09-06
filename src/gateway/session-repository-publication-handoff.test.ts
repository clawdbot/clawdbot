import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { managedWorktrees } from "../agents/worktrees/service.js";
import { loadSessionEntry, upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { registerClonedProjectRegistry } from "../projects/project-registry.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { getSessionRepositoryWorkspaceStore } from "../state/session-repository-workspaces.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { executeGitHubPublication } from "./github-publication-executor.js";
import {
  ensureGitHubPublicationStore,
  insertGitHubPublicationRequest,
  claimGitHubPublicationExecution,
  createGitHubPublicationExecutionStore,
  projectGitHubPublicationResult,
} from "./github-publication-store.js";
import { REMOTE_GITHUB_PUBLICATION_SNAPSHOT_JS } from "./github-repository-publication-snapshot.js";
import {
  insertRepositoryGitHubPublication,
  repositoryGitHubPublicationDigest,
  claimRepositoryGitHubPublication,
  readRepositoryGitHubPublication,
  type RepositoryGitHubPublicationRow,
} from "./github-repository-publication-store.js";
import { assertReceiptOwner } from "./github-repository-publication-workspace.js";
import { materializeSessionRepositoryWorkspaceOnGateway } from "./session-repository-materialization.js";
import { stageSessionRepositoryCheckpoint } from "./worker-environments/session-repository-checkpoints.js";
import { serializeWorkerWorkspaceManifest } from "./worker-environments/workspace-manifest.js";
import { readActualWorkspaceManifest } from "./worker-environments/workspace-reconcile-core.js";
const mocked = vi.hoisted(() => ({ run: vi.fn(), timed: vi.fn() }));
vi.mock("../process/exec.js", async (original) => ({
  ...(await original<typeof import("../process/exec.js")>()),
  runCommandBuffered: mocked.run,
  runCommandWithTimeout: mocked.timed,
}));
vi.mock("./worker-environments/worker-github-binding.js", () => ({
  prepareWorkerGitHubBinding: async () => undefined,
}));
afterEach(() => vi.restoreAllMocks());
it.each([
  "shared",
  "personal",
  "fork",
  "topic",
  "unsettled",
  "foreign head",
  "revoked",
  "shifted membership",
] as const)(
  "continues publication through the actual Gateway handoff: %s",
  async (scenario) => {
    await withOpenClawTestState({ label: "publication-handoff" }, async (state) => {
      const actual =
        await vi.importActual<typeof import("../process/exec.js")>("../process/exec.js");
      mocked.run.mockImplementation(actual.runCommandBuffered);
      mocked.timed.mockImplementation(actual.runCommandWithTimeout);
      const cfg = { agents: { entries: { main: { workspace: state.workspaceDir } } } };
      await state.writeConfig(cfg);
      const source = state.path("source"),
        bare = state.path("origin.git"),
        cloud = state.path("cloud");
      await fs.mkdir(source);
      const env = {
        ...process.env,
        GIT_CONFIG_GLOBAL: os.devNull,
        GIT_CONFIG_SYSTEM: os.devNull,
        GIT_AUTHOR_NAME: "Handoff Proof",
        GIT_AUTHOR_EMAIL: "handoff@example.test",
        GIT_COMMITTER_NAME: "Handoff Proof",
        GIT_COMMITTER_EMAIL: "handoff@example.test",
      };
      const git = (cwd: string, ...args: string[]) =>
        execFileSync("git", args, {
          cwd,
          env,
          encoding: "utf8",
          stdio: ["pipe", "pipe", "pipe"],
        }).trim();
      git(source, "init", "-q", "-b", "main");
      await fs.writeFile(path.join(source, "file.txt"), "base\n");
      if (scenario === "shifted membership") {
        await fs.writeFile(path.join(source, ".gitignore"), "*.ignored\n");
        await fs.writeFile(path.join(source, ".worktreeinclude"), "published-only.ignored\n");
        await fs.writeFile(path.join(source, "restored.ignored"), "original accepted\n");
        git(source, "add", "-f", "restored.ignored");
      }
      git(source, "add", ".");
      git(source, "commit", "-qm", "base");
      const baseCommit = git(source, "rev-parse", "HEAD");
      if (scenario === "topic") {
        git(source, "branch", "topic");
      }
      const baseBranch = scenario === "topic" ? "topic" : "main";
      const prRepository =
        scenario === "fork" ? "upstream/handoff-fixture" : "example/handoff-fixture";
      git(state.root, "clone", "--bare", "--quiet", source, bare);
      git(state.root, "clone", "--quiet", bare, cloud);
      const url = "https://github.com/example/handoff-fixture.git";
      git(source, "remote", "add", "origin", url);
      await registerClonedProjectRegistry({ path: source, name: "Handoff", originUrl: url });
      const scope = { agentId: "main", sessionKey: "agent:main:dashboard:handoff" };
      const store = getSessionRepositoryWorkspaceStore();
      let repository = store.create({
        ...scope,
        url,
        runSetupScript: false,
        requestedRef: scenario === "topic" ? "topic" : undefined,
        assertCurrent: () => {},
      });
      const base = await readActualWorkspaceManifest({ root: source, baseCommit });
      repository = store.bindBase({
        workspaceId: repository.workspaceId,
        expectedRevision: repository.revision,
        baseCommit,
        baseManifestHash: base.manifestRef,
        assertCurrent: () => {},
      });
      git(cloud, "switch", "-c", repository.branch);
      await fs.writeFile(path.join(cloud, "file.txt"), "published cloud\n");
      if (scenario === "shifted membership") {
        git(cloud, "rm", "restored.ignored");
        await fs.writeFile(path.join(cloud, "published-only.ignored"), "cloud publication only\n");
        git(cloud, "add", "-f", "published-only.ignored");
      }
      git(cloud, "commit", "-qam", "Cloud\n\nOpenClaw-Publication: prior-cloud-publication");
      const publishedHead = git(cloud, "rev-parse", "HEAD");
      git(cloud, "push", "origin", repository.branch);
      const priorCurrent = await readActualWorkspaceManifest({ root: cloud, baseCommit });
      const priorPublication = state.path("prior-publication");
      const priorDigest = execFileSync(
        process.execPath,
        ["-e", REMOTE_GITHUB_PUBLICATION_SNAPSHOT_JS, cloud, baseCommit, priorPublication],
        { env, encoding: "utf8" },
      ).trim();
      const priorCheckpoint = await stageSessionRepositoryCheckpoint({
        workspaceId: repository.workspaceId,
        expectedRevision: repository.revision,
        stagingRoot: cloud,
        baseManifestRaw: serializeWorkerWorkspaceManifest(base.manifest),
        currentManifestRaw: serializeWorkerWorkspaceManifest(priorCurrent.manifest),
        baseManifestRef: base.manifestRef,
        currentManifestRef: priorCurrent.manifestRef,
        publicationStagingRoot: priorPublication,
        publicationDigest: priorDigest,
        assertCurrent: () => {},
      });
      repository = await priorCheckpoint.publish();
      if (scenario === "shifted membership") {
        git(cloud, "rm", "--cached", "published-only.ignored");
        await fs.writeFile(path.join(cloud, "restored.ignored"), "original accepted\n");
        git(cloud, "add", "-f", "restored.ignored");
      }
      await fs.writeFile(path.join(cloud, "later.txt"), "accepted after publication\n");
      const current = await readActualWorkspaceManifest({ root: cloud, baseCommit });
      const publication = state.path("publication");
      const digest = execFileSync(
        process.execPath,
        ["-e", REMOTE_GITHUB_PUBLICATION_SNAPSHOT_JS, cloud, baseCommit, publication],
        { env, encoding: "utf8" },
      ).trim();
      const staged = await stageSessionRepositoryCheckpoint({
        workspaceId: repository.workspaceId,
        expectedRevision: repository.revision,
        stagingRoot: cloud,
        baseManifestRaw: serializeWorkerWorkspaceManifest(base.manifest),
        currentManifestRaw: serializeWorkerWorkspaceManifest(current.manifest),
        baseManifestRef: base.manifestRef,
        currentManifestRef: current.manifestRef,
        publicationStagingRoot: publication,
        publicationDigest: digest,
        assertCurrent: () => {},
      });
      repository = await staged.publish();
      const sessionId = "handoff-session",
        lifecycleRevision = "handoff-lifecycle";
      await upsertSessionEntryCore(scope, {
        sessionId,
        lifecycleRevision,
        repositoryWorkspaceId: repository.workspaceId,
      });
      const row: RepositoryGitHubPublicationRow = {
        request_id: "prior-cloud-publication",
        idempotency_key: "prior",
        request_digest: "",
        session_id: sessionId,
        session_lifecycle_revision: lifecycleRevision,
        session_key: scope.sessionKey,
        agent_id: scope.agentId,
        workspace_id: repository.workspaceId,
        owner_profile_id: scenario === "personal" ? "personal-owner" : null,
        connection_generation: scenario === "personal" ? "personal-generation" : null,
        identity_source: scenario === "personal" ? "personal" : "system-configured",
        identity_profile_id:
          scenario === "personal" ? null : "ghp_11111111111111111111111111111111",
        identity_account_id: 42,
        identity_login: "proof",
        title: "Cloud",
        body: null,
        push_repository: "example/handoff-fixture",
        repository: prRepository,
        base_branch: baseBranch,
        branch: repository.branch,
        previous_head_commit: null,
        claim_id: null,
        run_id: null,
        placement_generation: null,
        environment_id: null,
        owner_epoch: null,
        checkpoint_ref: priorCheckpoint.checkpointRef,
        checkpoint_digest: priorDigest,
        source_head_commit: baseCommit,
        source_index_tree: git(source, "rev-parse", "HEAD^{tree}"),
        workspace_tree: git(cloud, "rev-parse", publishedHead + "^{tree}"),
        status: "requested",
        execution_id: null,
        gateway_instance_id: null,
        head_commit: publishedHead,
        pushed_head_commit: null,
        pull_request_url: null,
        last_effect: null,
        effect_state: null,
        error_code: null,
        next_action: null,
        created_at_ms: 1,
        updated_at_ms: 1,
        reported_at_ms: null,
      };
      row.request_digest = repositoryGitHubPublicationDigest(row);
      insertRepositoryGitHubPublication(row, () => {});
      const prior = claimRepositoryGitHubPublication(row, "cloud-instance", () => {});
      prior.recordEffect("push");
      if (scenario !== "unsettled") {
        prior.recordEffect("push", { headCommit: publishedHead });
        prior.complete({
          requestId: row.request_id,
          status: "published",
          url: "https://github.com/example/handoff-fixture/pull/1",
          repository: prRepository,
          branch: repository.branch,
          headCommit: publishedHead,
        });
      }
      if (scenario === "foreign head") {
        git(bare, "update-ref", "refs/heads/" + repository.branch, baseCommit);
      }
      const pushes: Array<{ code: number | null; stderr: string }> = [];
      let currentOwner = true;
      let createdBase: string | undefined;
      const result = (value: unknown) => ({
        code: 0,
        signal: null,
        killed: false,
        stdout: Buffer.from(JSON.stringify(value)),
        stderr: Buffer.alloc(0),
      });
      mocked.run.mockImplementation(
        async (argv: string[], options: Parameters<typeof actual.runCommandBuffered>[1]) => {
          if (argv[0] === "gh") {
            if (argv.includes("POST") && argv.some((x) => x.endsWith("/pulls"))) {
              expect(argv).toContain(`repos/${prRepository}/pulls`);
              createdBase = JSON.parse(String(options?.input)).base;
              return result({ html_url: "https://github.com/example/handoff-fixture/pull/2" });
            }
            if (argv.includes("state=all")) {
              return result([]);
            }
            if (argv.some((x) => x.includes(`/git/ref/heads/${baseBranch}`))) {
              return result({ ref: `refs/heads/${baseBranch}`, sha: baseCommit });
            }
            if (argv.includes("repos/example/handoff-fixture")) {
              return result({
                fork: scenario === "fork",
                default_branch: "main",
                parent: {
                  name: "handoff-fixture",
                  default_branch: "main",
                  owner: { login: "upstream" },
                },
              });
            }
            throw new Error("Unexpected synthetic GitHub API request: " + argv.join(" "));
          }
          const mapped = argv.map((x) => (x === url ? bare : x));
          const answer = await actual.runCommandBuffered(mapped, options);
          if (argv.includes("push")) {
            pushes.push({ code: answer.code, stderr: answer.stderr.toString() });
          }
          return answer;
        },
      );
      mocked.timed.mockImplementation(
        (argv: string[], options: Parameters<typeof actual.runCommandWithTimeout>[1]) =>
          actual.runCommandWithTimeout(
            argv.map((x) => (x === url ? bare : x)),
            options,
          ),
      );
      const move = () =>
        materializeSessionRepositoryWorkspaceOnGateway({
          ...scope,
          cfg,
          sessionId,
          assertCurrent: () => {
            if (!currentOwner) {
              throw new Error("move revoked");
            }
          },
        });
      if (scenario === "unsettled" || scenario === "foreign head") {
        await expect(move()).rejects.toThrow(
          scenario === "unsettled" ? "awaiting a GitHub effect" : "differs from its recorded push",
        );
        expect(loadSessionEntry(scope)?.repositoryWorkspaceId).toBe(repository.workspaceId);
        expect(managedWorktrees.findLiveByOwner("session", scope.sessionKey)).toBeUndefined();
        if (scenario === "foreign head") {
          return;
        }
        prior.recordEffect("push", { headCommit: publishedHead });
        prior.complete({
          requestId: row.request_id,
          status: "published",
          url: "https://github.com/example/handoff-fixture/pull/1",
          repository: prRepository,
          branch: repository.branch,
          headCommit: publishedHead,
        });
      }
      if (scenario === "revoked") {
        const transport = mocked.run.getMockImplementation()!;
        mocked.run.mockImplementation(async (argv: string[], options: unknown) => {
          const observed = await transport(argv, options);
          if (argv.includes("reset")) {
            currentOwner = false;
          }
          return observed;
        });
        await expect(move()).rejects.toThrow("move revoked");
        expect(loadSessionEntry(scope)?.repositoryWorkspaceId).toBe(repository.workspaceId);
        expect(managedWorktrees.findLiveByOwner("session", scope.sessionKey)).toBeUndefined();
        expect(await fs.readFile(path.join(source, "file.txt"), "utf8")).toBe("base\n");
        return;
      }
      await move();
      expect(() => assertReceiptOwner(row)).toThrow();
      expect(readRepositoryGitHubPublication(row.request_id)?.pushed_head_commit).toBe(
        publishedHead,
      );
      const worktree = managedWorktrees.findLiveByOwner("session", scope.sessionKey)!;
      const moveHead = git(worktree.path, "rev-parse", "HEAD");
      if (scenario === "shifted membership") {
        expect(await fs.readFile(path.join(worktree.path, "published-only.ignored"), "utf8")).toBe(
          "cloud publication only\n",
        );
        expect(git(worktree.path, "ls-files", "--", "published-only.ignored")).toBe("");
        expect(git(worktree.path, "ls-files", "--", "restored.ignored")).toBe("restored.ignored");
      }
      const creationBase = git(
        worktree.path,
        "reflog",
        "show",
        "--format=%H",
        "refs/heads/" + worktree.branch,
      )
        .split("\n")
        .at(-1);
      const identity = {
        source: "system-configured" as const,
        profileId: "ghp_11111111111111111111111111111111",
        account: { accountId: 42, login: "proof", avatarUrl: null },
        env,
      };
      ensureGitHubPublicationStore();
      const requestId = "local-publication";
      runOpenClawStateWriteTransaction(({ db }) =>
        insertGitHubPublicationRequest(db, {
          request: { ...scope, idempotencyKey: "local", title: "Continue" },
          requestId,
          requestDigest: createHash("sha256").update("local").digest("hex"),
          sessionId,
          lifecycleRevision,
          now: Date.now(),
          worktree,
          identity,
        }),
      );
      const initial = claimGitHubPublicationExecution(requestId, "local-instance");
      const execution = createGitHubPublicationExecutionStore("local-instance");
      const published = await executeGitHubPublication({
        initial,
        ...execution,
        identity: { prepare: async () => identity, isCurrent: () => true },
        validateAuthority: () => true,
        projectResult: projectGitHubPublicationResult,
      });
      const localHead = git(worktree.path, "rev-parse", "HEAD");
      const receipt = {
        baseCommit,
        publishedHead,
        moveHead,
        creationBase,
        branch: worktree.branch,
        localHead,
        localParent: git(worktree.path, "rev-parse", "HEAD^"),
        remoteHead: git(bare, "rev-parse", "refs/heads/" + worktree.branch),
        published,
        pushes,
        localBinding: loadSessionEntry(scope)?.repositoryWorkspaceId ?? null,
      };

      expect(published).toMatchObject({ status: "published", repository: prRepository });
      expect(createdBase).toBe(baseBranch);
      expect(worktree.baseRef).toBe(baseBranch);
      expect(git(source, "rev-parse", "HEAD")).toBe(baseCommit);
      expect(git(worktree.path, "show", "HEAD:later.txt")).toBe("accepted after publication");
      if (scenario === "shifted membership") {
        expect(git(worktree.path, "show", "HEAD:restored.ignored")).toBe("original accepted");
        expect(
          git(worktree.path, "ls-tree", "--name-only", "HEAD", "--", "published-only.ignored"),
        ).toBe("");
      }
      expect(moveHead).toBe(publishedHead);
      expect(creationBase).toBe(baseCommit);
      expect(receipt.localParent).toBe(publishedHead);
      expect(receipt.remoteHead).toBe(localHead);
      expect(await fs.readFile(path.join(worktree.path, "later.txt"), "utf8")).toBe(
        "accepted after publication\n",
      );
    });
  },
  120000,
);
it("can hold publisher exclusion during an existing reclaim claim without taking repository admission", async () => {
  await withOpenClawTestState({ label: "handoff-exclusion" }, async () => {
    const { createWorkerSessionPlacementStore } =
      await import("./worker-environments/placement-store.js");
    const { seedActivePlacement, REQUEST } =
      await import("./worker-environments/placement-dispatch-test-fixtures.js");
    const { placementTurnOwner } = await import("./worker-environments/placement-record.js");
    const placements = createWorkerSessionPlacementStore({ database: openOpenClawStateDatabase() });
    const active = seedActivePlacement(placements, {
      environmentId: "handoff-worker",
      ownerEpoch: 1,
    });
    const draining = placements.startDrain({
      sessionId: REQUEST.sessionId,
      environmentId: "handoff-worker",
      ownerEpoch: 1,
      expectedGeneration: active.generation,
    });
    if (draining.state !== "draining") {
      throw new Error(`Expected draining placement, received ${draining.state}`);
    }
    const claim = placements.claimReclaimWorkspaceResult({
      sessionId: REQUEST.sessionId,
      sessionKey: REQUEST.sessionKey,
      agentId: "main",
      claimId: "reclaim-handoff-claim",
      runId: "reclaim-handoff-claim",
      owner: placementTurnOwner(draining),
    });
    let entered = false;
    await placements.withWorkspaceExclusion(REQUEST.sessionId, async (assertOwned) => {
      assertOwned();
      entered = true;
      expect(placements.validateWorkspaceResultClaim(claim)).toBe(true);
      await expect(
        placements.withWorkspaceExclusion(REQUEST.sessionId, async () => {}),
      ).rejects.toThrow();
      assertOwned();
      expect(placements.validateWorkspaceResultClaim(claim)).toBe(true);
    });
    expect(entered).toBe(true);
    expect(placements.validateWorkspaceResultClaim(claim)).toBe(true);
  });
});
