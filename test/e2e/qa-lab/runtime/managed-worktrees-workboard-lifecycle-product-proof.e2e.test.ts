// QA Lab product proof for the Workboard-owned managed-worktree lifecycle.
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { createQaLiveLaneGateway } from "../../../../extensions/qa-lab/runtime-api.js";
import type { ManagedWorktreeRecord } from "../../../../src/agents/worktrees/types.js";
import { stopQaGatewayFixture } from "../../../helpers/qa-gateway-cleanup.js";
import { useAutoCleanupTempDirTracker } from "../../../helpers/temp-dir.js";

const execFileAsync = promisify(execFile);

type WorkboardWorkspace = {
  kind: "worktree";
  path: string;
  branch?: string;
  sourcePath?: string;
  sourceBranch?: string;
};
type WorkboardCard = {
  id: string;
  runId?: string;
  status?: string;
  events?: Array<{ kind?: string }>;
  metadata?: {
    automation?: { workspace?: WorkboardWorkspace };
    proof?: Array<{ label?: string; status?: string }>;
    workerProtocol?: { state?: string };
  };
};
type WorkboardCreateResult = { card: WorkboardCard };
type WorkboardCompleteResult = { card: WorkboardCard };
type WorkboardListResult = { cards: WorkboardCard[] };
type WorkboardDispatchResult = {
  started: Array<{ cardId: string; runId: string; sessionKey: string; title: string }>;
  startFailures: Array<{ cardId: string; error: string; title: string }>;
};
type WorktreeListResult = { worktrees: ManagedWorktreeRecord[] };
type GatewayRunResult = { status?: unknown };
type TasksListResult = {
  tasks: Array<{
    kind?: string;
    runtime?: string;
    runId?: string;
    status?: string;
    childSessionKey?: string;
  }>;
};

let gatewayOwner: ReturnType<typeof createQaLiveLaneGateway> | undefined;
let harness: Awaited<ReturnType<ReturnType<typeof createQaLiveLaneGateway>["start"]>> | undefined;

afterEach(async () => {
  if (gatewayOwner) {
    await stopQaGatewayFixture(gatewayOwner);
  }
  harness = undefined;
  gatewayOwner = undefined;
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  return stdout.trimEnd();
}

async function initializeRepository(root: string): Promise<string> {
  const repo = path.join(root, "source");
  const remote = path.join(root, "origin.git");
  await fs.mkdir(repo, { recursive: true });
  await git(repo, "init", "-b", "main");
  await git(repo, "config", "user.name", "OpenClaw Test");
  await git(repo, "config", "user.email", "openclaw-test@example.invalid");
  await fs.writeFile(path.join(repo, "README.md"), "base\n");
  await git(repo, "add", "README.md");
  await git(repo, "commit", "-m", "initialize Workboard worktree fixture");
  await git(root, "init", "--bare", remote);
  await git(repo, "remote", "add", "origin", remote);
  await git(repo, "push", "-u", "origin", "main");
  await git(remote, "symbolic-ref", "HEAD", "refs/heads/main");
  return await fs.realpath(repo);
}

async function startHarness(options: { forcedRuntime?: "codex" } = {}) {
  gatewayOwner = createQaLiveLaneGateway();
  harness = await gatewayOwner.start({
    repoRoot: process.cwd(),
    providerMode: "mock-openai",
    primaryModel: "mock-openai/gpt-5.6-luna",
    alternateModel: "mock-openai/gpt-5.6-luna",
    ...(options.forcedRuntime ? { forcedRuntime: options.forcedRuntime } : {}),
    transport: {
      requiredPluginIds: [],
      createGatewayConfig: () => ({}),
    },
    transportBaseUrl: "http://127.0.0.1",
    controlUiEnabled: false,
    mutateConfig: (config) => ({
      ...config,
      plugins: {
        ...config.plugins,
        allow: [...new Set([...(config.plugins?.allow ?? []), "workboard"])],
        entries: {
          ...config.plugins?.entries,
          workboard: { enabled: true },
        },
      },
    }),
  });
  return harness;
}

function managedWorktreeName(cardId: string): string {
  const suffix = cardId
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-");
  return `wb-${suffix}`.slice(0, 64).replace(/-$/, "");
}

function collectDeclaredToolNames(value: unknown, names = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectDeclaredToolNames(item, names);
    }
    return names;
  }
  if (!value || typeof value !== "object") {
    return names;
  }
  const record = value as Record<string, unknown>;
  for (const key of ["name", "tool", "functionName"] as const) {
    if (typeof record[key] === "string") {
      names.add(record[key]);
    }
  }
  for (const item of Object.values(record)) {
    collectDeclaredToolNames(item, names);
  }
  return names;
}

