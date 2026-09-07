import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ErrorCodes, errorShape } from "../../packages/gateway-protocol/src/index.js";
import { persistSubagentSessionTiming } from "../agents/subagents/registry/subagent-registry-helpers.js";
import { managedWorktrees } from "../agents/worktrees/service.js";
import {
  loadSessionEntry,
  loadTranscriptEvents,
  replaceSessionEntrySync,
} from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { onAgentEvent } from "../infra/agent-events.js";
import { withTimeout } from "../infra/fs-safe.js";
import { registerProjectRegistry } from "../projects/project-registry.js";
import {
  getSessionWorkAdmissionRelease,
  SESSION_WORK_ADMISSION_DRAIN_TIMEOUT_MS,
} from "../sessions/session-lifecycle-admission.js";
import { createDeferredCore } from "../shared/deferred.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import { waitForChatAbortControllerRemoval } from "./chat-abort-lifecycle-internal.js";
import type { ChatAbortControllerEntry } from "./chat-abort.js";
import { dispatchInboundMessageMock, testState } from "./test-helpers.js";
import {
  directSessionReq,
  getGatewayConfigModule,
  setupGatewaySessionsHandlerTestHarness,
} from "./test/server-sessions.test-helpers.js";

const { createSessionStoreDir } = setupGatewaySessionsHandlerTestHarness();
const execFileAsync = promisify(execFile);
const parentKey = "agent:main:dashboard:project-parent";
const parentCreateParams = {
  key: parentKey,
  agentId: "main",
  worktree: true,
  worktreeName: "parent",
  worktreeBaseRef: "main",
};
const adminRequest = {
  client: {
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      client: {
        id: GATEWAY_CLIENT_NAMES.CONTROL_UI,
        version: "test",
        platform: "web",
        mode: GATEWAY_CLIENT_MODES.WEBCHAT,
      },
      scopes: ["operator.admin"],
    },
  },
};
let state: Awaited<ReturnType<typeof createOpenClawTestState>>;
let repository: string;
let storePath: string;
let parent: SessionEntry;

type CreatedWorktreeSession = {
  key: string;
  entry: SessionEntry;
  worktree: { id: string; path: string };
};

async function createRepository(name: string): Promise<string> {
  const root = path.join(state.root, name);
  await fs.mkdir(path.join(root, ".openclaw"), { recursive: true });
  await fs.writeFile(path.join(root, "README.md"), `${name}\n`);
  await fs.writeFile(
    path.join(root, ".openclaw", "worktree-setup.sh"),
    "#!/bin/sh\ntouch setup-marker.txt\n",
    { mode: 0o755 },
  );
  await execFileAsync("git", ["init", "-b", "main", root]);
  await execFileAsync("git", ["-C", root, "add", "."]);
  await execFileAsync("git", [
    "-C",
    root,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-m",
    "Initialize fixture",
  ]);
  return await fs.realpath(root);
}

function spawnClient(admin = false) {
  return {
    connect: { scopes: [admin ? "operator.admin" : "operator.write"] },
    internal: {
      syntheticClient: true as const,
      sessionCreation: {
        via: "spawn" as const,
        actor: { type: "agent" as const, id: "main" },
        requesterSessionKey: parentKey,
        inheritedToolPolicy: { version: 1 as const, allow: ["read"], deny: [] },
      },
    },
  };
}

async function createChild(params: Record<string, unknown> = {}, admin = false) {
  return await directSessionReq<CreatedWorktreeSession>(
    "sessions.create",
    {
      agentId: "main",
      label: "Project child",
      parentSessionKey: parentKey,
      spawnDepth: 1,
      worktree: true,
      ...params,
    },
    { client: spawnClient(admin) as never },
  );
}

