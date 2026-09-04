import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { acquireWorktreeRunLease } from "../agents/worktrees/run-lease.js";
import {
  deleteSessionEntryLifecycle,
  resetSessionEntryLifecycle,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createDeferredCore } from "../shared/deferred.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.js";
import { ensurePersonalGitHubPublicationSchema } from "../state/openclaw-state-db-schema-additive.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import {
  disconnectUserGitHubConnection,
  readUserGitHubConnection,
  updateUserGitHubConnection,
} from "../state/user-github-connections.js";
import { linkEmail } from "../state/user-profiles.js";
import {
  readPersonalGitHubPublication,
  requirePersonalGitHubPublicationConfirmation,
} from "./github-personal-publication-store.js";
import {
  callPersonalPublicationRpc,
  createForeignPublicationSession,
  createPersonalPublicationFixture,
  personalPublicationAccount as account,
} from "./github-personal-publication.test-support.js";
import {
  BRANCH,
  NEW_HEAD,
  OLD_HEAD,
  SESSION_ID,
  SESSION_KEY,
  WORKSPACE_TREE,
  commandCalls,
  commandResult,
  commands,
  createTestGitHubPublicationCoordinator,
  createRealPublicationWorkspace,
  githubPublicationTestMocks,
  installGitHubPublicationTestHarness,
} from "./github-publication.test-support.js";
import { handleGatewayRequest } from "./server-methods.js";
import { preparePersonalGitHubSessionAction } from "./server-methods/github-personal-authorization.js";
import type { GatewayClient, GatewayRequestContext } from "./server-methods/types.js";
import {
  REQUEST,
  seedActivePlacement,
} from "./worker-environments/placement-dispatch-test-fixtures.js";
import { createWorkerSessionPlacementStore } from "./worker-environments/placement-store.js";

const mocks = githubPublicationTestMocks();

const table = "github_personal_publication_requests";

vi.mock("../agents/worktrees/git-lock.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agents/worktrees/git-lock.js")>()),
  lockWorktreeForProcess: vi.fn(async () => undefined),
  unlockWorktree: vi.fn(async () => undefined),
}));
vi.mock("../process/exec.js", () => ({
  runCommandBuffered: (
    ...args: Parameters<typeof import("../process/exec.js").runCommandBuffered>
  ) => mocks.runCommand(...args),
}));

