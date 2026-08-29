import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../config/io.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.entry.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { boardStore } from "./board-store.js";
import { progressCardStore } from "./progress-card-store.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  clearRuntimeConfigSnapshot();
  vi.unstubAllEnvs();
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
    expect(boardStore.getSnapshot(sessionKey).widgets).toEqual([
      expect.objectContaining({ name: agentId, revision: 1 }),
    ]);
    expect(progressCardStore.get(sessionKey)).toMatchObject({
      sessionKey,
      markdown: `${agentId} progress`,
      revision: 1,
    });
  }
  expect(boardStore.listSessionsWithBoards()).toEqual(["agent:alpha:main", "agent:beta:main"]);
});