beforeEach(async () => {
  state = await createOpenClawTestState({ layout: "state-only", prefix: "openclaw-spawn-repo-" });
  const defaultWorkspace = path.join(state.root, "non-git-workspace");
  await fs.mkdir(defaultWorkspace);
  repository = await createRepository("selected-project");
  closeOpenClawStateDatabaseForTest();
  testState.agentConfig = { workspace: defaultWorkspace };
  ({ storePath } = await createSessionStoreDir());
  const created = await directSessionReq<CreatedWorktreeSession>(
    "sessions.create",
    { ...parentCreateParams, cwd: repository },
    adminRequest,
  );
  expect(created.ok, JSON.stringify(created.error)).toBe(true);
  parent = created.payload!.entry;
});

afterEach(async () => {
  vi.restoreAllMocks();
  closeOpenClawStateDatabaseForTest();
  testState.agentConfig = undefined;
  testState.agentsConfig = undefined;
  await state?.cleanup();
});

test("trusted same-agent worktree spawns inherit the parent's selected project", async () => {
  const created = await createChild();
  expect(created.ok, JSON.stringify(created.error)).toBe(true);
  expect(created.payload?.entry.worktree?.repoRoot).toBe(repository);
  expect(created.payload?.entry.parentSessionId).toBe(parent.sessionId);
  expect(created.payload?.worktree.id).not.toBe(parent.worktree?.id);
  const childPath = created.payload!.worktree.path;
  expect(await fs.readFile(path.join(childPath, "README.md"), "utf8")).toBe("selected-project\n");
  await expect(fs.stat(path.join(childPath, "setup-marker.txt"))).rejects.toThrow();
});

test("keyed worktree creation reuses its recorded base after reopening the registry", async () => {
  const params = { ...parentCreateParams, cwd: repository };
  closeOpenClawStateDatabaseForTest();
  const reused = await directSessionReq<CreatedWorktreeSession>(
    "sessions.create",
    params,
    adminRequest,
  );
  expect(reused.ok, JSON.stringify(reused.error)).toBe(true);
  expect(reused.payload?.entry.sessionId).toBe(parent.sessionId);
  expect(reused.payload?.worktree.id).toBe(parent.worktree?.id);
  const recorded = managedWorktrees.findLiveByOwner("session", parentKey);
  expect(recorded?.baseRef).toBe("main");

  for (const changed of [{ worktreeBaseRef: "HEAD" }, { worktreeName: "other-name" }]) {
    const rejected = await directSessionReq(
      "sessions.create",
      { ...params, ...changed },
      adminRequest,
    );
    expect(rejected).toMatchObject({
      ok: false,
      error: { code: "INVALID_REQUEST", message: expect.stringContaining("already bound") },
    });
  }
  const otherRepository = await createRepository("other-replay-project");
  const wrongRepository = await directSessionReq(
    "sessions.create",
    { ...params, cwd: otherRepository },
    adminRequest,
  );
  expect(wrongRepository).toMatchObject({
    ok: false,
    error: { message: "session worktree belongs to a different repository" },
  });
  const foreign = await managedWorktrees.create({
    repoRoot: repository,
    baseRef: "main",
    ownerKind: "manual",
    name: "foreign-owner",
    runSetupScript: false,
  });
  replaceSessionEntrySync(
    { agentId: "main", sessionKey: parentKey, storePath },
    {
      ...parent,
      worktree: { id: foreign.id, branch: foreign.branch, repoRoot: foreign.repoRoot },
    },
  );
  const wrongOwner = await directSessionReq("sessions.create", params, adminRequest);
  expect(wrongOwner).toMatchObject({
    ok: false,
    error: { message: "session worktree binding has a different owner" },
  });
  expect(managedWorktrees.findLiveByOwner("session", parentKey)).toEqual(recorded);
});

