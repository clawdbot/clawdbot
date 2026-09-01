import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import type { WebSocket } from "ws";
import { createDeferred } from "../../test/helpers/promise.js";
import { loadSessionEntry, updateSessionEntry } from "../config/sessions/session-accessor.js";
import { SQLITE_SESSION_WRITER_QUEUES } from "../config/sessions/store-writer-state.js";
import {
  disposeOpenClawAgentDatabaseByPath,
  listOpenClawAgentDatabasesForTest,
} from "../state/openclaw-agent-db.js";
import {
  installGatewayTestHooks,
  onceMessage,
  rpcReq,
  testState,
  writeSessionStore,
} from "./test-helpers.js";
import { installConnectedControlUiServerSuite } from "./test-with-server.js";

installGatewayTestHooks({ scope: "suite" });
let ws: WebSocket;
installConnectedControlUiServerSuite((started) => {
  ws = started.ws;
});

describe("Gateway RPC fixture session writes", () => {
  test.each(["raw WebSocket", "rpcReq"])("%s preserves queued session writes", async (request) => {
    const dir = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gw-rpc-writes-")),
    );
    const storePath = path.join(dir, "openclaw-agent.sqlite");
    testState.sessionStorePath = storePath;
    const scope = { agentId: "main", sessionKey: "agent:main:main", storePath };
    const planning = createDeferred();
    const release = createDeferred();
    const writes: Promise<unknown>[] = [];
    let drains: Promise<void>[] = [];
    try {
      await writeSessionStore({ entries: { main: { sessionId: "rpc-writes", updatedAt: 1 } } });
      expect((await rpcReq(ws, "sessions.subscribe", {})).ok).toBe(true);
      const first = updateSessionEntry(scope, async () => {
        planning.resolve();
        await release.promise;
        return { label: "first" };
      });
      writes.push(first);
      await planning.promise;
      const second = updateSessionEntry(scope, () => ({ label: "second" }));
      writes.push(second);
      // Observe rejection immediately; retain drains even if the faulty helper drops their map.
      const outcomes = Promise.allSettled(writes);
      drains = [...SQLITE_SESSION_WRITER_QUEUES.values()].flatMap((queue) =>
        queue.drainPromise ? [queue.drainPromise] : [],
      );
      if (request === "rpcReq") {
        expect((await rpcReq(ws, "sessions.subscribe", {})).ok).toBe(true);
      } else {
        const id = "queued-writes-control";
        const response = onceMessage(ws, (event) => event.type === "res" && event.id === id);
        ws.send(JSON.stringify({ type: "req", id, method: "sessions.subscribe", params: {} }));
        expect((await response).ok).toBe(true);
      }
      release.resolve();
      expect(await outcomes).toEqual([
        { status: "fulfilled", value: expect.objectContaining({ label: "first" }) },
        { status: "fulfilled", value: expect.objectContaining({ label: "second" }) },
      ]);
      expect(loadSessionEntry(scope)?.label).toBe("second");
    } finally {
      release.resolve();
      await Promise.allSettled([...writes, ...drains]);
      // This custom store lives outside the Gateway HOME and owns its own disposal.
      disposeOpenClawAgentDatabaseByPath(storePath);
      testState.sessionStorePath = undefined;
      await fs.rm(dir, { recursive: true, force: true });
    }
    expect(
      listOpenClawAgentDatabasesForTest().some((database) => database.path === storePath),
    ).toBe(false);
  });
});
