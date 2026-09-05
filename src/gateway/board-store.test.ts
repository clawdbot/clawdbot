import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { buildWidgetDocument } from "../canvas/wrap.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../config/io.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.entry.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { boardStore } from "./board-store.js";
import { progressCardStore } from "./progress-card-store.js";
import { createBoardHarness } from "./server-methods/board.test-support.js";
import { createProgressCardHandlers } from "./server-methods/progress-card.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  clearRuntimeConfigSnapshot();
  vi.unstubAllEnvs();
});

it("keeps global boards and progress under each owner's canonical row across reopen", async () => {
  const stateDir = tempDirs.make("openclaw-gateway-global-boards-");
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  const cfg = {
    agents: { ownership: "explicit" as const, entries: { main: {}, work: {} } },
    session: { scope: "global" as const },
  };
  setRuntimeConfigSnapshot(cfg, cfg);
  const { invoke, handlers, broadcast } = createBoardHarness(undefined, {}, boardStore, {
    getRuntimeConfig: () => cfg,
  });
  Object.assign(handlers, createProgressCardHandlers());

  for (const agentId of ["main", "work"]) {
    const database = openOpenClawAgentDatabase({ agentId });
    replaceSessionEntrySync(
      { agentId, sessionKey: "global", storePath: database.path },
      { sessionId: `session-${agentId}`, updatedAt: 1 },
    );
    const written = await invoke("board.widget.put", {
      sessionKey: "global",
      agentId,
      name: "status",
      content: { kind: "html", html: `<p>${agentId}</p>` },
    });
    expect(written).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        sessionKey: `agent:${agentId}:global`,
        revision: 1,
      }),
    );
    expect(database.db.prepare("SELECT session_key FROM board_tabs").all()).toEqual([
      expect.objectContaining({ session_key: "global" }),
    ]);
    const progress = await invoke("progressCard.put", {
      sessionKey: "global",
      agentId,
      plan: [{ step: `${agentId} done`, status: "completed" }],
    });
    expect(progress).toHaveBeenCalledWith(
      true,
      { card: expect.objectContaining({ sessionKey: `agent:${agentId}:global`, revision: 1 }) },
      undefined,
    );
    expect(database.db.prepare("SELECT session_key FROM session_progress_cards").all()).toEqual([
      expect.objectContaining({ session_key: "global" }),
    ]);
    expect(database.db.prepare("SELECT session_key FROM session_nodes").all()).toEqual([
      expect.objectContaining({ session_key: "global" }),
    ]);
  }
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();

  for (const agentId of ["main", "work"]) {
    const target = { sessionKey: "global", agentId };
    for (const params of [target, { sessionKey: `agent:${agentId}:main` }]) {
      expect(boardStore.getSnapshot(params)).toMatchObject({
        sessionKey: "global",
        widgets: [{ name: "status", revision: 1 }],
      });
      expect(boardStore.readWidgetHtml(params, "status")?.html).toBe(
        buildWidgetDocument("status", `<p>${agentId}</p>`),
      );
      const snapshot = await invoke("board.get", params);
      expect(snapshot).toHaveBeenCalledWith(
        true,
        expect.objectContaining({
          sessionKey: `agent:${agentId}:global`,
          widgets: [expect.objectContaining({ name: "status", revision: 1 })],
        }),
      );
    }
    const progress = await invoke("progressCard.get", { sessionKey: "global", agentId });
    expect(progress).toHaveBeenCalledWith(
      true,
      {
        card: expect.objectContaining({
          sessionKey: `agent:${agentId}:global`,
          revision: 1,
          steps: [{ step: `${agentId} done`, status: "completed" }],
        }),
      },
      undefined,
    );
  }
  await invoke("progressCard.put", { sessionKey: "agent:work:main", expectedRevision: 2 });
  expect(progressCardStore.get("global", "work")?.revision).toBe(1);
  const cleared = await invoke("progressCard.put", {
    sessionKey: "global",
    agentId: "work",
    expectedRevision: 1,
  });
  expect(cleared).toHaveBeenCalledWith(true, { card: null }, undefined);
  expect(broadcast).toHaveBeenLastCalledWith(
    "progressCard.changed",
    {
      sessionKey: "agent:work:global",
      revision: null,
    },
    { sessionKeys: ["global"], agentId: "work" },
  );
  expect(progressCardStore.get("global", "main")?.revision).toBe(1);
});

