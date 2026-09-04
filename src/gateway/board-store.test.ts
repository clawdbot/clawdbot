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

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  clearRuntimeConfigSnapshot();
  vi.unstubAllEnvs();
});

it("keeps global boards under each owner's canonical session row across reopen", async () => {
  const stateDir = tempDirs.make("openclaw-gateway-global-boards-");
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  const cfg = {
    agents: { ownership: "explicit" as const, entries: { main: {}, work: {} } },
    session: { scope: "global" as const },
  };
  setRuntimeConfigSnapshot(cfg, cfg);
  const { invoke } = createBoardHarness(undefined, {}, boardStore, { getRuntimeConfig: () => cfg });

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
  }
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();

  for (const agentId of ["main", "work"]) {
    const target = { sessionKey: "global", agentId };
    expect(boardStore.getSnapshot(target)).toMatchObject({
      sessionKey: "global",
      widgets: [{ name: "status", revision: 1 }],
    });
    expect(boardStore.readWidgetHtml(target, "status")?.html).toBe(
      buildWidgetDocument("status", `<p>${agentId}</p>`),
    );
    for (const params of [target, { sessionKey: `agent:${agentId}:main` }]) {
      const snapshot = await invoke("board.get", params);
      expect(snapshot).toHaveBeenCalledWith(
        true,
        expect.objectContaining({
          sessionKey: `agent:${agentId}:global`,
          widgets: [expect.objectContaining({ name: "status", revision: 1 })],
        }),
      );
    }
  }
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
