import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";
import type { WebSocket } from "ws";
import { createDeferred } from "../../test/helpers/promise.js";
import { listAgentIds } from "../agents/agent-scope.js";
import { loadSessionEntry, updateSessionEntry } from "../config/sessions/session-accessor.js";
import { SQLITE_SESSION_WRITER_QUEUES } from "../config/sessions/store-writer-state.js";
import {
  disposeOpenClawAgentDatabaseByPath,
  listOpenClawAgentDatabasesForTest,
} from "../state/openclaw-agent-db.js";
import {
  installGatewayTestHooks,
  onceMessage,
  prepareGatewayReplyRuntimeForTest,
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

describe("Gateway fixture config publication", () => {
  test.each(["RPC admission", "reply preparation", "RPC session update"] as const)(
    "%s shares the current fixture with real IO across awaited work",
    async (boundary) => {
      const actual = await vi.importActual<typeof import("../config/io.js")>("../config/io.js");
      const { getRuntimeConfig } = await import("../config/io.js");
      for (const agentId of ["worker", "reviewer", undefined]) {
        testState.agentsConfig = agentId
          ? { ownership: "explicit", entries: { main: {}, [agentId]: {} } }
          : undefined;
        testState.sessionConfig =
          boundary === "RPC session update" ? { mainKey: agentId ?? "main" } : undefined;
        const admission =
          boundary === "reply preparation"
            ? prepareGatewayReplyRuntimeForTest({ force: true })
            : rpcReq(ws, "agents.list", {});
        // Real maintenance/finalizer callbacks can read config while admission
        // yields for imports or model preparation, before the RPC is sent.
        const duringAdmission = actual.getRuntimeConfig();
        await admission;
        const expectedAgents = agentId ? ["main", agentId] : ["main"];
        expect(listAgentIds(duringAdmission)).toEqual(expectedAgents);
        if (boundary === "RPC session update") {
          expect(duringAdmission.session?.mainKey).toBe(agentId ?? "main");
        }
        expect(listAgentIds(actual.getRuntimeConfig())).toEqual(expectedAgents);
        expect(getRuntimeConfig()).toEqual(actual.getRuntimeConfig());
        const response = await rpcReq<{ agents: Array<{ id: string }> }>(ws, "agents.list", {});
        expect(response.ok, JSON.stringify(response)).toBe(true);
        expect(response.payload?.agents.map((agent) => agent.id)).toEqual(expectedAgents);
      }
    },
  );
});