describe("personal publication authority and recovery", () => {
  installGitHubPublicationTestHarness();
  let owner: string;
  let otherOwner: string;
  let action: ReturnType<typeof preparePersonalGitHubSessionAction>;
  let client: GatewayClient;
  let config: OpenClawConfig;
  let context: GatewayRequestContext;
  let runtime: Awaited<ReturnType<typeof createPersonalPublicationFixture>>["runtime"];
  let generation: string;
  let placements: ReturnType<typeof createWorkerSessionPlacementStore>;
  let coordinator: ReturnType<typeof createTestGitHubPublicationCoordinator>;
  const request = () => ({
    sessionKey: SESSION_KEY,
    idempotencyKey: "personal-publish",
    selection: { source: "personal" as const, generation, account },
  });
  const status = (requestId: string) =>
    coordinator.personalStatus(
      action,
      { sessionKey: SESSION_KEY, agentId: "main", sessionId: SESSION_ID },
      requestId,
    );

  const rpc = (method: string, params?: Record<string, unknown>) =>
    callPersonalPublicationRpc({ client, context, coordinator }, method, params);

  beforeEach(async () => {
    ({
      owner,
      otherOwner,
      generation,
      runtime,
      client,
      config,
      context,
      action,
      placements,
      coordinator,
    } = await createPersonalPublicationFixture());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each(["writer", "reader", "synthetic", "admin-role-ceiling"] as const)(
    "admits only a direct authorized %s publication through the real RPC router",
    async (caller) => {
      if (caller === "reader") {
        client.connect.scopes = ["operator.read"];
      }
      if (caller === "synthetic") {
        client.internal = { syntheticClient: true };
      }
      if (caller === "admin-role-ceiling") {
        client.connect.scopes = ["operator.admin"];
        config.gateway = {
          roles: {
            default: "reader",
            definitions: {
              reader: { scopes: ["operator.read"], agents: ["*"], sessions: { others: "view" } },
            },
          },
        };
      }
      const respond = vi.fn();
      await handleGatewayRequest({
        req: { type: "req", id: "publish", method: "sessions.github.publish", params: request() },
        client,
        context: { ...context, githubPublicationService: coordinator },
        respond,
        isWebchatConnect: () => false,
      });
      expect(respond.mock.calls[0]?.[0]).toBe(caller === "writer");
      if (caller === "writer") {
        expect(respond.mock.calls[0]?.[1]).toMatchObject({
          status: "published",
          publisher: { source: "personal", ...account },
        });
      } else {
        expect(tableExists(openOpenClawStateDatabase().db, table)).toBe(false);
        expect(commands).toEqual([]);
      }
    },
  );

  it.each([
    "unbound-admin",
    "unbound-reader",
    "reader",
    "synthetic",
    "shared-secret-owner",
  ] as const)(
    "serves shared options independently of personal eligibility for %s",
    async (caller) => {
      client.connect.scopes = caller === "unbound-admin" ? ["operator.admin"] : ["operator.read"];
      if (caller.startsWith("unbound")) {
        delete client.authenticatedUserProfile;
      }
      if (caller === "synthetic") {
        client.internal = { syntheticClient: true };
      }
      if (caller === "shared-secret-owner") {
        delete client.authenticatedUserId;
        client.internal = { operatorRoleActor: { kind: "system" } };
      }
      const response = await rpc("sessions.github.options");
      expect(response[0]).toBe(true);
      expect(response[1]).toMatchObject({
        shared: { source: "system-configured", accountId: 42, login: "roboclaw-bot" },
        personal:
          caller === "reader" || caller === "shared-secret-owner"
            ? { state: "connected", generation, account }
            : null,
        pendingPersonal: null,
      });
      expect(tableExists(openOpenClawStateDatabase().db, table)).toBe(false);
    },
  );

  it.each(["hidden", "sync-failed", "stale", "demoted"] as const)(
    "does not disguise %s options authorization as absent personal identity",
    async (change) => {
      if (change === "hidden") {
        await createForeignPublicationSession(otherOwner);
      }
      if (change === "sync-failed") {
        delete client.authenticatedUserProfile;
        client.authenticatedGitHubIdentitySync = async () => {
          throw new Error("verification unavailable");
        };
      }
      mocks.prepareIdentity.mockImplementationOnce(async () => {
        if (change === "stale") {
          runtime.live = false;
        }
        if (change === "demoted") {
          config.gateway = {
            roles: {
              default: "blocked",
              definitions: {
                blocked: { scopes: [], agents: [], sessions: { others: "none" } },
              },
            },
          };
        }
        return { source: "system-configured", account: { accountId: 42, login: "roboclaw-bot" } };
      });
      expect((await rpc("sessions.github.options"))[0]).toBe(false);
      expect(tableExists(openOpenClawStateDatabase().db, table)).toBe(false);
    },
  );

  it.each(["admin-draft", "admin-private", "writer", "demoted"] as const)(
    "uses current session mutation rights for a personal %s publisher",
    async (caller) => {
      await createForeignPublicationSession(otherOwner, caller === "admin-private");
      client.connect.scopes = caller === "writer" ? ["operator.write"] : ["operator.admin"];
      config.gateway = {
        roles: {
          default: "admin",
          definitions: {
            admin: {
              scopes: ["operator.admin"],
              agents: [],
              sandbox: "required",
              sessions: { others: "none" },
            },
            writer: { scopes: ["operator.write"], agents: "*", sessions: { others: "write" } },
          },
        },
      };
      if (caller === "writer") {
        config.gateway.roles!.default = "writer";
      }
      if (caller === "demoted") {
        mocks.refreshIdentity.mockImplementationOnce(async () => {
          config.gateway!.roles!.default = "writer";
        });
      }
      const response = await rpc("sessions.github.publish", request());
      expect(response[0], JSON.stringify(response[2])).toBe(caller.startsWith("admin"));
      if (caller === "demoted") {
        expect(mocks.refreshIdentity).toHaveBeenCalledOnce();
      }
      expect(client.connect.scopes).toEqual(
        caller === "writer" ? ["operator.write"] : ["operator.admin"],
      );
      if (!caller.startsWith("admin")) {
        expect(commands.some((argv) => argv.includes("push"))).toBe(false);
      }
    },
  );

  it("makes an accepted pre-claim stop discoverable without a previous browser request ID", async () => {
    runtime.verifiedAccount = { accountId: account.accountId, login: "renamed-alice" };
    await expect(coordinator.requestPersonalForSession(request(), action)).rejects.toThrow(
      "identity changed",
    );
    const row = openOpenClawStateDatabase()
      .db.prepare(`SELECT request_id, status, execution_id FROM ${table}`)
      .get() as { request_id: string; status: string; execution_id: null };
    expect(row).toMatchObject({ status: "requested", execution_id: null });
    expect(status(row.request_id)).toMatchObject({
      result: { status: "failed", code: "identity_changed" },
      confirmation: null,
    });
    const response = await rpc("sessions.github.options");
    expect(response[0]).toBe(true);
    expect(response[1].pendingPersonal).toMatchObject({ result: { requestId: row.request_id } });
    expect(commands.some((argv) => argv.includes("push"))).toBe(false);
  });

  it("exposes a stopped pre-claim admission for explicit confirmation and reports only a live execution as publishing", async () => {
    const controller = new AbortController();
    const db = openOpenClawStateDatabase().db;
    ensurePersonalGitHubPublicationSchema(db);
    db.function("stop_personal_admission", () => {
      controller.abort();
      return 1;
    });
    db.exec(`CREATE TEMP TRIGGER stop_personal_admission AFTER INSERT ON ${table}
      BEGIN SELECT stop_personal_admission(); END`);
    const stopped = preparePersonalGitHubSessionAction(
      { client, context, signal: controller.signal },
      SESSION_KEY,
    );
    await expect(coordinator.requestPersonalForSession(request(), stopped)).rejects.toThrow(
      "current",
    );
    db.exec("DROP TRIGGER stop_personal_admission");
    const discovered = (await rpc("sessions.github.options"))[1].pendingPersonal;
    expect(discovered).toMatchObject({
      result: { status: "needs_confirmation" },
      confirmation: { generation, account },
    });
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const fallback = mocks.runCommand.getMockImplementation()!;
    mocks.runCommand.mockImplementation(async (argv: string[], options?: { input?: string }) => {
      if (argv.includes("push")) {
        entered.resolve();
        await release.promise;
      }
      return await fallback(argv, options);
    });
    const pending = rpc("sessions.github.confirm", {
      sessionKey: SESSION_KEY,
      requestId: discovered.result.requestId,
      generation,
      account,
      requestDigest: discovered.confirmation.requestDigest,
    });
    await Promise.race([entered.promise, pending]);
    try {
      expect((await rpc("sessions.github.options"))[1].pendingPersonal).toMatchObject({
        result: { requestId: discovered.result.requestId, status: "publishing" },
        confirmation: null,
      });
    } finally {
      release.resolve();
    }
    expect((await pending)[1]).toMatchObject({
      status: "published",
      requestId: discovered.result.requestId,
    });
    expect((await rpc("sessions.github.options"))[1].pendingPersonal).toBeNull();
  });

  it("creates its private table only on admission, publishes the exact account and snapshot, and replays only for its owner", async () => {
    const db = openOpenClawStateDatabase().db;
    expect(tableExists(db, table)).toBe(false);
    expect(() => status(randomUUID())).toThrow("not found");
    expect(tableExists(db, table)).toBe(false);
    const result = await coordinator.requestPersonalForSession(request(), action);
    expect(result).toMatchObject({
      status: "published",
      publisher: { source: "personal", ...account },
      headCommit: NEW_HEAD,
      effect: { kind: "pull_request", status: "observed" },
    });
    const receipt = readPersonalGitHubPublication(owner, { requestId: result.requestId });
    expect(receipt).toMatchObject({
      owner_profile_id: owner,
      connection_generation: generation,
      source_head_commit: OLD_HEAD,
      source_index_tree: WORKSPACE_TREE,
      workspace_tree: WORKSPACE_TREE,
      push_repository: "openclaw/openclaw",
      repository: "openclaw/openclaw",
      branch: BRANCH,
    });
    expect(JSON.stringify(receipt)).not.toMatch(/synthetic|GH_CONFIG_DIR|claim_id|run_id/);
    expect(
      readPersonalGitHubPublication(otherOwner, { requestId: result.requestId }),
    ).toBeUndefined();
    expect(() =>
      coordinator.personalStatus(
        { owner: otherOwner, assertCurrent: () => {} },
        { sessionKey: SESSION_KEY, agentId: "main", sessionId: SESSION_ID },
        result.requestId,
      ),
    ).toThrow("not found");
    const count = commands.length;
    closeOpenClawStateDatabaseForTest();
    coordinator = createTestGitHubPublicationCoordinator({
      placements: createWorkerSessionPlacementStore({ database: openOpenClawStateDatabase() }),
    });
    await expect(coordinator.requestPersonalForSession(request(), action)).resolves.toEqual(result);
    expect(commands).toHaveLength(count);
    expect(openOpenClawStateDatabase().db.prepare("PRAGMA integrity_check").get()).toEqual({
      integrity_check: "ok",
    });
  });

  it("keeps credential locations out of publication errors when refresh materialization fails", async () => {
    mocks.refreshIdentity.mockRejectedValueOnce(
      new Error("failed to replace /private/credentials/github/personal/synthetic/hosts.yml"),
    );
    await expect(coordinator.requestPersonalForSession(request(), action)).rejects.toThrow(
      "My GitHub credentials are unavailable; reconnect My GitHub before publishing.",
    );
    expect(tableExists(openOpenClawStateDatabase().db, table)).toBe(false);
  });

  it.each(["turn", "remote", "reconciliation"] as const)(
    "rejects %s work without creating a deferred personal request",
    async (state) => {
      let selectedAction = action;
      if (state === "turn") {
        placements.claimTurn({
          ...action,
          claimId: "busy",
          runId: "busy-run",
          owner: { kind: "local" },
        });
      }
      if (state === "remote" || state === "reconciliation") {
        const active = seedActivePlacement(placements, { environmentId: "remote", ownerEpoch: 1 });
        selectedAction = { ...action, sessionId: active.sessionId, sessionKey: REQUEST.sessionKey };
        if (state === "reconciliation") {
          const claim = placements.claimTurn({
            ...active,
            claimId: "pending",
            runId: "pending-run",
            owner: { kind: "worker", environmentId: "remote", ownerEpoch: 1 },
          });
          placements.markWorkspaceResultPending(claim);
        }
      }
      await expect(
        coordinator.requestPersonalForSession(request(), selectedAction),
      ).rejects.toThrow(/idle local|reconciling/);
      expect(tableExists(openOpenClawStateDatabase().db, table)).toBe(false);
      expect(commands).toEqual([]);
    },
  );

  it("holds both session admission and physical-worktree exclusion until publication releases", async () => {
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const fallback = mocks.resolveRepository.getMockImplementation()!;
    mocks.resolveRepository.mockImplementationOnce(async (...args: unknown[]) => {
      entered.resolve();
      await release.promise;
      return await fallback(...args);
    });
    const pending = coordinator.requestPersonalForSession(request(), action);
    await Promise.race([entered.promise, pending]);
    try {
      expect(() =>
        placements.claimTurn({
          ...action,
          claimId: "later",
          runId: "later-run",
          owner: { kind: "local" },
        }),
      ).toThrow("being published");
      await expect(acquireWorktreeRunLease("worktree-1")).rejects.toThrow("in use");
      await expect(
        coordinator.requestPersonalForSession(
          { ...request(), idempotencyKey: "competitor" },
          action,
        ),
      ).rejects.toThrow(/lease|exclusion/);
      await expect(
        coordinator.requestForSession({
          sessionKey: SESSION_KEY,
          agentId: "main",
          idempotencyKey: "shared-competitor",
        }),
      ).rejects.toThrow(/lease|exclusion/);
    } finally {
      release.resolve();
    }
    await expect(pending).resolves.toMatchObject({ status: "published" });
    const claim = placements.claimTurn({
      ...action,
      claimId: "after",
      runId: "after-run",
      owner: { kind: "local" },
    });
    placements.releaseTurn(claim);
  });

  it.each(["socket", "scope", "disconnect", "reconnect", "merge", "session"] as const)(
    "fences %s changes immediately before push",
    async (race) => {
      const fallback = mocks.runCommand.getMockImplementation()!;
      mocks.runCommand.mockImplementation(async (argv: string[], options?: { input?: string }) => {
        if (argv.includes("ls-remote")) {
          if (race === "socket") {
            runtime.live = false;
          }
          if (race === "scope") {
            client.connect.scopes = ["operator.read"];
          }
          if (race === "disconnect") {
            disconnectUserGitHubConnection(owner, () => {});
          }
          if (race === "reconnect") {
            updateUserGitHubConnection(
              owner,
              (current) => ({ ...current!, generation: randomUUID() }),
              () => {},
            );
          }
          if (race === "merge") {
            linkEmail("alice@example.test", otherOwner);
          }
          if (race === "session") {
            const original = mocks.loadSession.getMockImplementation()!;
            mocks.loadSession.mockImplementation((key: string) => ({
              ...original(key),
              entry: { sessionId: "reset-session" },
            }));
          }
        }
        return await fallback(argv, options);
      });
      await expect(coordinator.requestPersonalForSession(request(), action)).rejects.toThrow();
      expect(commands.some((argv) => argv.includes("push") || argv.includes("POST"))).toBe(false);
      expect(openOpenClawStateDatabase().db.prepare(`SELECT status FROM ${table}`).get()).toEqual({
        status: "needs_confirmation",
      });
    },
  );

  it("records an observed push after disconnect without authorizing a PR or claiming the effect was undone", async () => {
    const fallback = mocks.runCommand.getMockImplementation()!;
    mocks.runCommand.mockImplementation(async (argv: string[], options?: { input?: string }) => {
      const result = await fallback(argv, options);
      if (argv.includes("push")) {
        disconnectUserGitHubConnection(owner, () => {});
      }
      return result;
    });
    await expect(coordinator.requestPersonalForSession(request(), action)).rejects.toThrow(
      "identity changed",
    );
    const row = openOpenClawStateDatabase().db.prepare(`SELECT request_id FROM ${table}`).get() as {
      request_id: string;
    };
    expect(status(row.request_id).result).toMatchObject({
      status: "failed",
      code: "identity_changed",
      publisher: { source: "personal", ...account },
      effect: { kind: "push", status: "observed", headCommit: NEW_HEAD },
    });
    await expect(
      coordinator.confirmPersonal(
        {
          sessionKey: SESSION_KEY,
          requestId: row.request_id,
          generation,
          account,
          requestDigest: readPersonalGitHubPublication(owner, { requestId: row.request_id })!
            .request_digest,
        },
        action,
      ),
    ).rejects.toThrow("identity changed");
    expect(commands.some((argv) => argv.includes("POST"))).toBe(false);
  });

  it("requires same-owner confirmation after a lost PR response and restart, observing markers instead of duplicating effects", async () => {
    const fallback = mocks.runCommand.getMockImplementation()!;
    let body = "";
    let interrupted = false;
    let recovering = false;
    mocks.runCommand.mockImplementation(async (argv: string[], options?: { input?: string }) => {
      if (argv.includes("POST")) {
        body = JSON.parse(options?.input ?? "{}").body;
        interrupted = true;
        await fallback(argv, options);
        throw new Error("synthetic response lost");
      }
      const command = argv.join(" ");
      if (recovering && command === "git rev-parse --verify HEAD^{commit}") {
        return commandResult(NEW_HEAD);
      }
      if (recovering && command === "git show -s --format=%B HEAD") {
        const row = openOpenClawStateDatabase()
          .db.prepare(`SELECT request_id FROM ${table}`)
          .get() as { request_id: string };
        return commandResult(`OpenClaw-Publication: ${row.request_id}`);
      }
      if (recovering && argv.includes("state=all")) {
        return commandResult(
          JSON.stringify([
            {
              url: "https://github.com/openclaw/openclaw/pull/125200",
              userId: account.accountId,
              state: "open",
              body,
              headSha: NEW_HEAD,
              headRef: BRANCH,
              baseRef: "main",
            },
          ]),
        );
      }
      return await fallback(argv, options);
    });
    const result = await coordinator.requestPersonalForSession(request(), action);
    expect(interrupted).toBe(true);
    expect(result).toMatchObject({
      status: "needs_confirmation",
      effect: { kind: "pull_request", status: "dispatched" },
      publisher: { source: "personal", ...account },
    });
    const count = commands.length;
    closeOpenClawStateDatabaseForTest();
    placements = createWorkerSessionPlacementStore({ database: openOpenClawStateDatabase() });
    coordinator = createTestGitHubPublicationCoordinator({ placements });
    requirePersonalGitHubPublicationConfirmation(placements.workspaceResultInstanceId());
    await coordinator.resumeSessionRequests();
    expect(commands).toHaveLength(count);
    client = { ...client, connId: "cold-browser" };
    runtime.client = client;
    const discovered = await rpc("sessions.github.options");
    expect(discovered[0]).toBe(true);
    expect(discovered[1].pendingPersonal).toMatchObject({
      result: { requestId: result.requestId, status: "needs_confirmation" },
      confirmation: {
        account,
        generation,
        repository: "openclaw/openclaw",
        workspaceTree: WORKSPACE_TREE,
      },
    });
    const ownProfile = client.authenticatedUserProfile!;
    client.authenticatedUserProfile = { ...ownProfile, profileId: otherOwner };
    client.connect.scopes = ["operator.admin"];
    expect((await rpc("sessions.github.options"))[1].pendingPersonal).toBeNull();
    expect(
      (
        await rpc("sessions.github.status", {
          sessionKey: SESSION_KEY,
          requestId: result.requestId,
        })
      )[0],
    ).toBe(false);
    expect(
      (
        await rpc("sessions.github.confirm", {
          sessionKey: SESSION_KEY,
          requestId: result.requestId,
          generation,
          account,
          requestDigest: discovered[1].pendingPersonal.confirmation.requestDigest,
        })
      )[0],
    ).toBe(false);
    expect((await rpc("sessions.github.publish", request()))[0]).toBe(false);
    client.authenticatedUserProfile = ownProfile;
    action = preparePersonalGitHubSessionAction({ client, context }, SESSION_KEY);
    const confirm = {
      sessionKey: SESSION_KEY,
      requestId: discovered[1].pendingPersonal.result.requestId,
      generation: discovered[1].pendingPersonal.confirmation.generation,
      account: discovered[1].pendingPersonal.confirmation.account,
      requestDigest: discovered[1].pendingPersonal.confirmation.requestDigest,
    };

    expect(confirm).toMatchObject({ generation, account });
    await expect(
      coordinator.confirmPersonal(confirm, { ...action, owner: otherOwner }),
    ).rejects.toThrow("original request");
    const originalSession = mocks.loadSession.getMockImplementation()!;
    mocks.loadSession.mockImplementation((key: string) => ({
      ...originalSession(key),
      entry: { sessionId: "reset-incarnation" },
    }));
    expect((await rpc("sessions.github.options"))[1].pendingPersonal).toMatchObject({
      result: { status: "failed", code: "session_changed", requestId: result.requestId },
      confirmation: null,
    });
    expect((await rpc("sessions.github.confirm", confirm))[0]).toBe(false);
    mocks.loadSession.mockImplementation(originalSession);
    recovering = true;
    const confirmed = await rpc("sessions.github.confirm", confirm);
    expect(confirmed[0], JSON.stringify(confirmed[2])).toBe(true);
    expect(confirmed[1]).toMatchObject({
      status: "published",
      publisher: { source: "personal", ...account },
    });
    expect(commands.filter((argv) => argv.includes("commit-tree"))).toHaveLength(1);
    expect(commands.filter((argv) => argv.includes("push"))).toHaveLength(1);
    expect(commands.filter((argv) => argv.includes("POST"))).toHaveLength(1);
    expect(commandCalls.find((call) => call.argv.includes("commit-tree"))?.input).toContain(
      "Co-authored-by: alice",
    );
  });

  it.each([
    ["worktree", "push"],
    ["index", "observe"],
    ["head", "push"],
    ["branch", "push"],
    ["worktree-owner", "push"],
    ["repository", "push"],
  ] as const)(
    "records authoritative %s drift on confirmation as the original terminal failure",
    async (drift, interruption) => {
      const workspace = await createRealPublicationWorkspace(interruption);
      const initial = await rpc("sessions.github.publish", request());
      expect(initial[0], JSON.stringify(initial[2])).toBe(true);
      const interrupted = initial[1];
      expect(interrupted.status).toBe("needs_confirmation");
      const facts = status(interrupted.requestId).confirmation!;
      const confirm = {
        sessionKey: SESSION_KEY,
        requestId: interrupted.requestId,
        generation,
        account,
        requestDigest: facts.requestDigest,
      };
      if (drift === "worktree") {
        await fs.writeFile(path.join(workspace.cwd, "artifact.txt"), "changed worktree\n");
      }
      if (drift === "index") {
        await fs.writeFile(path.join(workspace.cwd, "artifact.txt"), "changed index\n");
        await workspace.git("add", "artifact.txt");
        await fs.writeFile(path.join(workspace.cwd, "artifact.txt"), "accepted\n");
      }
      if (drift === "head") {
        await workspace.git("commit", "--allow-empty", "-m", "later commit");
      }
      if (drift === "branch") {
        await workspace.git("checkout", "-b", "other-branch");
      }
      const commandBefore = mocks.runCommand.getMockImplementation()!;
      const worktreeBefore = mocks.findWorktree("session", SESSION_KEY);
      if (drift === "worktree-owner") {
        mocks.findWorktree.mockReturnValue({
          ...worktreeBefore,
          repoFingerprint: "replaced-repository",
        });
      }
      if (drift === "repository") {
        mocks.runCommand.mockImplementation(async (argv: string[], options?: { input?: string }) =>
          argv[0] === "gh" && argv.some((arg) => arg.startsWith("{fork,"))
            ? commandResult(
                JSON.stringify({
                  fork: true,
                  parent: { owner: { login: "other" }, name: "repository", default_branch: "main" },
                }),
              )
            : await commandBefore(argv, options),
        );
      }
      const effectsBefore = [...workspace.effects];
      expect(
        (await rpc("sessions.github.confirm", { ...confirm, generation: randomUUID() }))[0],
      ).toBe(false);
      const confirmed = await rpc("sessions.github.confirm", confirm);
      expect(confirmed[0], JSON.stringify(confirmed[2])).toBe(true);
      expect(confirmed[1]).toMatchObject({
        requestId: interrupted.requestId,
        status: "failed",
        code: "workspace_changed",
        publisher: interrupted.publisher,
        effect: interrupted.effect,
        nextAction: expect.stringContaining("new publication"),
      });
      expect(workspace.effects).toEqual(effectsBefore);
      expect(status(interrupted.requestId)).toEqual({ result: confirmed[1], confirmation: null });
      expect((await rpc("sessions.github.options"))[1].pendingPersonal).toBeNull();
      expect((await rpc("sessions.github.confirm", confirm))[1]).toEqual(confirmed[1]);
      if (drift === "branch") {
        await workspace.git("checkout", BRANCH);
      }
      mocks.findWorktree.mockReturnValue(worktreeBefore);
      mocks.runCommand.mockImplementation(commandBefore);
      const fresh = await rpc("sessions.github.publish", {
        ...request(),
        idempotencyKey: "fresh-reviewed-publication",
      });
      expect(fresh[0], JSON.stringify(fresh[2])).toBe(true);
      expect(fresh[1].status).toBe("published");
      expect(fresh[1].requestId).not.toBe(interrupted.requestId);
    },
  );

  it.each(["push", "index"] as const)(
    "recovers an unchanged real marker and %s interruption without replacing the accepted request",
    async (interruption) => {
      const workspace = await createRealPublicationWorkspace(interruption);
      await rpc("sessions.github.publish", request());
      const pending = (await rpc("sessions.github.options"))[1].pendingPersonal;
      expect(pending.result.status).toBe("needs_confirmation");
      const markerHead = await workspace.git("rev-parse", "HEAD");
      const confirmed = await rpc("sessions.github.confirm", {
        sessionKey: SESSION_KEY,
        requestId: pending.result.requestId,
        generation,
        account,
        requestDigest: pending.confirmation.requestDigest,
      });
      expect(confirmed[0], JSON.stringify(confirmed[2])).toBe(true);
      expect(confirmed[1]).toMatchObject({
        status: "published",
        requestId: pending.result.requestId,
        headCommit: markerHead,
      });
      expect(await workspace.git("rev-parse", "HEAD")).toBe(markerHead);
      expect(await workspace.git("write-tree")).toBe(pending.confirmation.workspaceTree);
      expect(workspace.effects).toEqual(["push", "pull_request"]);
      await expect(fs.stat(path.join(workspace.cwd, ".git", "index.lock"))).rejects.toThrow();
    },
  );

  it.each(["snapshot", "remote", "malformed", "timeout"] as const)(
    "keeps failed %s observation reconfirmable with its dispatched effect intact",
    async (observation) => {
      const workspace = await createRealPublicationWorkspace("push");
      await rpc("sessions.github.publish", request());
      const pending = (await rpc("sessions.github.options"))[1].pendingPersonal;
      const local = mocks.runCommand.getMockImplementation()!;
      mocks.runCommand.mockImplementation(
        async (argv: string[], options?: { env?: NodeJS.ProcessEnv }) => {
          if (argv.includes("state=all")) {
            if (observation === "malformed") {
              return commandResult("[{}");
            }
            if (observation === "timeout") {
              throw new Error("synthetic remote timeout");
            }
          }
          return (observation === "snapshot" &&
            argv.includes("write-tree") &&
            options?.env?.GIT_INDEX_FILE) ||
            (observation === "remote" && argv.includes("state=all"))
            ? commandResult("", 1)
            : await local(argv, options);
        },
      );
      const confirmed = await rpc("sessions.github.confirm", {
        sessionKey: SESSION_KEY,
        requestId: pending.result.requestId,
        generation,
        account,
        requestDigest: pending.confirmation.requestDigest,
      });
      if (observation === "snapshot") {
        expect(confirmed[0]).toBe(false);
      } else {
        expect(confirmed[1]).toMatchObject({
          status: "needs_confirmation",
          effect: pending.result.effect,
        });
      }
      expect(status(pending.result.requestId)).toEqual(pending);
      expect(workspace.effects).toEqual(["push"]);
    },
  );

  it("keeps confirmation recoverable when authority changes during a real snapshot and refuses competing execution", async () => {
    const workspace = await createRealPublicationWorkspace("push");
    await rpc("sessions.github.publish", request());
    const pending = (await rpc("sessions.github.options"))[1].pendingPersonal;
    const confirm = {
      sessionKey: SESSION_KEY,
      requestId: pending.result.requestId,
      generation,
      account,
      requestDigest: pending.confirmation.requestDigest,
    };
    await fs.writeFile(path.join(workspace.cwd, "artifact.txt"), "changed before revocation\n");
    let snapshotEntered = false;
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const local = mocks.runCommand.getMockImplementation()!;
    mocks.runCommand.mockImplementation(
      async (argv: string[], options?: { env?: NodeJS.ProcessEnv }) => {
        const result = await local(argv, options);
        if (argv.includes("write-tree") && options?.env?.GIT_INDEX_FILE) {
          snapshotEntered = true;
          entered.resolve();
          await release.promise;
        }
        return result;
      },
    );
    const confirming = rpc("sessions.github.confirm", confirm);
    await Promise.race([entered.promise, confirming]);
    expect(snapshotEntered).toBe(true);
    try {
      expect((await rpc("sessions.github.confirm", confirm))[0]).toBe(false);
      client.connect.scopes = ["operator.read"];
    } finally {
      release.resolve();
    }
    expect((await confirming)[0]).toBe(false);
    expect(readPersonalGitHubPublication(owner, { requestId: confirm.requestId })?.status).toBe(
      "needs_confirmation",
    );
    expect(workspace.effects).toEqual(["push"]);
  });

  it("fails closed on corrupt owner binding rather than replaying the other user's result", async () => {
    const result = await coordinator.requestPersonalForSession(request(), action);
    openOpenClawStateDatabase()
      .db.prepare(`UPDATE ${table} SET owner_profile_id = ? WHERE request_id = ?`)
      .run(otherOwner, result.requestId);
    expect(readPersonalGitHubPublication(owner, { requestId: result.requestId })).toBeUndefined();
    expect(() =>
      readPersonalGitHubPublication(otherOwner, { requestId: result.requestId }),
    ).toThrow("corrupt");
    expect(readUserGitHubConnection(owner)?.generation).toBe(generation);
  });

  it("retains logical-session receipts across archive and reset, then removes them through permanent deletion", async () => {
    const result = await coordinator.requestPersonalForSession(request(), action);
    const scope = { agentId: "main", sessionKey: SESSION_KEY };
    await upsertSessionEntryCore(scope, {
      sessionId: SESSION_ID,
      updatedAt: Date.now(),
      archivedAt: Date.now(),
    });
    expect(readPersonalGitHubPublication(owner, { requestId: result.requestId })?.status).toBe(
      "published",
    );
    const storePath = resolveOpenClawAgentSqlitePath({ agentId: "main" });
    const target = { canonicalKey: SESSION_KEY, storeKeys: [SESSION_KEY] };
    await resetSessionEntryLifecycle({
      agentId: "main",
      storePath,
      target,
      buildNextEntry: () => ({ sessionId: "reset-generation", updatedAt: Date.now() }),
    });
    expect(readPersonalGitHubPublication(owner, { requestId: result.requestId })?.session_id).toBe(
      SESSION_ID,
    );
    await deleteSessionEntryLifecycle({
      agentId: "main",
      storePath,
      target,
      archiveTranscript: false,
    });
    expect(readPersonalGitHubPublication(owner, { requestId: result.requestId })).toBeUndefined();
    expect(readUserGitHubConnection(owner)?.generation).toBe(generation);
  });
});
