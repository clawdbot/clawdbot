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
          main: {
            sessionId: "sess-main",
            updatedAt: now - 30_000,
            inputTokens: 10,
            outputTokens: 20,
            thinkingLevel: "low",
            verboseLevel: "on",
          },
          "discord:group:dev": {
            sessionId: "sess-group",
            updatedAt: now - 120_000,
            totalTokens: 50,
          },
          "subagent:one": {
            sessionId: "sess-subagent",
            updatedAt: now - 120_000,
            spawnedBy: "main",
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

    const list1 = await rpcReq<{
      path: string;
      sessions: Array<{
        key: string;
        totalTokens?: number;
        thinkingLevel?: string;
        verboseLevel?: string;
      }>;
    }>(ws, "sessions.list", { includeGlobal: false, includeUnknown: false });

    expect(list1.ok).toBe(true);
    expect(list1.payload?.path).toBe(storePath);
    expect(list1.payload?.sessions.some((s) => s.key === "global")).toBe(false);
    const main = list1.payload?.sessions.find((s) => s.key === "main");
    expect(main?.totalTokens).toBe(30);
    expect(main?.thinkingLevel).toBe("low");
    expect(main?.verboseLevel).toBe("on");

    const active = await rpcReq<{
      sessions: Array<{ key: string }>;
    }>(ws, "sessions.list", {
      includeGlobal: false,
      includeUnknown: false,
      activeMinutes: 1,
    });
    expect(active.ok).toBe(true);
    expect(active.payload?.sessions.map((s) => s.key)).toEqual(["main"]);

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
      { key: "main", thinkingLevel: "medium", verboseLevel: null },
    );
    expect(patched.ok).toBe(true);
    expect(patched.payload?.ok).toBe(true);
    expect(patched.payload?.key).toBe("main");

    const sendPolicyPatched = await rpcReq<{
      ok: true;
      entry: { sendPolicy?: string };
    }>(ws, "sessions.patch", { key: "main", sendPolicy: "deny" });
    expect(sendPolicyPatched.ok).toBe(true);
    expect(sendPolicyPatched.payload?.entry.sendPolicy).toBe("deny");

    const list2 = await rpcReq<{
      sessions: Array<{
        key: string;
        thinkingLevel?: string;
        verboseLevel?: string;
        sendPolicy?: string;
      }>;
    }>(ws, "sessions.list", {});
    expect(list2.ok).toBe(true);
    const main2 = list2.payload?.sessions.find((s) => s.key === "main");
    expect(main2?.thinkingLevel).toBe("medium");
    expect(main2?.verboseLevel).toBeUndefined();
    expect(main2?.sendPolicy).toBe("deny");

    const spawnedOnly = await rpcReq<{
      sessions: Array<{ key: string }>;
    }>(ws, "sessions.list", {
      includeGlobal: true,
      includeUnknown: true,
      spawnedBy: "main",
    });
    expect(spawnedOnly.ok).toBe(true);
    expect(spawnedOnly.payload?.sessions.map((s) => s.key)).toEqual([
      "subagent:one",
    ]);

    const spawnedPatched = await rpcReq<{
      ok: true;
      entry: { spawnedBy?: string };
    }>(ws, "sessions.patch", { key: "subagent:two", spawnedBy: "main" });
    expect(spawnedPatched.ok).toBe(true);
    expect(spawnedPatched.payload?.entry.spawnedBy).toBe("main");

    const spawnedPatchedInvalidKey = await rpcReq(ws, "sessions.patch", {
      key: "main",
      spawnedBy: "main",
    });
    expect(spawnedPatchedInvalidKey.ok).toBe(false);

    piSdkMock.enabled = true;
    piSdkMock.models = [{ id: "gpt-test-a", name: "A", provider: "openai" }];
    const modelPatched = await rpcReq<{
      ok: true;
      entry: { modelOverride?: string; providerOverride?: string };
    }>(ws, "sessions.patch", { key: "main", model: "openai/gpt-test-a" });
    expect(modelPatched.ok).toBe(true);
    expect(modelPatched.payload?.entry.modelOverride).toBe("gpt-test-a");
    expect(modelPatched.payload?.entry.providerOverride).toBe("openai");

    const compacted = await rpcReq<{ ok: true; compacted: boolean }>(
      ws,
      "sessions.compact",
      { key: "main", maxLines: 3 },
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
      { key: "discord:group:dev" },
    );
    expect(deleted.ok).toBe(true);
    expect(deleted.payload?.deleted).toBe(true);
    const listAfterDelete = await rpcReq<{
      sessions: Array<{ key: string }>;
    }>(ws, "sessions.list", {});
    expect(listAfterDelete.ok).toBe(true);
    expect(
      listAfterDelete.payload?.sessions.some(
        (s) => s.key === "discord:group:dev",
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
    }>(ws, "sessions.reset", { key: "main" });
    expect(reset.ok).toBe(true);
    expect(reset.payload?.key).toBe("main");
    expect(reset.payload?.entry.sessionId).not.toBe("sess-main");

    const badThinking = await rpcReq(ws, "sessions.patch", {
      key: "main",
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
});
