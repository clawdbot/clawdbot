import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  connectOk,
  installGatewayTestHooks,
  rpcReq,
  startServerWithClient,
  testState,
} from "./test-helpers.js";

installGatewayTestHooks();

describe("gateway server sessions", () => {
  test("filters sessions by agentId", async () => {
    const dir = await fs.mkdtemp(
      path.join(os.tmpdir(), "clawdbot-sessions-agents-"),
    );
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
    await fs.writeFile(
      path.join(homeDir, "sessions.json"),
      JSON.stringify(
        {
          "agent:home:main": {
            sessionId: "sess-home-main",
            updatedAt: Date.now(),
          },
          "agent:home:discord:group:dev": {
            sessionId: "sess-home-group",
            updatedAt: Date.now() - 1000,
          },
        },
        null,
        2,
      ),
      "utf-8",
    );
    await fs.writeFile(
      path.join(workDir, "sessions.json"),
      JSON.stringify(
        {
          "agent:work:main": {
            sessionId: "sess-work-main",
            updatedAt: Date.now(),
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    const { ws } = await startServerWithClient();
    await connectOk(ws);

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
    expect(workSessions.payload?.sessions.map((s) => s.key)).toEqual([
      "agent:work:main",
    ]);
  });

  test("resolves and patches main alias to default agent main key", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-sessions-"));
    const storePath = path.join(dir, "sessions.json");
    testState.sessionStorePath = storePath;
    testState.agentsConfig = { list: [{ id: "ops", default: true }] };
    testState.sessionConfig = { mainKey: "work" };

    await fs.writeFile(
      storePath,
      JSON.stringify(
        {
          "agent:ops:work": {
            sessionId: "sess-ops-main",
            updatedAt: Date.now(),
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    const { ws } = await startServerWithClient();
    await connectOk(ws);
    const resolved = await rpcReq<{ ok: true; key: string }>(
      ws,
      "sessions.resolve",
      { key: "main" },
    );
    expect(resolved.ok).toBe(true);
    expect(resolved.payload?.key).toBe("agent:ops:work");

    const patched = await rpcReq<{ ok: true; key: string }>(
      ws,
      "sessions.patch",
      { key: "main", thinkingLevel: "medium" },
    );
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