async function createCard(params: {
  boardId: string;
  repo: string;
  title: string;
}): Promise<WorkboardCard> {
  if (!harness) {
    throw new Error("QA gateway harness is not running");
  }
  const created = (await harness.gateway.call("workboard.cards.create", {
    title: params.title,
    status: "ready",
    agentId: "qa",
    boardId: params.boardId,
    workspace: { kind: "worktree", path: params.repo, branch: "main" },
  })) as WorkboardCreateResult;
  return created.card;
}

async function listWorktrees(): Promise<WorktreeListResult> {
  if (!harness) {
    throw new Error("QA gateway harness is not running");
  }
  return (await harness.gateway.call("worktrees.list", {})) as WorktreeListResult;
}

async function waitForMaterializedWorktree(params: {
  name: string;
  stateDir: string;
  timeoutMs?: number;
}): Promise<string> {
  const worktreesRoot = path.join(params.stateDir, "worktrees");
  const deadline = Date.now() + (params.timeoutMs ?? 15_000);
  while (Date.now() < deadline) {
    const fingerprints = await fs.readdir(worktreesRoot, { withFileTypes: true }).catch(() => []);
    for (const fingerprint of fingerprints) {
      if (!fingerprint.isDirectory()) {
        continue;
      }
      const candidate = path.join(worktreesRoot, fingerprint.name, params.name);
      try {
        return await fs.realpath(candidate);
      } catch {
        // The dispatcher has not materialized this checkout yet.
      }
    }
    await sleep(20);
  }
  throw new Error(`timed out waiting for managed worktree ${params.name}`);
}

async function dispatchCardAndWaitForWorktree(params: {
  boardId: string;
  cardId: string;
  name: string;
  stateDir: string;
}): Promise<{ materializedPath: string; started: WorkboardDispatchResult["started"][number] }> {
  if (!harness) {
    throw new Error("QA gateway harness is not running");
  }
  const dispatchPromise = harness.gateway.call("workboard.cards.dispatch", {
    boardId: params.boardId,
  });
  const materializedPromise = waitForMaterializedWorktree({
    name: params.name,
    stateDir: params.stateDir,
  });
  const dispatch = (await dispatchPromise) as WorkboardDispatchResult;
  expect(dispatch.startFailures).toEqual([]);
  expect(dispatch.started).toEqual([
    expect.objectContaining({ cardId: params.cardId, runId: expect.any(String) }),
  ]);
  return {
    materializedPath: await materializedPromise,
    started: dispatch.started[0]!,
  };
}

async function waitForWorktreeState(params: {
  id: string;
  predicate: (record: ManagedWorktreeRecord | undefined) => boolean;
  timeoutMs?: number;
}): Promise<ManagedWorktreeRecord | undefined> {
  const deadline = Date.now() + (params.timeoutMs ?? 10_000);
  let record: ManagedWorktreeRecord | undefined;
  while (Date.now() < deadline) {
    record = (await listWorktrees()).worktrees.find((entry) => entry.id === params.id);
    if (params.predicate(record)) {
      return record;
    }
    await sleep(50);
  }
  throw new Error(`timed out waiting for managed worktree state ${params.id}`);
}

