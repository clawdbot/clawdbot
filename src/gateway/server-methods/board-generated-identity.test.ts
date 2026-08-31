import { afterEach, expect, it } from "vitest";
import type { BoardSnapshot } from "../../../packages/gateway-protocol/src/index.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { SqliteBoardStore } from "../../boards/sqlite-board-store.js";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.entry.js";
import { resetPluginRuntimeStateForTest } from "../../plugins/runtime.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { createBoardHarness } from "./board.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  resetPluginRuntimeStateForTest();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

it("serializes in-flight generated-name collisions and reuses both names after reload", async () => {
  resetPluginRuntimeStateForTest();
  const env = { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-board-generated-race-") };
  const sessionKey = "agent:main:generated-race";
  const database = openOpenClawAgentDatabase({ agentId: "main", env });
  replaceSessionEntrySync(
    { agentId: "main", sessionKey, storePath: database.path },
    { sessionId: "generated-race", updatedAt: Date.now() },
  );
  const options = {
    resolveSession: () => ({ agentId: "main", sessionKey }),
    env,
  };
  let arrivals = 0;
  let releaseReaders: (() => void) | undefined;
  const readersReady = new Promise<void>((resolve) => {
    releaseReaders = resolve;
  });
  const readCanvasDocument = async (docId: string) => {
    arrivals += 1;
    if (arrivals === 2) {
      releaseReaders?.();
    }
    await readersReady;
    return { html: `<p>${docId}</p>`, cspSandbox: "scripts" as const };
  };
  const { invoke, broadcast } = createBoardHarness(
    readCanvasDocument,
    {},
    new SqliteBoardStore(options),
  );
  const [first, second] = await Promise.all([
    invoke("board.widget.put", {
      sessionKey,
      name: "2024",
      title: "売上レポート 2024",
      content: { kind: "canvas-doc", docId: "sales" },
      generatedIdentity: {
        source: "show_widget",
        key: "a".repeat(64),
        fallbackName: "2024-aaaaaaaa",
      },
    }),
    invoke("board.widget.put", {
      sessionKey,
      name: "2024",
      title: "在庫レポート 2024",
      content: { kind: "canvas-doc", docId: "inventory" },
      generatedIdentity: {
        source: "show_widget",
        key: "b".repeat(64),
        fallbackName: "2024-bbbbbbbb",
      },
    }),
  ]);

  const results = [first, second].map(
    (respond) => respond.mock.calls[0]?.[1] as BoardSnapshot & { resolvedWidgetName: string },
  );
  const committedNames = results.map((result) => result.resolvedWidgetName);
  expect(new Set(committedNames).size).toBe(2);
  expect(committedNames).toContain("2024");
  expect(committedNames.some((name) => name === "2024-aaaaaaaa" || name === "2024-bbbbbbbb")).toBe(
    true,
  );
  expect(
    broadcast.mock.calls.map(([, event]) => (event as { widget?: string }).widget).filter(Boolean),
  ).toEqual(expect.arrayContaining(committedNames));

  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  const reloaded = createBoardHarness(undefined, {}, new SqliteBoardStore(options));
  const get = await reloaded.invoke("board.get", { sessionKey });
  const snapshot = get.mock.calls[0]?.[1] as BoardSnapshot;
  expect(new Set(snapshot.widgets.map((widget) => widget.name))).toEqual(new Set(committedNames));

  const firstReload = await reloaded.invoke("board.widget.put", {
    sessionKey,
    name: "2024",
    title: "売上レポート 2024",
    content: { kind: "html", html: "<p>sales revised</p>" },
    generatedIdentity: {
      source: "show_widget",
      key: "a".repeat(64),
      fallbackName: "2024-aaaaaaaa",
    },
  });
  const secondReload = await reloaded.invoke("board.widget.put", {
    sessionKey,
    name: "2024",
    title: "在庫レポート 2024",
    content: { kind: "html", html: "<p>inventory revised</p>" },
    generatedIdentity: {
      source: "show_widget",
      key: "b".repeat(64),
      fallbackName: "2024-bbbbbbbb",
    },
  });
  const resolvedName = (respond: typeof firstReload) => {
    const payload = respond.mock.calls[0]?.[1];
    expect(payload).toBeDefined();
    return (payload as BoardSnapshot & { resolvedWidgetName: string }).resolvedWidgetName;
  };
  expect(new Set([firstReload, secondReload].map((respond) => resolvedName(respond)))).toEqual(
    new Set(committedNames),
  );
  expect(
    reloaded.broadcast.mock.calls
      .map(([, event]) => (event as { widget?: string }).widget)
      .filter(Boolean),
  ).toEqual(expect.arrayContaining(committedNames));
});
