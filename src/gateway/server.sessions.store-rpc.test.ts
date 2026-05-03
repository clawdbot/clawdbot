import fs from "node:fs/promises";
import path from "node:path";
import { expect, test, vi } from "vitest";
import { piSdkMock, rpcReq, writeSessionStore } from "./test-helpers.js";
import {
  setupGatewaySessionsTestHarness,
  getGatewayConfigModule,
  getSessionsHandlers,
} from "./test/server-sessions.test-helpers.js";

const { createSessionStoreDir, openClient } = setupGatewaySessionsTestHarness();

test("lists and patches session store via sessions.* RPC", async () => {
  const { dir, storePath } = await createSessionStoreDir();
  const now = Date.now();
  const recent = now - 30_000;
  const stale = now - 15 * 60_000;

  await fs.writeFile(
    path.join(dir, "sess-main.jsonl"),
    `${Array.from({ length: 10 })
      .map((_, idx) => JSON.stringify({ role: "user", content: `line ${idx}` }))
      .join("\n")}\n`,
    "utf-8",
  );
  await fs.writeFile(
    path.join(dir, "sess-group.jsonl"),
    `${JSON.stringify({ role: "user", content: "group line 0" })}\n`,
    "utf-8",
  );

  await writeSessionStore({
    entries: {
      main: {
        sessionId: "sess-main",
        updatedAt: recent,
        modelProvider: "anthropic",
        model: "claude-sonnet-4-6",
        inputTokens: 10,
        outputTokens: 20,
        thinkingLevel: "low",
        verboseLevel: "on",
        lastChannel: "whatsapp",
        lastTo: "+1555",
        lastAccountId: "work",
        lastThreadId: "1737500000.123456",
      },
      "discord:group:dev": {
        sessionId: "sess-group",
        updatedAt: stale,
        totalTokens: 50,
      },
      "agent:main:subagent:one": {
        sessionId: "sess-subagent",
        updatedAt: stale,
        spawnedBy: "agent:main:main",
      },
      global: {
        sessionId: "sess-global",
        updatedAt: now - 10_000,
      },
    },
  });

  const { ws, hello } = await openClient();
  expect((hello as { features?: { methods?: string[] } }).features?.methods).toEqual(
    expect.arrayContaining([
      "sessions.list",
      "sessions.preview",
      "sessions.cleanup",
      "sessions.patch",
      "sessions.reset",
      "sessions.delete",
      "sessions.compact",
    ]),
  );
  const sessionsHandlers = await getSessionsHandlers();
  const { getRuntimeConfig } = await getGatewayConfigModule();
  const directContext = {
    broadcastToConnIds: vi.fn(),
    getSessionEventSubscriberConnIds: () => new Set<string>(),
    logGateway: { debug: vi.fn() },
    loadGatewayModelCatalog: async () => piSdkMock.models,
    getRuntimeConfig: getRuntimeConfig,
  } as never;
  async function directSessionReq<TPayload = unknown>(
    method: keyof typeof sessionsHandlers,
    params: Record<string, unknown>,
    coercePayload?: (payload: unknown) => TPayload,
  ): Promise<{ ok: boolean; payload?: TPayload; error?: unknown }> {
    let result:
      | {
          ok: boolean;
          payload?: TPayload;
          error?: unknown;
        }
      | undefined;
    await sessionsHandlers[method]({
      req: {} as never,
      params,
      respond: (ok, payload, error) => {
        result = {
          ok,
          payload:
            payload === undefined
              ? undefined
              : coercePayload
                ? coercePayload(payload)
                : (payload as TPayload),
          error,
        };
      },
      context: directContext,
      client: null,
      isWebchatConnect: () => false,
    });
    if (!result) {
      throw new Error(`${method} did not respond`);
    }
    return result;
  }

  const resolvedByKey = await rpcReq<{ ok: true; key: string }>(ws, "sessions.resolve", {
    key: "main",
  });
  expect(resolvedByKey.ok).toBe(true);
  expect(resolvedByKey.payload?.key).toBe("agent:main:main");

  const resolvedBySessionId = await rpcReq<{ ok: true; key: string }>(ws, "sessions.resolve", {
    sessionId: "sess-group",
  });
  expect(resolvedBySessionId.ok).toBe(true);
  expect(resolvedBySessionId.payload?.key).toBe("agent:main:discord:group:dev");
  ws.close();

  const list1 = await directSessionReq<{
    path: string;
    defaults?: { model?: string | null; modelProvider?: string | null };
    sessions: Array<{
      key: string;
      totalTokens?: number;
      totalTokensFresh?: boolean;
      thinkingLevel?: string;
      verboseLevel?: string;
      lastAccountId?: string;
      deliveryContext?: { channel?: string; to?: string; accountId?: string };
    }>;
  }>("sessions.list", { includeGlobal: false, includeUnknown: false });

  expect(list1.ok).toBe(true);
  expect(list1.payload?.path).toBe(storePath);
  expect(list1.payload?.sessions.some((s) => s.key === "global")).toBe(false);
  expect(list1.payload?.defaults?.modelProvider).toBe("anthropic");
  const main = list1.payload?.sessions.find((s) => s.key === "agent:main:main");
  expect(main?.totalTokens).toBeUndefined();
  expect(main?.totalTokensFresh).toBe(false);
  expect(main?.thinkingLevel).toBe("low");
  expect(main?.verboseLevel).toBe("on");
  expect(main?.lastAccountId).toBe("work");
  expect(main?.deliveryContext).toEqual({
    channel: "whatsapp",
    to: "+1555",
    accountId: "work",
    threadId: "1737500000.123456",
  });

  const active = await directSessionReq<{
    sessions: Array<{ key: string }>;
  }>("sessions.list", {
    includeGlobal: false,
    includeUnknown: false,
    activeMinutes: 5,
  });
  expect(active.ok).toBe(true);
  expect(active.payload?.sessions.map((s) => s.key)).toEqual(["agent:main:main"]);

  const limited = await directSessionReq<{
    sessions: Array<{ key: string }>;
  }>("sessions.list", {
    includeGlobal: true,
    includeUnknown: false,
    limit: 1,
  });
  expect(limited.ok).toBe(true);
  expect(limited.payload?.sessions).toHaveLength(1);
  expect(limited.payload?.sessions[0]?.key).toBe("global");

  const patched = await directSessionReq<{ ok: true; key: string }>("sessions.patch", {
    key: "agent:main:main",
    thinkingLevel: "medium",
    verboseLevel: "off",
  });
  expect(patched.ok).toBe(true);
  expect(patched.payload?.ok).toBe(true);
  expect(patched.payload?.key).toBe("agent:main:main");

  const sendPolicyPatched = await directSessionReq<{
    ok: true;
    entry: { sendPolicy?: string };
  }>("sessions.patch", { key: "agent:main:main", sendPolicy: "deny" });
  expect(sendPolicyPatched.ok).toBe(true);
  expect(sendPolicyPatched.payload?.entry.sendPolicy).toBe("deny");

  const labelPatched = await directSessionReq<{
    ok: true;
    entry: { label?: string };
  }>("sessions.patch", {
    key: "agent:main:subagent:one",
    label: "Briefing",
  });
  expect(labelPatched.ok).toBe(true);
  expect(labelPatched.payload?.entry.label).toBe("Briefing");

  const labelPatchedDuplicate = await directSessionReq("sessions.patch", {
    key: "agent:main:discord:group:dev",
    label: "Briefing",
  });
  expect(labelPatchedDuplicate.ok).toBe(false);

  const list2 = await directSessionReq<{
    sessions: Array<{
      key: string;
      thinkingLevel?: string;
      verboseLevel?: string;
      sendPolicy?: string;
      label?: string;
      displayName?: string;
    }>;
  }>("sessions.list", {});
  expect(list2.ok).toBe(true);
  const main2 = list2.payload?.sessions.find((s) => s.key === "agent:main:main");
  expect(main2?.thinkingLevel).toBe("medium");
  expect(main2?.verboseLevel).toBe("off");
  expect(main2?.sendPolicy).toBe("deny");
  const subagent = list2.payload?.sessions.find((s) => s.key === "agent:main:subagent:one");
  expect(subagent?.label).toBe("Briefing");
  expect(subagent?.displayName).toBe("Briefing");

  const clearedVerbose = await directSessionReq<{ ok: true; key: string }>("sessions.patch", {
    key: "agent:main:main",
    verboseLevel: null,
  });
  expect(clearedVerbose.ok).toBe(true);

  const list3 = await directSessionReq<{
    sessions: Array<{
      key: string;
      verboseLevel?: string;
    }>;
  }>("sessions.list", {});
  expect(list3.ok).toBe(true);
  const main3 = list3.payload?.sessions.find((s) => s.key === "agent:main:main");
  expect(main3?.verboseLevel).toBeUndefined();

  const listByLabel = await directSessionReq<{
    sessions: Array<{ key: string }>;
  }>("sessions.list", {
    includeGlobal: false,
    includeUnknown: false,
    label: "Briefing",
  });
  expect(listByLabel.ok).toBe(true);
  expect(listByLabel.payload?.sessions.map((s) => s.key)).toEqual(["agent:main:subagent:one"]);

  const resolvedByLabel = await directSessionReq<{ ok: true; key: string }>("sessions.resolve", {
    label: "Briefing",
    agentId: "main",
  });
  expect(resolvedByLabel.ok).toBe(true);
  expect(resolvedByLabel.payload?.key).toBe("agent:main:subagent:one");

  const spawnedOnly = await directSessionReq<{
    sessions: Array<{ key: string }>;
  }>("sessions.list", {
    includeGlobal: true,
    includeUnknown: true,
    spawnedBy: "agent:main:main",
  });
  expect(spawnedOnly.ok).toBe(true);
  expect(spawnedOnly.payload?.sessions.map((s) => s.key)).toEqual(["agent:main:subagent:one"]);

  const spawnedPatched = await directSessionReq<{
    ok: true;
    entry: { spawnedBy?: string };
  }>("sessions.patch", {
    key: "agent:main:subagent:two",
    spawnedBy: "agent:main:main",
  });
  expect(spawnedPatched.ok).toBe(true);
  expect(spawnedPatched.payload?.entry.spawnedBy).toBe("agent:main:main");

  const acpPatched = await directSessionReq<{
    ok: true;
    entry: { spawnedBy?: string; spawnDepth?: number };
  }>("sessions.patch", {
    key: "agent:main:acp:child",
    spawnedBy: "agent:main:main",
    spawnDepth: 1,
  });
  expect(acpPatched.ok).toBe(true);
  expect(acpPatched.payload?.entry.spawnedBy).toBe("agent:main:main");
  expect(acpPatched.payload?.entry.spawnDepth).toBe(1);

  const spawnedPatchedInvalidKey = await directSessionReq("sessions.patch", {
    key: "agent:main:main",
    spawnedBy: "agent:main:main",
  });
  expect(spawnedPatchedInvalidKey.ok).toBe(false);

  const cleaned = await directSessionReq<{
    applied: true;
    missing: number;
    appliedCount: number;
  }>("sessions.cleanup", {
    enforce: true,
    fixMissing: true,
  });
  expect(cleaned.ok).toBe(true);
  expect(cleaned.payload?.missing).toBeGreaterThanOrEqual(1);
  const listAfterCleanup = await directSessionReq<{
    sessions: Array<{ key: string }>;
  }>("sessions.list", {});
  expect(listAfterCleanup.payload?.sessions.some((s) => s.key === "agent:main:subagent:one")).toBe(
    false,
  );

  piSdkMock.enabled = true;
  piSdkMock.models = [{ id: "gpt-test-a", name: "A", provider: "openai" }];
  const modelPatched = await directSessionReq<{
    ok: true;
    entry: {
      modelOverride?: string;
      providerOverride?: string;
      model?: string;
      modelProvider?: string;
    };
    resolved?: {
      model?: string;
      modelProvider?: string;
      agentRuntime?: { id: string; source: string };
    };
  }>("sessions.patch", {
    key: "agent:main:main",
    model: "openai/gpt-test-a",
  });
  expect(modelPatched.ok).toBe(true);
  expect(modelPatched.payload?.entry.modelOverride).toBe("gpt-test-a");
  expect(modelPatched.payload?.entry.providerOverride).toBe("openai");
  expect(modelPatched.payload?.entry.model).toBeUndefined();
  expect(modelPatched.payload?.entry.modelProvider).toBeUndefined();
  expect(modelPatched.payload?.resolved?.modelProvider).toBe("openai");
  expect(modelPatched.payload?.resolved?.model).toBe("gpt-test-a");
  expect(modelPatched.payload?.resolved?.agentRuntime).toEqual({
    id: "pi",
    source: "implicit",
  });

  const listAfterModelPatch = await directSessionReq<{
    sessions: Array<{
      key: string;
      modelProvider?: string;
      model?: string;
      agentRuntime?: { id: string; source: string };
    }>;
  }>("sessions.list", {});
  expect(listAfterModelPatch.ok).toBe(true);
  const mainAfterModelPatch = listAfterModelPatch.payload?.sessions.find(
    (session) => session.key === "agent:main:main",
  );
  expect(mainAfterModelPatch?.modelProvider).toBe("openai");
  expect(mainAfterModelPatch?.model).toBe("gpt-test-a");
  expect(mainAfterModelPatch?.agentRuntime).toEqual({ id: "pi", source: "implicit" });

  const compacted = await directSessionReq<{ ok: true; compacted: boolean }>("sessions.compact", {
    key: "agent:main:main",
    maxLines: 3,
  });
  expect(compacted.ok).toBe(true);
  expect(compacted.payload?.compacted).toBe(true);
  const compactedLines = (await fs.readFile(path.join(dir, "sess-main.jsonl"), "utf-8"))
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0);
  expect(compactedLines).toHaveLength(3);
  const filesAfterCompact = await fs.readdir(dir);
  expect(filesAfterCompact.some((f) => f.startsWith("sess-main.jsonl.bak."))).toBe(true);

  const deleted = await directSessionReq<{ ok: true; deleted: boolean }>("sessions.delete", {
    key: "agent:main:discord:group:dev",
  });
  expect(deleted.ok).toBe(true);
  expect(deleted.payload?.deleted).toBe(true);
  const listAfterDelete = await directSessionReq<{
    sessions: Array<{ key: string }>;
  }>("sessions.list", {});
  expect(listAfterDelete.ok).toBe(true);
  expect(
    listAfterDelete.payload?.sessions.some((s) => s.key === "agent:main:discord:group:dev"),
  ).toBe(false);
  const filesAfterDelete = await fs.readdir(dir);
  expect(filesAfterDelete.some((f) => f.startsWith("sess-group.jsonl.deleted."))).toBe(true);

  const reset = await directSessionReq<{
    ok: true;
    key: string;
    entry: {
      sessionId: string;
      modelProvider?: string;
      model?: string;
      lastAccountId?: string;
      lastThreadId?: string | number;
    };
  }>("sessions.reset", { key: "agent:main:main" });
  expect(reset.ok).toBe(true);
  expect(reset.payload?.key).toBe("agent:main:main");
  expect(reset.payload?.entry.sessionId).not.toBe("sess-main");
  expect(reset.payload?.entry.modelProvider).toBe("openai");
  expect(reset.payload?.entry.model).toBe("gpt-test-a");
  expect(reset.payload?.entry.lastAccountId).toBe("work");
  expect(reset.payload?.entry.lastThreadId).toBe("1737500000.123456");
  const storeAfterReset = JSON.parse(await fs.readFile(storePath, "utf-8")) as Record<
    string,
    { lastAccountId?: string; lastThreadId?: string | number }
  >;
  expect(storeAfterReset["agent:main:main"]?.lastAccountId).toBe("work");
  expect(storeAfterReset["agent:main:main"]?.lastThreadId).toBe("1737500000.123456");
  const filesAfterReset = await fs.readdir(dir);
  expect(filesAfterReset.some((f) => f.startsWith("sess-main.jsonl.reset."))).toBe(true);

  const badThinking = await directSessionReq("sessions.patch", {
    key: "agent:main:main",
    thinkingLevel: "banana",
  });
  expect(badThinking.ok).toBe(false);
  expect((badThinking.error as { message?: unknown } | undefined)?.message ?? "").toMatch(
    /invalid thinkinglevel/i,
  );
});