describe("managed worktrees Workboard-owner product proof", () => {
  it(
    "runs a board-default card through task, worktree, heartbeat, and completion",
    { timeout: 180_000 },
    async () => {
      const canonicalTmp = await fs.realpath(os.tmpdir());
      const fixtureRoot = tempDirs.make("openclaw-workboard-lifecycle-pilot-", canonicalTmp);
      const repo = await initializeRepository(fixtureRoot);
      const activeHarness = await startHarness({ forcedRuntime: "codex" });
      const stateDir = path.join(await fs.realpath(activeHarness.gateway.tempRoot), "state");
      const boardId = "qa-lifecycle-pilot";
      await activeHarness.gateway.call("workboard.boards.upsert", {
        id: boardId,
        defaultWorkspace: { kind: "worktree", path: repo, branch: "main" },
      });
      const created = (await activeHarness.gateway.call("workboard.cards.create", {
        title: "QA-WORKBOARD-LIFECYCLE-PILOT",
        status: "ready",
        agentId: "qa",
        boardId,
      })) as WorkboardCreateResult;
      expect(created.card.metadata?.automation?.workspace).toBeUndefined();
      const name = managedWorktreeName(created.card.id);

      const { materializedPath, started } = await dispatchCardAndWaitForWorktree({
        boardId,
        cardId: created.card.id,
        name,
        stateDir,
      });
      const terminal = (await activeHarness.gateway.call(
        "agent.wait",
        { runId: started.runId, timeoutMs: 30_000 },
        { timeoutMs: 35_000 },
      )) as GatewayRunResult;
      expect(terminal.status).toBe("ok");

      const deadline = Date.now() + 30_000;
      let completedCard: WorkboardCard | undefined;
      while (Date.now() < deadline) {
        const cards = (await activeHarness.gateway.call("workboard.cards.list", {
          boardId,
        })) as WorkboardListResult;
        completedCard = cards.cards.find((card) => card.id === created.card.id);
        if (
          completedCard?.status === "done" &&
          completedCard.metadata?.workerProtocol?.state === "completed"
        ) {
          break;
        }
        await sleep(50);
      }
      expect(completedCard).toMatchObject({
        id: created.card.id,
        status: "done",
        metadata: {
          automation: {
            workspace: expect.any(Object),
          },
          proof: [
            expect.objectContaining({ label: "Workboard lifecycle pilot", status: "passed" }),
          ],
          workerProtocol: { state: "completed" },
        },
      });
      expect(completedCard?.events?.map((event) => event.kind)).toContain("heartbeat");

      const tasks = (await activeHarness.gateway.call("tasks.list", {
        agentId: "qa",
        limit: 100,
      })) as TasksListResult;
      expect(tasks.tasks).toContainEqual(
        expect.objectContaining({
          kind: "subagent",
          runtime: "subagent",
          runId: started.runId,
          status: "completed",
          childSessionKey: started.sessionKey,
        }),
      );

      const requests = (await fetch(`${activeHarness.mock!.baseUrl}/debug/requests`).then(
        (response) => response.json(),
      )) as Array<{
        body?: { tools?: unknown; dynamicTools?: unknown };
        plannedToolName?: string;
        prompt?: string;
        toolOutput?: string;
      }>;
      const initialRequest = requests.find(
        (request) =>
          request.prompt?.includes("QA-WORKBOARD-LIFECYCLE-PILOT") && !request.toolOutput,
      );
      const declaredWorkboardTools = [
        ...collectDeclaredToolNames([
          initialRequest?.body?.tools,
          initialRequest?.body?.dynamicTools,
        ]),
      ]
        .filter((name) => name.startsWith("workboard_"))
        .toSorted();
      expect(declaredWorkboardTools).toEqual(
        ["workboard_heartbeat", "workboard_complete", "workboard_block"].toSorted(),
      );
      expect(
        requests
          .map((request) => request.plannedToolName)
          .filter((name): name is string => Boolean(name?.startsWith("workboard_"))),
      ).toEqual(["workboard_heartbeat", "workboard_complete"]);

      const worktree = (await listWorktrees()).worktrees.find(
        (record) => record.ownerKind === "workboard" && record.ownerId === created.card.id,
      );
      const removed = await waitForWorktreeState({
        id: worktree?.id ?? "",
        predicate: (record) => record?.runEndCleanup?.outcome === "removed-lossless",
        timeoutMs: 30_000,
      });
      expect(removed?.removedAt).toEqual(expect.any(Number));
      await expect(fs.access(materializedPath)).rejects.toMatchObject({ code: "ENOENT" });
      const finalCards = (await activeHarness.gateway.call("workboard.cards.list", {
        boardId,
      })) as WorkboardListResult;
      expect(
        finalCards.cards.find((card) => card.id === created.card.id)?.metadata?.automation
          ?.workspace,
      ).toEqual({ kind: "worktree", path: repo, branch: "main" });
    },
  );

  it(
    "nudges a persisted future automation when a linked worker ends",
    { timeout: 120_000 },
    async () => {
      const activeHarness = await startHarness();
      const addResult = (await activeHarness.gateway.call("cron.add", {
        name: "Workboard event nudge proof",
        enabled: true,
        schedule: { kind: "cron", expr: "0 3 1 1 *", tz: "America/Los_Angeles" },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        payload: { kind: "systemEvent", text: "Workboard event nudge proof" },
      })) as { id: string };
      const boardId = "qa-event-nudge";
      await activeHarness.gateway.call("workboard.boards.upsert", {
        id: boardId,
        automationJobId: addResult.id,
      });
      const boards = (await activeHarness.gateway.call("workboard.boards.list", {})) as {
        boards: Array<{ id: string; automationJobId?: string }>;
      };
      expect(boards.boards).toContainEqual(
        expect.objectContaining({ id: boardId, automationJobId: addResult.id }),
      );
      const card = (await activeHarness.gateway.call("workboard.cards.create", {
        title: "Event nudge lifecycle",
        status: "ready",
        agentId: "qa",
        boardId,
      })) as WorkboardCreateResult;

      const dispatch = (await activeHarness.gateway.call("workboard.cards.dispatch", {
        boardId,
      })) as WorkboardDispatchResult;
      expect(dispatch.startFailures).toEqual([]);
      expect(dispatch.started).toEqual([
        expect.objectContaining({ cardId: card.card.id, runId: expect.any(String) }),
      ]);
      const terminal = (await activeHarness.gateway.call(
        "agent.wait",
        { runId: dispatch.started[0]!.runId, timeoutMs: 30_000 },
        { timeoutMs: 35_000 },
      )) as GatewayRunResult;
      expect(terminal.status).toBe("ok");

      const deadline = Date.now() + 15_000;
      let entries: unknown[] = [];
      let lifecycleStatus: string | undefined;
      while (Date.now() < deadline) {
        const cards = (await activeHarness.gateway.call("workboard.cards.list", {
          boardId,
        })) as WorkboardListResult;
        lifecycleStatus = cards.cards.find((entry) => entry.id === card.card.id)?.status;
        const runs = (await activeHarness.gateway.call("cron.runs", {
          id: addResult.id,
          limit: 5,
        })) as { entries?: unknown[] };
        entries = runs.entries ?? [];
        if (entries.length > 0) {
          break;
        }
        await sleep(50);
      }
      expect(entries, `card=${String(lifecycleStatus)}\n${activeHarness.gateway.logs()}`).toEqual([
        expect.objectContaining({ jobId: addResult.id, status: "ok" }),
      ]);
    },
  );

  it(
    "removes clean card worktrees and records dirty run-end retention",
    { timeout: 240_000 },
    async () => {
      const canonicalTmp = await fs.realpath(os.tmpdir());
      const fixtureRoot = tempDirs.make("openclaw-managed-worktree-workboard-", canonicalTmp);
      const repo = await initializeRepository(fixtureRoot);
      const activeHarness = await startHarness();
      const stateDir = path.join(await fs.realpath(activeHarness.gateway.tempRoot), "state");
      const boardId = "qa-worktree-clean";
      const card = await createCard({ boardId, repo, title: "Clean worktree lifecycle" });
      const name = managedWorktreeName(card.id);

      const { materializedPath, started } = await dispatchCardAndWaitForWorktree({
        boardId,
        cardId: card.id,
        name,
        stateDir,
      });

      const cards = (await activeHarness.gateway.call("workboard.cards.list", {
        boardId,
      })) as WorkboardListResult;
      const dispatchedCard = cards.cards.find((entry) => entry.id === card.id);
      const dispatchedWorkspace = dispatchedCard?.metadata?.automation?.workspace;
      expect(dispatchedWorkspace).toMatchObject({
        kind: "worktree",
        branch: `openclaw/${name}`,
        sourcePath: repo,
        sourceBranch: "main",
      });
      expect(await fs.realpath(dispatchedWorkspace?.path ?? "")).toBe(materializedPath);
      expect(dispatchedCard?.runId).toBe(started.runId);

      const activeRecord = (await listWorktrees()).worktrees.find(
        (record) => record.ownerKind === "workboard" && record.ownerId === card.id,
      );
      expect(activeRecord).toMatchObject({
        name,
        branch: `openclaw/${name}`,
        repoRoot: repo,
        ownerKind: "workboard",
        ownerId: card.id,
      });
      expect(await fs.realpath(activeRecord?.path ?? "")).toBe(materializedPath);

      const terminal = (await activeHarness.gateway.call(
        "agent.wait",
        { runId: started.runId, timeoutMs: 30_000 },
        { timeoutMs: 35_000 },
      )) as GatewayRunResult;
      expect(terminal.status).toBe("ok");

      const removed = await waitForWorktreeState({
        id: activeRecord?.id ?? "",
        predicate: (record) =>
          record?.removedAt !== undefined && record.runEndCleanup?.outcome === "removed-lossless",
        timeoutMs: 30_000,
      });
      expect(removed).toMatchObject({
        id: activeRecord?.id,
        snapshotRef: `refs/openclaw/snapshots/${activeRecord?.id}`,
        removedAt: expect.any(Number),
        runEndCleanup: {
          outcome: "removed-lossless",
          at: expect.any(Number),
        },
      });
      await expect(fs.access(materializedPath)).rejects.toMatchObject({ code: "ENOENT" });

      // The mock provider reaches terminal without calling the Workboard worker protocol.
      // Close the first card at the operator boundary so its agent-global owner slot is free.
      const completed = (await activeHarness.gateway.call("workboard.cards.complete", {
        id: card.id,
        summary: "Clean worktree lifecycle completed.",
      })) as WorkboardCompleteResult;
      expect(completed.card).toMatchObject({ id: card.id, status: "done" });

      const dirtyBoardId = "qa-worktree-dirty";
      const dirtyCard = await createCard({
        boardId: dirtyBoardId,
        repo,
        title: "Dirty worktree retention",
      });
      const dirtyName = managedWorktreeName(dirtyCard.id);
      const { materializedPath: dirtyPath, started: dirtyStarted } =
        await dispatchCardAndWaitForWorktree({
          boardId: dirtyBoardId,
          cardId: dirtyCard.id,
          name: dirtyName,
          stateDir,
        });
      const dirtyFile = path.join(dirtyPath, "untracked-note.txt");
      await fs.writeFile(dirtyFile, "retain this worktree\n");
      const dirtyRecord = (await listWorktrees()).worktrees.find(
        (record) => record.ownerKind === "workboard" && record.ownerId === dirtyCard.id,
      );
      expect(dirtyRecord).toMatchObject({
        name: dirtyName,
        path: dirtyPath,
        ownerKind: "workboard",
        ownerId: dirtyCard.id,
      });

      const dirtyTerminal = (await activeHarness.gateway.call(
        "agent.wait",
        { runId: dirtyStarted.runId, timeoutMs: 30_000 },
        { timeoutMs: 35_000 },
      )) as GatewayRunResult;
      expect(dirtyTerminal.status).toBe("ok");

      const retained = await waitForWorktreeState({
        id: dirtyRecord?.id ?? "",
        predicate: (record) => record?.runEndCleanup?.outcome === "retained-dirty",
        timeoutMs: 30_000,
      });
      expect(retained).toMatchObject({
        id: dirtyRecord?.id,
        runEndCleanup: {
          outcome: "retained-dirty",
          at: expect.any(Number),
        },
      });
      expect(retained?.removedAt).toBeUndefined();
      await expect(fs.readFile(dirtyFile, "utf8")).resolves.toBe("retain this worktree\n");
    },
  );
});