test.each(["cwd", "project", "cross-agent"] as const)(
  "trusted worktree spawns preserve %s source selection",
  async (selection) => {
    const otherRepository = await createRepository("other-project");
    let params: Record<string, unknown>;
    if (selection === "project") {
      const project = await registerProjectRegistry({ path: otherRepository });
      params = { projectId: project.id };
    } else if (selection === "cross-agent") {
      testState.agentsConfig = {
        list: [
          { id: "main", default: true },
          { id: "other", workspace: otherRepository },
        ],
      };
      const config = await getGatewayConfigModule();
      config.clearRuntimeConfigSnapshot();
      config.clearConfigCache();
      params = { agentId: "other" };
    } else {
      params = { cwd: otherRepository };
    }
    const created = await createChild(params, selection === "cwd");
    expect(created.ok, JSON.stringify(created.error)).toBe(true);
    expect(created.payload?.entry.worktree?.repoRoot).toBe(otherRepository);
  },
);

test("parent linkage does not authorize an operator's out-of-workspace source", async () => {
  const linked = await directSessionReq(
    "sessions.create",
    { agentId: "main", label: "Operator child", parentSessionKey: parentKey, worktree: true },
    { client: { connect: { scopes: ["operator.write"] } } as never },
  );
  expect(linked).toMatchObject({
    ok: false,
    error: { message: "agent workspace is not a git checkout" },
  });
  const explicit = await createChild({ cwd: repository });
  expect(explicit).toMatchObject({
    ok: false,
    error: { message: "missing scope: operator.admin" },
  });
});

test("trusted worktree spawns reject a stale parent registry binding", async () => {
  replaceSessionEntrySync(
    { agentId: "main", sessionKey: parentKey, storePath },
    { ...parent, worktree: { ...parent.worktree!, id: "another-worktree" } },
  );
  await expect(createChild()).rejects.toThrow("Spawn parent managed worktree changed");
});

test("trusted worktree spawns roll back when the parent changes during preparation", async () => {
  const createWorktree = managedWorktrees.create.bind(managedWorktrees);
  vi.spyOn(managedWorktrees, "create").mockImplementation(async (params) => {
    const created = await createWorktree(params);
    replaceSessionEntrySync(
      { agentId: "main", sessionKey: parentKey, storePath },
      { ...parent, sessionId: "replaced-parent" },
    );
    return created;
  });
  const key = "agent:main:dashboard:retired-parent-child";
  await expect(createChild({ key })).rejects.toThrow("Spawn parent managed worktree changed");
  expect(managedWorktrees.findLiveByOwner("session", key)).toBeUndefined();
  expect(loadSessionEntry({ agentId: "main", sessionKey: key, storePath })).toBeUndefined();
});

