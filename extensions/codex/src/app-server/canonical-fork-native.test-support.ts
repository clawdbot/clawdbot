import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import { vi } from "vitest";
import { codexAppInventoryResponse } from "./app-inventory.test-helpers.js";
import { CodexAppServerClient } from "./client.js";
import { createCodexDesktopGenerationOwner } from "./desktop-generation-owner.js";
import * as desktopGenerationRuntime from "./desktop-generation.js";
import * as managedBinary from "./managed-binary.js";
import {
  isJsonObject,
  type CodexThread,
  type CodexTurn,
  type JsonObject,
  type JsonValue,
} from "./protocol.js";
import { codexForkTurn, forkResponse } from "./upstream-session-fork.test-support.js";

/** External transport/discovery is synthetic; clients, metadata, handshakes and leases are real. */
export async function createCanonicalForkNativeFixture(
  home: string,
  cwd: string,
  historyMode: "legacy" | "paginated" = "legacy",
  desktopGenerationFingerprint?: string,
) {
  const sessionsRoot = path.join(home, "sessions");
  await fs.mkdir(sessionsRoot, { recursive: true });
  type NativeThread = {
    thread: CodexThread;
    model: string;
    rawPrefix: JsonValue[];
    dynamicTools: JsonValue;
    config?: JsonObject;
    developerInstructions?: string;
  };
  const threads = new Map<string, NativeThread>();
  const calls: Array<{ client: number; method: string; params: Record<string, unknown> }> = [];
  const clients: CodexAppServerClient[] = [];
  const subscriptions = new Set<string>();
  let ignoreCut = false;
  let competingSubscriber = false;
  let failUnsubscribe = false;
  let forkFault: "model" | "catalog" | "lineage" | undefined;
  let sequence = 0;
  let afterPolicyWrite: ((threadId: string) => Promise<void> | void) | undefined;
  let policyFault: "rpc" | "disconnect" | undefined;
  let archivedNotifications: Array<() => void> | undefined;
  let afterFork: ((threadId: string) => Promise<void> | void) | undefined;
  let overload: { method: string; onReject: () => Promise<void> | void } | undefined;
  const persist = async (value: NativeThread) => {
    const lines = [
      {
        type: "session_meta",
        payload: {
          id: value.thread.id,
          source: value.thread.source,
          model_provider: value.thread.modelProvider,
          dynamic_tools: value.dynamicTools,
        },
      },
      {
        type: "event_msg",
        payload: {
          type: "thread_settings_applied",
          thread_settings: { model: value.model, model_provider_id: value.thread.modelProvider },
        },
      },
    ];
    await fs.writeFile(
      expectDefined(value.thread.path, "rollout path"),
      lines.map((line) => JSON.stringify(line)).join("\n") + "\n",
    );
  };
  const create = async (id: string, turns: CodexTurn[], parent: string | null = null) => {
    const value: NativeThread = {
      thread: {
        ...forkResponse(id).thread,
        forkedFromId: parent,
        path: path.join(sessionsRoot, `${id}.jsonl`),
        cwd,
        historyMode,
        turns,
      },
      model: "gpt-5.6-luna",
      rawPrefix: [],
      dynamicTools: [],
    };
    threads.set(id, value);
    await persist(value);
    return value;
  };
  const source = await create("original", [
    codexForkTurn("original-1", "inherited one"),
    codexForkTurn("original-2", "inherited two"),
  ]);
  const desktopGeneration = desktopGenerationFingerprint
    ? createCodexDesktopGenerationOwner({
        initialGeneration: { epoch: 1, fingerprint: desktopGenerationFingerprint },
        readFingerprint: async () => desktopGenerationFingerprint,
      })
    : undefined;
  const desktopMocks = desktopGeneration
    ? [
        vi
          .spyOn(desktopGenerationRuntime, "waitForCodexDesktopGeneration")
          .mockImplementation(desktopGeneration.wait),
        vi
          .spyOn(desktopGenerationRuntime, "isCodexDesktopGenerationCurrent")
          .mockImplementation(desktopGeneration.isCurrent),
        vi
          .spyOn(managedBinary, "isManagedCodexDesktopCommand")
          .mockImplementation((command) => command === process.execPath),
      ]
    : [];
  const spawn = vi.spyOn(CodexAppServerClient, "start").mockImplementation(() => {
    const clientIndex = clients.length;
    const loaded = new Set<string>();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const process = new EventEmitter();
    const send = (value: unknown) => stdout.write(JSON.stringify(value) + "\n");
    const response = (value: NativeThread) => ({
      ...forkResponse(value.thread.id),
      model: value.model,
      modelProvider: value.thread.modelProvider,
      ...(historyMode === "paginated"
        ? {
            initialTurnsPage: {
              data: value.thread.turns ?? [],
              nextCursor: null,
              backwardsCursor: null,
            },
          }
        : {}),
      thread: {
        ...value.thread,
        ...(historyMode === "paginated" ? { turns: [] } : {}),
        status: { type: loaded.has(value.thread.id) ? "idle" : "notLoaded" },
      },
    });
    const request = async (method: string, params: Record<string, unknown>): Promise<unknown> => {
      calls.push({ client: clientIndex, method, params });
      if (overload?.method === method) {
        const rejection = overload;
        overload = undefined;
        await rejection.onReject();
        throw Object.assign(new Error("Native ingress overloaded"), { code: -32001 });
      }
      if (method === "initialize") {
        return {
          userAgent: "codex-cli/0.151.0",
          codexHome: home,
        };
      }
      if (method === "initialized") {
        return {};
      }
      if (method === "skills/list") {
        return { data: [] };
      }
      if (method === "configRequirements/read") {
        return { requirements: null };
      }
      if (method === "config/read") {
        return { config: {}, layers: [] };
      }
      if (method === "app/installed" || method === "app/read") {
        if (typeof params.threadId === "string" && !loaded.has(params.threadId)) {
          throw Object.assign(new Error(`thread not found: ${params.threadId}`), { code: -32600 });
        }
        const apps = threads.get(String(params.threadId))?.config?.apps;
        const app = isJsonObject(apps) ? apps["synthetic-app"] : undefined;
        return codexAppInventoryResponse(method, [
          {
            id: "synthetic-app",
            name: "Synthetic App",
            description: null,
            logoUrl: null,
            logoUrlDark: null,
            distributionChannel: null,
            branding: null,
            appMetadata: null,
            labels: null,
            installUrl: null,
            isAccessible: true,
            isEnabled: isJsonObject(app) && app.enabled === true,
            pluginDisplayNames: [],
          },
        ]);
      }
      if (method === "modelProvider/capabilities/read") {
        return { webSearch: true };
      }
      if (method === "thread/list") {
        return {
          data: [...threads.values()].map((value) => response(value).thread),
          nextCursor: null,
        };
      }
      if (method === "thread/start") {
        const value = await create(`native-${sequence++}`, []);
        value.config = isJsonObject(params.config) ? params.config : undefined;
        value.model = typeof params.model === "string" ? params.model : "gpt-5.5";
        value.dynamicTools = Array.isArray(params.dynamicTools) ? params.dynamicTools : [];
        value.developerInstructions =
          typeof params.developerInstructions === "string"
            ? params.developerInstructions
            : undefined;
        loaded.add(value.thread.id);
        subscriptions.add(`${clientIndex}:${value.thread.id}`);
        await persist(value);
        return response(value);
      }
      const id = typeof params.threadId === "string" ? params.threadId : "";
      const value = threads.get(id);
      if (!value) {
        throw new Error(`Unknown native thread: ${id}`);
      }
      if (method === "thread/read") {
        const result = response(value);
        return params.includeTurns === true
          ? { ...result, thread: { ...result.thread, turns: value.thread.turns } }
          : result;
      }
      if (method === "thread/turns/list") {
        const turns = [...(value.thread.turns ?? [])];
        if (params.sortDirection === "desc") {
          turns.reverse();
        }
        const offset = typeof params.cursor === "string" ? Number(params.cursor) : 0;
        const limit =
          historyMode === "paginated"
            ? 1
            : typeof params.limit === "number"
              ? params.limit
              : turns.length;
        return {
          data: turns.slice(offset, offset + limit),
          nextCursor: offset + limit < turns.length ? String(offset + limit) : null,
        };
      }
      if (method === "thread/resume") {
        if (loaded.has(id) && !subscriptions.has(`${clientIndex}:${id}`) && !competingSubscriber) {
          loaded.delete(id);
          send({
            method: "thread/status/changed",
            params: { threadId: id, status: { type: "notLoaded" } },
          });
        }
        if (!loaded.has(id)) {
          value.config = isJsonObject(params.config) ? params.config : undefined;
          value.developerInstructions =
            typeof params.developerInstructions === "string"
              ? params.developerInstructions
              : value.developerInstructions;
        }
        loaded.add(id);
        subscriptions.add(`${clientIndex}:${id}`);
        return response(value);
      }
      if (method === "thread/fork") {
        const turns = value.thread.turns ?? [];
        const before =
          typeof params.beforeTurnId === "string"
            ? turns.findIndex((turn) => turn.id === params.beforeTurnId)
            : undefined;
        const last =
          typeof params.lastTurnId === "string"
            ? turns.findIndex((turn) => turn.id === params.lastTurnId)
            : undefined;
        const retained = ignoreCut
          ? turns
          : before !== undefined
            ? turns.slice(0, before)
            : last !== undefined
              ? turns.slice(0, last + 1)
              : turns;
        const child = await create(`native-${sequence++}`, structuredClone(retained), id);
        child.config = isJsonObject(params.config) ? params.config : undefined;
        child.model = typeof params.model === "string" ? params.model : "gpt-5.6-luna";
        child.rawPrefix = structuredClone(value.rawPrefix);
        child.dynamicTools = structuredClone(value.dynamicTools);
        child.developerInstructions =
          typeof params.developerInstructions === "string"
            ? params.developerInstructions
            : value.developerInstructions;
        if (forkFault === "model") {
          child.model = "wrong-native-model";
        }
        if (forkFault === "catalog") {
          child.dynamicTools = [];
        }
        if (forkFault === "lineage") {
          child.thread.forkedFromId = "another-parent";
        }
        loaded.add(child.thread.id);
        subscriptions.add(`${clientIndex}:${child.thread.id}`);
        await persist(child);
        await afterFork?.(child.thread.id);
        return response(child);
      }
      if (method === "thread/inject_items") {
        if (!Array.isArray(params.items)) {
          throw new Error("Invalid injected history");
        }
        value.rawPrefix.push(...params.items);
        if (params.items.some((item) => isJsonObject(item) && item.role === "developer")) {
          await afterPolicyWrite?.(id);
          const fault = policyFault;
          policyFault = undefined;
          if (fault === "disconnect") {
            process.emit("exit", 1, null);
          }
          if (fault) {
            throw new Error("policy flush failed after append");
          }
        }
        return {};
      }
      if (method === "thread/unsubscribe") {
        if (failUnsubscribe) {
          throw new Error("Native unsubscribe fault");
        }
        subscriptions.delete(`${clientIndex}:${id}`);
        return { status: "unsubscribed" };
      }
      if (method === "thread/archive") {
        threads.delete(id);
        subscriptions.delete(`${clientIndex}:${id}`);
        loaded.delete(id);
        return {};
      }
      if (method === "turn/start") {
        const text = Array.isArray(params.input)
          ? params.input
              .map((item) => (isJsonObject(item) && typeof item.text === "string" ? item.text : ""))
              .join("\n")
          : "";
        const turn = codexForkTurn(`turn-${sequence++}`, text);
        value.thread.turns = [...(value.thread.turns ?? []), turn];
        await persist(value);
        return { turn };
      }
      throw new Error(`Unexpected native request: ${method}`);
    };
    const stdin = new Writable({
      write(chunk, _encoding, callback) {
        const message = JSON.parse(chunk.toString());
        void request(message.method, message.params ?? {}).then(
          (result) => {
            if (message.id !== undefined) {
              send({ id: message.id, result });
              if (message.method === "thread/archive") {
                const notify = () =>
                  send({
                    method: "thread/archived",
                    params: { threadId: message.params.threadId },
                  });
                if (archivedNotifications) {
                  archivedNotifications.push(notify);
                } else {
                  notify();
                }
              }
            }
            callback();
          },
          (error: unknown) => {
            send({
              id: message.id,
              error: {
                code: error instanceof Error && "code" in error ? error.code : -32000,
                message: error instanceof Error ? error.message : String(error),
              },
            });
            callback();
          },
        );
      },
    });
    const transport = Object.assign(process, {
      stdin,
      stdout,
      stderr,
      exitCode: null as number | null,
      kill: () => {},
    });
    stdin.on("close", () => {
      transport.exitCode = 0;
      for (const key of subscriptions) {
        if (key.startsWith(`${clientIndex}:`)) {
          subscriptions.delete(key);
        }
      }
      process.emit("exit", 0, null);
    });
    const client = CodexAppServerClient.fromTransportForTests(transport);
    clients.push(client);
    return Promise.resolve(client);
  });
  return {
    home,
    sessionsRoot,
    source,
    threads,
    calls,
    subscriptions,
    persist,
    holdArchiveNotifications: () => {
      const pending: Array<() => void> = [];
      archivedNotifications = pending;
      return () => {
        archivedNotifications = undefined;
        for (const notify of pending.splice(0)) {
          notify();
        }
      };
    },
    setAfterFork: (next: typeof afterFork) => {
      afterFork = next;
    },
    rejectNext: (method: string, onReject: () => Promise<void> | void) => {
      overload = { method, onReject };
    },
    setAfterPolicyWrite: (next: typeof afterPolicyWrite) => {
      afterPolicyWrite = next;
    },
    setPolicyFault: (next: typeof policyFault) => {
      policyFault = next;
    },
    setIgnoreCut: (next: boolean) => {
      ignoreCut = next;
    },
    setCompetingSubscriber: (next: boolean) => {
      competingSubscriber = next;
    },
    setFailUnsubscribe: (next: boolean) => {
      failUnsubscribe = next;
    },
    setForkFault: (next: typeof forkFault) => {
      forkFault = next;
    },
    async restart() {
      await Promise.all(clients.map((client) => client.closeAndWait()));
    },
    async dispose() {
      await Promise.all(clients.map((client) => client.closeAndWait()));
      spawn.mockRestore();
      for (const mock of desktopMocks) {
        mock.mockRestore();
      }
      desktopGeneration?.stop();
    },
  };
}
