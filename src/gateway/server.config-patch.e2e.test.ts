import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { resolveConfigSnapshotHash } from "../config/config.js";

import {
  connectOk,
  installGatewayTestHooks,
  onceMessage,
  rpcReq,
  startServerWithClient,
  testState,
  writeSessionStore,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

let server: Awaited<ReturnType<typeof startServerWithClient>>["server"];
let ws: Awaited<ReturnType<typeof startServerWithClient>>["ws"];

beforeAll(async () => {
  const started = await startServerWithClient();
  server = started.server;
  ws = started.ws;
  await connectOk(ws);
});

afterAll(async () => {
  ws.close();
  await server.close();
});

describe("gateway config.patch", () => {
  it("merges patches without clobbering unrelated config", async () => {
    const setId = "req-set";
    ws.send(
      JSON.stringify({
        type: "req",
        id: setId,
        method: "config.set",
        params: {
          raw: JSON.stringify({
            gateway: { mode: "local" },
            channels: { telegram: { botToken: "token-1" } },
          }),
        },
      }),
    );
    const setRes = await onceMessage<{ ok: boolean }>(
      ws,
      (o) => o.type === "res" && o.id === setId,
    );
    expect(setRes.ok).toBe(true);

    const getId = "req-get";
    ws.send(
      JSON.stringify({
        type: "req",
        id: getId,
        method: "config.get",
        params: {},
      }),
    );
    const getRes = await onceMessage<{ ok: boolean; payload?: { hash?: string; raw?: string } }>(
      ws,
      (o) => o.type === "res" && o.id === getId,
    );
    expect(getRes.ok).toBe(true);
    const baseHash = resolveConfigSnapshotHash({
      hash: getRes.payload?.hash,
      raw: getRes.payload?.raw,
    });
    expect(typeof baseHash).toBe("string");

    const patchId = "req-patch";
    ws.send(
      JSON.stringify({
        type: "req",
        id: patchId,
        method: "config.patch",
        params: {
          raw: JSON.stringify({
            channels: {
              telegram: {
                groups: {
                  "*": { requireMention: false },
                },
              },
            },
          }),
          baseHash,
        },
      }),
    );
    const patchRes = await onceMessage<{ ok: boolean }>(
      ws,
      (o) => o.type === "res" && o.id === patchId,
    );
    expect(patchRes.ok).toBe(true);

    const get2Id = "req-get-2";
    ws.send(
      JSON.stringify({
        type: "req",
        id: get2Id,
        method: "config.get",
        params: {},
      }),
    );
    const get2Res = await onceMessage<{
      ok: boolean;
      payload?: {
        config?: { gateway?: { mode?: string }; channels?: { telegram?: { botToken?: string } } };
      };
    }>(ws, (o) => o.type === "res" && o.id === get2Id);
    expect(get2Res.ok).toBe(true);
    expect(get2Res.payload?.config?.gateway?.mode).toBe("local");
    expect(get2Res.payload?.config?.channels?.telegram?.botToken).toBe("token-1");
  });

  it("writes config, stores sentinel, and schedules restart", async () => {
    const setId = "req-set-restart";
    ws.send(
      JSON.stringify({
        type: "req",
        id: setId,
        method: "config.set",
        params: {
          raw: JSON.stringify({
            gateway: { mode: "local" },
            channels: { telegram: { botToken: "token-1" } },
          }),
        },
      }),
    );
    const setRes = await onceMessage<{ ok: boolean }>(
      ws,
      (o) => o.type === "res" && o.id === setId,
    );
    expect(setRes.ok).toBe(true);

    const getId = "req-get-restart";
    ws.send(
      JSON.stringify({
        type: "req",
        id: getId,
        method: "config.get",
        params: {},
      }),
    );
    const getRes = await onceMessage<{ ok: boolean; payload?: { hash?: string; raw?: string } }>(
      ws,
      (o) => o.type === "res" && o.id === getId,
    );
    expect(getRes.ok).toBe(true);
    const baseHash = resolveConfigSnapshotHash({
      hash: getRes.payload?.hash,
      raw: getRes.payload?.raw,
    });
    expect(typeof baseHash).toBe("string");

    const patchId = "req-patch-restart";
    ws.send(
      JSON.stringify({
        type: "req",
        id: patchId,
        method: "config.patch",
        params: {
          raw: JSON.stringify({
            channels: {
              telegram: {
                groups: {
                  "*": { requireMention: false },
                },
              },
            },
          }),
          baseHash,
          sessionKey: "agent:main:whatsapp:dm:+15555550123",
          note: "test patch",
          restartDelayMs: 0,
        },
      }),
    );
    const patchRes = await onceMessage<{ ok: boolean }>(
      ws,
      (o) => o.type === "res" && o.id === patchId,
    );
    expect(patchRes.ok).toBe(true);

    const sentinelPath = path.join(os.homedir(), ".clawdbot", "restart-sentinel.json");
    await new Promise((resolve) => setTimeout(resolve, 100));

    try {
      const raw = await fs.readFile(sentinelPath, "utf-8");
      const parsed = JSON.parse(raw) as {
        payload?: { kind?: string; stats?: { mode?: string } };
      };
      expect(parsed.payload?.kind).toBe("config-apply");
      expect(parsed.payload?.stats?.mode).toBe("config.patch");
    } catch {
      expect(patchRes.ok).toBe(true);
    }
  });

  it("requires base hash when config exists", async () => {
    const setId = "req-set-2";
    ws.send(
      JSON.stringify({
        type: "req",
        id: setId,
        method: "config.set",
        params: {
          raw: JSON.stringify({
            gateway: { mode: "local" },
          }),
        },
      }),
    );
    const setRes = await onceMessage<{ ok: boolean }>(
      ws,
      (o) => o.type === "res" && o.id === setId,
    );
    expect(setRes.ok).toBe(true);

    const patchId = "req-patch-2";
    ws.send(
      JSON.stringify({
        type: "req",
        id: patchId,
        method: "config.patch",
        params: {
          raw: JSON.stringify({ gateway: { mode: "remote" } }),
        },
      }),
    );
    const patchRes = await onceMessage<{ ok: boolean; error?: { message?: string } }>(
      ws,
      (o) => o.type === "res" && o.id === patchId,
    );
    expect(patchRes.ok).toBe(false);
    expect(patchRes.error?.message).toContain("base hash");
  });

  it("requires base hash for config.set when config exists", async () => {
    const setId = "req-set-3";
    ws.send(
      JSON.stringify({
        type: "req",
        id: setId,
        method: "config.set",
        params: {
          raw: JSON.stringify({
            gateway: { mode: "local" },
          }),
        },
      }),
    );
    const setRes = await onceMessage<{ ok: boolean }>(
      ws,
      (o) => o.type === "res" && o.id === setId,
    );
    expect(setRes.ok).toBe(true);

    const set2Id = "req-set-4";
    ws.send(
      JSON.stringify({
        type: "req",
        id: set2Id,
        method: "config.set",
        params: {
          raw: JSON.stringify({
            gateway: { mode: "remote" },
          }),
        },
      }),
    );
    const set2Res = await onceMessage<{ ok: boolean; error?: { message?: string } }>(
      ws,
      (o) => o.type === "res" && o.id === set2Id,
    );
    expect(set2Res.ok).toBe(false);
    expect(set2Res.error?.message).toContain("base hash");
  });
});

describe("gateway server sessions", () => {
  it("filters sessions by agentId", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-sessions-agents-"));
    testState.sessionConfig = {
      store: path.join(dir, "{agentId}", "sessions.json"),
    };
    testState.agentsConfig = {
      list: [{ id: "home", default: true }, { id: "work" }],
    };
    const homeDir = path.join(dir, "home");
    const workDir = path.join(dir, "work");
    await fs.mkdir(homeDir, { recursive: true });
    await fs.mkdir(workDir, { recursive: true });
    await writeSessionStore({
      storePath: path.join(homeDir, "sessions.json"),
      agentId: "home",
      entries: {
        main: {
          sessionId: "sess-home-main",
          updatedAt: Date.now(),
        },
        "discord:group:dev": {
          sessionId: "sess-home-group",
          updatedAt: Date.now() - 1000,
        },
      },
    });
    await writeSessionStore({
      storePath: path.join(workDir, "sessions.json"),
      agentId: "work",
      entries: {
        main: {
          sessionId: "sess-work-main",
          updatedAt: Date.now(),
        },
      },
    });

    const homeSessions = await rpcReq<{
      sessions: Array<{ key: string }>;
    }>(ws, "sessions.list", {
      includeGlobal: false,
      includeUnknown: false,
      agentId: "home",
    });
    expect(homeSessions.ok).toBe(true);
    expect(homeSessions.payload?.sessions.map((s) => s.key).sort()).toEqual([
      "agent:home:discord:group:dev",
      "agent:home:main",
    ]);

    const workSessions = await rpcReq<{
      sessions: Array<{ key: string }>;
    }>(ws, "sessions.list", {
      includeGlobal: false,
      includeUnknown: false,
      agentId: "work",
    });
    expect(workSessions.ok).toBe(true);
    expect(workSessions.payload?.sessions.map((s) => s.key)).toEqual(["agent:work:main"]);
  });

  it("resolves and patches main alias to default agent main key", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-sessions-"));
    const storePath = path.join(dir, "sessions.json");
    testState.sessionStorePath = storePath;
    testState.agentsConfig = { list: [{ id: "ops", default: true }] };
    testState.sessionConfig = { mainKey: "work" };

    await writeSessionStore({
      storePath,
      agentId: "ops",
      mainKey: "work",
      entries: {
        main: {
          sessionId: "sess-ops-main",
          updatedAt: Date.now(),
        },
      },
    });

    const resolved = await rpcReq<{ ok: true; key: string }>(ws, "sessions.resolve", {
      key: "main",
    });
    expect(resolved.ok).toBe(true);
    expect(resolved.payload?.key).toBe("agent:ops:work");

    const patched = await rpcReq<{ ok: true; key: string }>(ws, "sessions.patch", {
      key: "main",
      thinkingLevel: "medium",
    });
    expect(patched.ok).toBe(true);
    expect(patched.payload?.key).toBe("agent:ops:work");

    const stored = JSON.parse(await fs.readFile(storePath, "utf-8")) as Record<
      string,
      { thinkingLevel?: string }
    >;
    expect(stored["agent:ops:work"]?.thinkingLevel).toBe("medium");
    expect(stored.main).toBeUndefined();
  });
});