test("publishes a failed worktree spawn only after its durable session failure", async () => {
  const key = "agent:main:dashboard:failed-worktree-child";
  const target = { agentId: "main", sessionKey: key, storePath };
  const preparation = createDeferredCore<never>();
  const createWorktree = vi
    .spyOn(managedWorktrees, "create")
    .mockReturnValueOnce(preparation.promise);
  const failure = new Error(
    "git ls-tree -r --format=%(objectsize) c79ad267ba623c1a323f1f6e8b60228bd5a30ce5 -- failed (timed out after 120 seconds; signal SIGTERM):\n4514\n4168\nCheck repository access and disk space.",
  );
  let registryStartedAt = 0;
  let publishedEntry: SessionEntry | undefined;
  let registryProjection: Promise<void> | undefined;
  const context = {
    chatAbortControllers: new Map<string, ChatAbortControllerEntry>(),
    dedupe: new Map(),
    broadcast: vi.fn((event: string, payload: unknown) => {
      if (
        event !== "chat" ||
        !isRecord(payload) ||
        payload.state !== "error" ||
        typeof payload.runId !== "string"
      ) {
        return;
      }
      publishedEntry = loadSessionEntry(target);
      // The completion waiter observes the terminal after the spawn ACK registered
      // its own later start time. Exercise the real registry projection as it settles.
      registryProjection = persistSubagentSessionTiming({
        runId: payload.runId,
        childSessionKey: key,
        requesterSessionKey: parentKey,
        requesterDisplayKey: parentKey,
        task: "Read README.md",
        cleanup: "keep",
        createdAt: registryStartedAt,
        sessionStartedAt: registryStartedAt,
        execution: {
          status: "terminal",
          startedAt: registryStartedAt,
          endedAt: Date.now(),
          outcome: { status: "error", error: String(failure) },
        },
        completion: { required: false },
        delivery: { status: "not_required" },
        endedReason: "subagent-error",
      });
    }),
  };
  const client = spawnClient();
  const created = await directSessionReq<{
    key: string;
    sessionId: string;
    runId: string;
    runStarted: boolean;
  }>(
    "sessions.create",
    {
      key,
      agentId: "main",
      label: "Failed worktree child",
      parentSessionKey: parentKey,
      spawnDepth: 1,
      worktree: true,
      worktreeName: "failed-child",
      task: "Read README.md",
    },
    {
      client: {
        ...client,
        connect: {
          ...client.connect,
          minProtocol: 1,
          maxProtocol: 1,
          client: {
            id: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
            version: "test",
            platform: "node",
            mode: GATEWAY_CLIENT_MODES.BACKEND,
          },
        },
      },
      context,
    },
  );
  expect(created.ok, JSON.stringify(created.error)).toBe(true);
  expect(created.payload?.runStarted).toBe(true);
  const { runId, sessionId } = created.payload!;
  const admittedRun = context.chatAbortControllers.get(runId)!;
  registryStartedAt = Math.max(Date.now(), admittedRun.startedAtMs + 1);
  const released = getSessionWorkAdmissionRelease({ scope: storePath, identities: [key] });
  expect(released).toBeDefined();
  expect(loadSessionEntry(target)?.pendingWorktree?.workspace).toBe(repository);
  await vi.waitFor(() => expect(createWorktree).toHaveBeenCalledOnce());
  preparation.reject(failure);
  await withTimeout(released!, SESSION_WORK_ADMISSION_DRAIN_TIMEOUT_MS, "failed workspace proof");
  await registryProjection;

  expect.soft(publishedEntry).toMatchObject({
    sessionId,
    status: "failed",
    lastRunId: runId,
    lastRunError: expect.stringContaining("git ls-tree"),
  });
  expect.soft(loadSessionEntry(target)).toMatchObject({
    status: "failed",
    lastRunId: runId,
    lastRunError: expect.stringContaining("timed out after 120 seconds"),
  });
  expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
  const notices = (await loadTranscriptEvents({ ...target, sessionId })).filter(
    (event) => isRecord(event) && event.customType === "run-failed-before-reply",
  );
  expect(notices).toMatchObject([
    { details: { runId, error: expect.stringContaining("git ls-tree") }, display: true },
  ]);
  const listed = await directSessionReq<{
    sessions: Array<{ key: string; lastRunError?: string }>;
  }>("sessions.list", { agentId: "main" }, adminRequest);
  expect(listed.ok, JSON.stringify(listed.error)).toBe(true);
  expect(listed.payload?.sessions.find((row) => row.key === key)).toMatchObject({
    lastRunError: expect.stringContaining("git ls-tree"),
  });
});