it("keeps retained global progress separate from an ordinary qualified global row in per-sender mode", async () => {
  const stateDir = tempDirs.make("openclaw-gateway-retained-global-progress-");
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  const cfg = {
    agents: { list: [{ id: "main", default: true }, { id: "work" }] },
    session: { scope: "per-sender" as const },
  };
  setRuntimeConfigSnapshot(cfg, cfg);
  const { invoke, handlers } = createBoardHarness(undefined, {}, boardStore, {
    getRuntimeConfig: () => cfg,
  });
  Object.assign(handlers, createProgressCardHandlers());
  const targets = [
    { sessionKey: "global", agentId: "main" },
    { sessionKey: "global", agentId: "work" },
    { sessionKey: "agent:work:global", agentId: "work" },
  ];
  for (const target of targets) {
    const database = openOpenClawAgentDatabase({ agentId: target.agentId });
    replaceSessionEntrySync(
      { ...target, storePath: database.path },
      { sessionId: `${target.agentId}-${target.sessionKey}`, updatedAt: 1 },
    );
    const written = await invoke("progressCard.put", {
      ...target,
      markdown: `${target.agentId}/${target.sessionKey}`,
      plan: [{ step: "Done", status: "completed" }],
    });
    expect(written).toHaveBeenCalledWith(
      true,
      { card: expect.objectContaining({ revision: 1 }) },
      undefined,
    );
  }
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();

  for (const target of targets) {
    const read = await invoke("progressCard.get", target);
    expect(read).toHaveBeenCalledWith(
      true,
      {
        card: expect.objectContaining({
          sessionKey: `agent:${target.agentId}:global`,
          markdown: `${target.agentId}/${target.sessionKey}`,
          revision: 1,
        }),
      },
      undefined,
    );
  }
  const unqualified = await invoke("progressCard.get", { sessionKey: "global" });
  expect(unqualified).toHaveBeenCalledWith(
    true,
    { card: expect.objectContaining({ markdown: "main/global" }) },
    undefined,
  );
  const stale = await invoke("progressCard.put", {
    sessionKey: "global",
    agentId: "work",
    expectedRevision: 2,
  });
  expect(stale).toHaveBeenCalledWith(
    true,
    { card: expect.objectContaining({ markdown: "work/global", revision: 1 }) },
    undefined,
  );
  const cleared = await invoke("progressCard.put", {
    sessionKey: "global",
    agentId: "work",
    expectedRevision: 1,
  });
  expect(cleared).toHaveBeenCalledWith(true, { card: null }, undefined);
  expect(progressCardStore.get("global", "work")).toBeNull();
  expect(progressCardStore.get("global", "main")?.markdown).toBe("main/global");
  expect(progressCardStore.get("agent:work:global", "work")?.markdown).toBe(
    "work/agent:work:global",
  );
});

it("reopens separate boards and progress cards in a shared database owned by another agent", () => {
  const stateDir = tempDirs.make("openclaw-gateway-shared-boards-");
  const storePath = path.join(stateDir, "shared.sqlite");
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  const cfg = {
    agents: { entries: { alpha: { default: true }, beta: {} } },
    session: { store: storePath },
  };
  setRuntimeConfigSnapshot(cfg, cfg);
  openOpenClawAgentDatabase({ agentId: "alpha", path: storePath });
  // An older canonical registration must not replace the configured store's physical owner.
  openOpenClawAgentDatabase({ agentId: "beta" });

  for (const agentId of ["alpha", "beta"]) {
    const sessionKey = `agent:${agentId}:main`;
    replaceSessionEntrySync(
      { agentId, sessionKey, storePath },
      { sessionId: `session-${agentId}`, updatedAt: Date.now() },
    );
    boardStore.putWidget({
      sessionKey,
      name: agentId,
      content: { kind: "html", html: `<p>${agentId}</p>` },
    });
    progressCardStore.put(sessionKey, { markdown: `${agentId} progress` });
  }
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();

  for (const agentId of ["alpha", "beta"]) {
    const sessionKey = `agent:${agentId}:main`;
    expect(boardStore.getSnapshot({ sessionKey }).widgets).toEqual([
      expect.objectContaining({ name: agentId, revision: 1 }),
    ]);
    expect(progressCardStore.get(sessionKey)).toMatchObject({
      sessionKey,
      markdown: `${agentId} progress`,
      revision: 1,
    });
  }
});
