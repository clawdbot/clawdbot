import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  connectOk,
  embeddedRunMock,
  installGatewayTestHooks,
  piSdkMock,
  rpcReq,
  startServerWithClient,
  testState,
} from "./test-helpers.js";

installGatewayTestHooks();

describe("gateway server sessions", () => {
  test("lists and patches session store via sessions.* RPC", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-sessions-"));
    const storePath = path.join(dir, "sessions.json");
    const now = Date.now();
    testState.sessionStorePath = storePath;

    await fs.writeFile(
      path.join(dir, "sess-main.jsonl"),
      `${Array.from({ length: 10 })
        .map((_, idx) =>
          JSON.stringify({ role: "user", content: `line ${idx}` }),
        )
        .join("\n")}\n`,
      "utf-8",
    );
    await fs.writeFile(
      path.join(dir, "sess-group.jsonl"),
      `${JSON.stringify({ role: "user", content: "group line 0" })}\n`,
      "utf-8",
    );

    await fs.writeFile(
      storePath,
      JSON.stringify(
        {
          "agent:main:main": {
            sessionId: "sess-main",
            updatedAt: now - 30_000,
            inputTokens: 10,
            outputTokens: 20,
            thinkingLevel: "low",
            verboseLevel: "on",
            lastProvider: "whatsapp",
            lastTo: "+1555",
            lastAccountId: "work",
          },
          "agent:main:discord:group:dev": {
            sessionId: "sess-group",
            updatedAt: now - 120_000,
            totalTokens: 50,
          },
          "agent:main:subagent:one": {
            sessionId: "sess-subagent",
            updatedAt: now - 120_000,
            spawnedBy: "agent:main:main",
          },
          global: {
            sessionId: "sess-global",
            updatedAt: now - 10_000,
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    const { server, ws } = await startServerWithClient();
    const hello = await connectOk(ws);
    expect(
      (hello as unknown as { features?: { methods?: string[] } }).features
        ?.methods,
    ).toEqual(
      expect.arrayContaining([
        "sessions.list",
        "sessions.patch",
        "sessions.reset",
        "sessions.delete",
        "sessions.compact",
      ]),
    );

    const resolvedByKey = await rpcReq<{ ok: true; key: string }>(
      ws,
      "sessions.resolve",
      { key: "main" },
    );
    expect(resolvedByKey.ok).toBe(true);
    expect(resolvedByKey.payload?.key).toBe("agent:main:main");

    const list1 = await rpcReq<{
      path: string;
      sessions: Array<{
        key: string;
        totalTokens?: number;
        thinkingLevel?: string;
        verboseLevel?: string;
        lastAccountId?: string;
      }>;
    }>(ws, "sessions.list", { includeGlobal: false, includeUnknown: false });

    expect(list1.ok).toBe(true);
    expect(list1.payload?.path).toBe(storePath);
    expect(list1.payload?.sessions.some((s) => s.key === "global")).toBe(false);
    const main = list1.payload?.sessions.find(
      (s) => s.key === "agent:main:main",
    );
    expect(main?.totalTokens).toBe(30);
    expect(main?.thinkingLevel).toBe("low");
    expect(main?.verboseLevel).toBe("on");
    expect(main?.lastAccountId).toBe("work");

    const active = await rpcReq<{
      sessions: Array<{ key: string }>;
    }>(ws, "sessions.list", {
      includeGlobal: false,
      includeUnknown: false,
      activeMinutes: 1,
    });
    expect(active.ok).toBe(true);
    expect(active.payload?.sessions.map((s) => s.key)).toEqual([
      "agent:main:main",
    ]);

    const limited = await rpcReq<{
      sessions: Array<{ key: string }>;
    }>(ws, "sessions.list", {
      includeGlobal: true,
      includeUnknown: false,
      limit: 1,
    });
    expect(limited.ok).toBe(true);
    expect(limited.payload?.sessions).toHaveLength(1);
    expect(limited.payload?.sessions[0]?.key).toBe("global");

    const patched = await rpcReq<{ ok: true; key: string }>(
      ws,
      "sessions.patch",
      { key: "agent:main:main", thinkingLevel: "medium", verboseLevel: null },
    );
    expect(patched.ok).toBe(true);
    expect(patched.payload?.ok).toBe(true);
    expect(patched.payload?.key).toBe("agent:main:main");

    const sendPolicyPatched = await rpcReq<{
      ok: true;
      entry: { sendPolicy?: string };
    }>(ws, "sessions.patch", { key: "agent:main:main", sendPolicy: "deny" });
    expect(sendPolicyPatched.ok).toBe(true);
    expect(sendPolicyPatched.payload?.entry.sendPolicy).toBe("deny");

    const labelPatched = await rpcReq<{
      ok: true;
      entry: { label?: string };
    }>(ws, "sessions.patch", {
      key: "agent:main:subagent:one",
      label: "Briefing",
    });
    expect(labelPatched.ok).toBe(true);
    expect(labelPatched.payload?.entry.label).toBe("Briefing");

    const labelPatchedDuplicate = await rpcReq(ws, "sessions.patch", {
      key: "agent:main:discord:group:dev",
      label: "Briefing",
    });
    expect(labelPatchedDuplicate.ok).toBe(false);

    const list2 = await rpcReq<{
      sessions: Array<{
        key: string;
        thinkingLevel?: string;
        verboseLevel?: string;
        sendPolicy?: string;
        label?: string;
      }>;
    }>(ws, "sessions.list", {});
    expect(list2.ok).toBe(true);
    const main2 = list2.payload?.sessions.find(
      (s) => s.key === "agent:main:main",
    );
    expect(main2?.thinkingLevel).toBe("medium");
    expect(main2?.verboseLevel).toBeUndefined();
    expect(main2?.sendPolicy).toBe("deny");
    const subagent = list2.payload?.sessions.find(
      (s) => s.key === "agent:main:subagent:one",
    );
    expect(subagent?.label).toBe("Briefing");

    const listByLabel = await rpcReq<{
      sessions: Array<{ key: string }>;
    }>(ws, "sessions.list", {
      includeGlobal: false,
      includeUnknown: false,
      label: "Briefing",
    });
    expect(listByLabel.ok).toBe(true);
    expect(listByLabel.payload?.sessions.map((s) => s.key)).toEqual([
      "agent:main:subagent:one",
    ]);

    const resolvedByLabel = await rpcReq<{ ok: true; key: string }>(
      ws,
      "sessions.resolve",
      { label: "Briefing", agentId: "main" },
    );
    expect(resolvedByLabel.ok).toBe(true);
    expect(resolvedByLabel.payload?.key).toBe("agent:main:subagent:one");

    const spawnedOnly = await rpcReq<{
      sessions: Array<{ key: string }>;
    }>(ws, "sessions.list", {
      includeGlobal: true,
      includeUnknown: true,
      spawnedBy: "agent:main:main",
    });
    expect(spawnedOnly.ok).toBe(true);
    expect(spawnedOnly.payload?.sessions.map((s) => s.key)).toEqual([
      "agent:main:subagent:one",
    ]);

    const spawnedPatched = await rpcReq<{
      ok: true;
      entry: { spawnedBy?: string };
    }>(ws, "sessions.patch", {
      key: "agent:main:subagent:two",
      spawnedBy: "agent:main:main",
    });
    expect(spawnedPatched.ok).toBe(true);
    expect(spawnedPatched.payload?.entry.spawnedBy).toBe("agent:main:main");

    const spawnedPatchedInvalidKey = await rpcReq(ws, "sessions.patch", {
      key: "agent:main:main",
      spawnedBy: "agent:main:main",
    });
    expect(spawnedPatchedInvalidKey.ok).toBe(false);

    piSdkMock.enabled = true;
    piSdkMock.models = [{ id: "gpt-test-a", name: "A", provider: "openai" }];
    const modelPatched = await rpcReq<{
      ok: true;
      entry: { modelOverride?: string; providerOverride?: string };
    }>(ws, "sessions.patch", {
      key: "agent:main:main",
      model: "openai/gpt-test-a",
    });
    expect(modelPatched.ok).toBe(true);
    expect(modelPatched.payload?.entry.modelOverride).toBe("gpt-test-a");
    expect(modelPatched.payload?.entry.providerOverride).toBe("openai");

    const compacted = await rpcReq<{ ok: true; compacted: boolean }>(
      ws,
      "sessions.compact",
      { key: "agent:main:main", maxLines: 3 },
    );
    expect(compacted.ok).toBe(true);
    expect(compacted.payload?.compacted).toBe(true);
    const compactedLines = (
      await fs.readFile(path.join(dir, "sess-main.jsonl"), "utf-8")
    )
      .split(/\r?\n/)
      .filter((l) => l.trim().length > 0);
    expect(compactedLines).toHaveLength(3);
    const filesAfterCompact = await fs.readdir(dir);
    expect(
      filesAfterCompact.some((f) => f.startsWith("sess-main.jsonl.bak.")),
    ).toBe(true);

    const deleted = await rpcReq<{ ok: true; deleted: boolean }>(
      ws,
      "sessions.delete",
      { key: "agent:main:discord:group:dev" },
    );
    expect(deleted.ok).toBe(true);
    expect(deleted.payload?.deleted).toBe(true);
    const listAfterDelete = await rpcReq<{
      sessions: Array<{ key: string }>;
    }>(ws, "sessions.list", {});
    expect(listAfterDelete.ok).toBe(true);
    expect(
      listAfterDelete.payload?.sessions.some(
        (s) => s.key === "agent:main:discord:group:dev",
      ),
    ).toBe(false);
    const filesAfterDelete = await fs.readdir(dir);
    expect(
      filesAfterDelete.some((f) => f.startsWith("sess-group.jsonl.deleted.")),
    ).toBe(true);

    const reset = await rpcReq<{
      ok: true;
      key: string;
      entry: { sessionId: string };
    }>(ws, "sessions.reset", { key: "agent:main:main" });
    expect(reset.ok).toBe(true);
    expect(reset.payload?.key).toBe("agent:main:main");
    expect(reset.payload?.entry.sessionId).not.toBe("sess-main");

    const badThinking = await rpcReq(ws, "sessions.patch", {
      key: "agent:main:main",
      thinkingLevel: "banana",
    });
    expect(badThinking.ok).toBe(false);
    expect(
      (badThinking.error as { message?: unknown } | undefined)?.message ?? "",
    ).toMatch(/invalid thinkinglevel/i);

    ws.close();
    await server.close();
  });

  test("sessions.delete rejects main and aborts active runs", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-sessions-"));
    const storePath = path.join(dir, "sessions.json");
    testState.sessionStorePath = storePath;

    await fs.writeFile(
      path.join(dir, "sess-main.jsonl"),
      `${JSON.stringify({ role: "user", content: "hello" })}\n`,
      "utf-8",
    );
    await fs.writeFile(
      path.join(dir, "sess-active.jsonl"),
      `${JSON.stringify({ role: "user", content: "active" })}\n`,
      "utf-8",
    );

    await fs.writeFile(
      storePath,
      JSON.stringify(
        {
          main: { sessionId: "sess-main", updatedAt: Date.now() },
          "discord:group:dev": {
            sessionId: "sess-active",
            updatedAt: Date.now(),
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    embeddedRunMock.activeIds.add("sess-active");
    embeddedRunMock.waitResults.set("sess-active", true);

    const { server, ws } = await startServerWithClient();
    await connectOk(ws);

    const mainDelete = await rpcReq(ws, "sessions.delete", { key: "main" });
    expect(mainDelete.ok).toBe(false);

    const deleted = await rpcReq<{ ok: true; deleted: boolean }>(
      ws,
      "sessions.delete",
      { key: "discord:group:dev" },
    );
    expect(deleted.ok).toBe(true);
    expect(deleted.payload?.deleted).toBe(true);
    expect(embeddedRunMock.abortCalls).toEqual(["sess-active"]);
    expect(embeddedRunMock.waitCalls).toEqual(["sess-active"]);

    ws.close();
    await server.close();
  });

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
});