test.each(["archive", "replace", "rebind", "stale-child"] as const)(
  "deferred worktree preparation follows its child owner after %s",
  async (change) => {
    const { chatHandlers } = await import("./server-methods/chat.js");
    const initialSend = vi
      .spyOn(chatHandlers, "chat.send")
      .mockImplementation(async ({ respond }) => {
        respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, "initial turn unavailable"));
      });
    const key = `agent:main:dashboard:deferred-${change}`;
    const created = await createChild({ key, task: "Read README.md" });
    expect(created.ok, JSON.stringify(created.error)).toBe(true);
    const acceptedChild = loadSessionEntry({ agentId: "main", sessionKey: key, storePath })!;
    expect(acceptedChild.pendingWorktree?.workspace).toBe(repository);
    initialSend.mockRestore();
    const context = {
      broadcast: vi.fn(),
      chatAbortControllers: new Map<string, ChatAbortControllerEntry>(),
      dedupe: new Map(),
    };
    const operator = {
      client: {
        connect: {
          scopes: ["operator.write"],
          client: {
            id: GATEWAY_CLIENT_NAMES.CONTROL_UI,
            version: "dev",
            platform: "web",
            mode: GATEWAY_CLIENT_MODES.WEBCHAT,
          },
        },
      } as never,
      context,
    };
    if (change === "archive") {
      const archived = await directSessionReq(
        "sessions.patch",
        {
          key: parentKey,
          archived: true,
          expectedSessionId: parent.sessionId,
        },
        operator,
      );
      expect(archived.ok, JSON.stringify(archived.error)).toBe(true);
      expect(
        loadSessionEntry({ agentId: "main", sessionKey: parentKey, storePath })?.archivedAt,
      ).toBeDefined();
    } else if (change === "replace" || change === "rebind") {
      replaceSessionEntrySync(
        { agentId: "main", sessionKey: parentKey, storePath },
        {
          ...parent,
          ...(change === "replace"
            ? { sessionId: "replacement-parent" }
            : {
                worktree: { ...parent.worktree!, id: "replacement-parent-worktree" },
              }),
        },
      );
    }
    dispatchInboundMessageMock.mockResolvedValue({
      queuedFinal: false,
      counts: { block: 0, final: 0, tool: 0 },
    });
    const resolveRepository = vi.spyOn(managedWorktrees, "resolveRepositoryPaths");
    const createWorktree = vi.spyOn(managedWorktrees, "create");
    let replaced = false;
    const unsubscribe = onAgentEvent((event) => {
      if (
        change === "stale-child" &&
        !replaced &&
        event.sessionKey === key &&
        event.data.phase === "preparing_workspace"
      ) {
        replaced = true;
        replaceSessionEntrySync(
          { agentId: "main", sessionKey: key, storePath },
          {
            ...acceptedChild,
            sessionId: "replacement-child",
          },
        );
      }
    });
    try {
      const retried = await directSessionReq(
        "chat.send",
        {
          agentId: "main",
          sessionKey: key,
          message: "Continue the accepted task",
          idempotencyKey: `retry-deferred-${change}`,
        },
        operator,
      );
      expect(retried.ok, JSON.stringify(retried.error)).toBe(true);
      const targets = [...context.chatAbortControllers].map(([runId, entry]) => ({ runId, entry }));
      const released = getSessionWorkAdmissionRelease({ scope: storePath, identities: [key] });
      expect(
        await waitForChatAbortControllerRemoval({
          entries: context.chatAbortControllers,
          targets,
          timeoutMs: SESSION_WORK_ADMISSION_DRAIN_TIMEOUT_MS,
        }),
      ).toBe(true);
      if (released) {
        await withTimeout(
          released,
          SESSION_WORK_ADMISSION_DRAIN_TIMEOUT_MS,
          "deferred workspace proof",
        );
      }
      const child = loadSessionEntry({ agentId: "main", sessionKey: key, storePath })!;
      if (change === "stale-child") {
        expect(replaced).toBe(true);
        expect(resolveRepository).not.toHaveBeenCalled();
        expect(createWorktree).not.toHaveBeenCalled();
        expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
        expect(child.sessionId).toBe("replacement-child");
        expect(child.worktree).toBeUndefined();
      } else {
        expect(child.sessionId).toBe(acceptedChild.sessionId);
        expect(child.parentSessionId).toBe(parent.sessionId);
        expect(child.pendingWorktree).toBeUndefined();
        expect(child.worktree?.repoRoot).toBe(repository);
        const owned = managedWorktrees.findLiveByOwner("session", key)!;
        expect(owned.id).toBe(child.worktree?.id);
        expect(await fs.readFile(path.join(owned.path, "README.md"), "utf8")).toBe(
          "selected-project\n",
        );
        await expect(fs.stat(path.join(owned.path, "setup-marker.txt"))).rejects.toThrow();
        expect(dispatchInboundMessageMock).toHaveBeenCalledOnce();
      }
    } finally {
      unsubscribe();
      dispatchInboundMessageMock.mockReset();
    }
  },
);
