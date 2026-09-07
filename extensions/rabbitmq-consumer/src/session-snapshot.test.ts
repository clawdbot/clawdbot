import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PluginRuntime } from "../api.js";
import { prepareHistorySessionSnapshot } from "./session-snapshot.js";

type Entry = { sessionId: string; sessionFile?: string; updatedAt: number };
const mocks = vi.hoisted(() => ({
  store: {} as Record<string, Entry>,
  lock: vi.fn(async () => ({ release: async () => {} })),
}));
vi.mock("./session-snapshot.runtime-api.js", () => ({
  acquireSessionWriteLock: mocks.lock,
  updateSessionStore: async (
    _path: string,
    mutate: (store: Record<string, Entry>) => Promise<string>,
  ) => mutate(mocks.store),
}));

let root: string;
const userId = "1749";
const agentId = "rabbitmq-1749";
const sessionId = "session_example";
const sessionKey = `agent:${agentId}:rabbitmq:${userId}:${sessionId}`;
let sessions: PluginRuntime["agent"]["session"];

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "history-snapshots-"));
  mocks.store = {};
  sessions = {
    resolveStorePath: () => path.join(root, "sessions.json"),
    resolveSessionFilePath: (id, entry) => entry?.sessionFile ?? path.join(root, `${id}.jsonl`),
  } as PluginRuntime["agent"]["session"];
});
afterEach(async () => {
  vi.clearAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

const prepare = (id: number, group = sessionId) =>
  prepareHistorySessionSnapshot({
    history: { id, sessionId: group, userId },
    userId,
    agentId,
    sessionKey: `agent:${agentId}:rabbitmq:${userId}:${group}`,
    sessions,
  });

function appendExchange(file: string, question: string, answer: string) {
  const manager = SessionManager.open(file);
  manager.appendMessage({ role: "user", content: question, timestamp: Date.now() });
  manager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: answer }],
    api: "openai-responses",
    provider: "openai",
    model: "gpt-5.4",
    stopReason: "stop",
    timestamp: Date.now(),
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  });
}

it("uses the business session directory and row id without precreating a broken Pi header", async () => {
  const file = await prepare(123);
  expect(file).toBe(path.join(root, sessionId, "123.jsonl"));
  expect(mocks.store[sessionKey]?.sessionFile).toBe(file);
  await expect(fs.stat(file)).rejects.toMatchObject({ code: "ENOENT" });
  appendExchange(file, "First question", "First answer");
  expect(SessionManager.open(file).buildSessionContext().messages).toHaveLength(2);
});

it("copies legacy context forward without migrating old files and freezes each previous snapshot", async () => {
  const legacy = path.join(root, "legacy-uuid.jsonl");
  appendExchange(legacy, "Legacy question", "Legacy answer");
  const original = await fs.readFile(legacy, "utf8");
  const internalId = randomUUID();
  mocks.store[sessionKey] = { sessionId: internalId, sessionFile: legacy, updatedAt: 1 };
  const first = await prepare(123);
  expect(await fs.readFile(first, "utf8")).toBe(original);
  appendExchange(first, "Next question", "Next answer");
  const firstBytes = await fs.readFile(first, "utf8");
  const second = await prepare(124);
  expect(await fs.readFile(second, "utf8")).toBe(firstBytes);
  expect(SessionManager.open(second).buildSessionContext().messages).toHaveLength(4);
  appendExchange(second, "Third question", "Third answer");
  expect(SessionManager.open(second).buildSessionContext().messages).toHaveLength(6);
  expect((await fs.readFile(second, "utf8")).startsWith(firstBytes)).toBe(true);
  expect(await fs.readFile(first, "utf8")).toBe(firstBytes);
  expect(await fs.readFile(legacy, "utf8")).toBe(original);
  expect(mocks.store[sessionKey]?.sessionId).toBe(internalId);
  expect(mocks.store[sessionKey]?.sessionFile).toBe(second);
});

it.each(["-nanoid-session", "_nanoid-session"])("supports session id %s", async (group) => {
  expect(await prepare(123, group)).toBe(path.join(root, group, "123.jsonl"));
});

it("retries its active snapshot but refuses to overwrite an older row", async () => {
  const first = await prepare(123);
  appendExchange(first, "Q", "A");
  const bytes = await fs.readFile(first, "utf8");
  expect(await prepare(123)).toBe(first);
  expect(await fs.readFile(first, "utf8")).toBe(bytes);
  const second = await prepare(124);
  await expect(prepare(123)).rejects.toThrow("refusing to overwrite");
  expect(mocks.store[sessionKey]?.sessionFile).toBe(second);
});

it("keeps the active snapshot selected if the previous transcript is still locked", async () => {
  const first = await prepare(123);
  appendExchange(first, "Q", "A");
  const bytes = await fs.readFile(first, "utf8");
  mocks.lock.mockRejectedValueOnce(new Error("session file locked"));
  await expect(prepare(124)).rejects.toThrow("session file locked");
  expect(mocks.store[sessionKey]?.sessionFile).toBe(first);
  expect(await fs.readFile(first, "utf8")).toBe(bytes);
  await expect(fs.stat(path.join(root, sessionId, "124.jsonl"))).rejects.toMatchObject({
    code: "ENOENT",
  });
});

it("rejects a hard-linked target without changing either transcript", async () => {
  const first = await prepare(123);
  appendExchange(first, "Q", "A");
  const bytes = await fs.readFile(first, "utf8");
  const target = path.join(root, sessionId, "124.jsonl");
  await fs.link(first, target);
  await expect(prepare(124)).rejects.toThrow("regular, unlinked");
  expect(mocks.store[sessionKey]?.sessionFile).toBe(first);
  expect(await fs.readFile(first, "utf8")).toBe(bytes);
  expect(await fs.readFile(target, "utf8")).toBe(bytes);
});

it.each(["../escape", "a/b", "a\\b", "CON", "nul.txt", "trailing.", "", "a".repeat(129)])(
  "rejects unsafe business session id %s",
  async (group) => {
    await expect(prepare(123, group)).rejects.toThrow("safe session directory");
    expect(Object.keys(mocks.store)).toHaveLength(0);
  },
);

it("rejects invalid row ids and cross-user records before touching the store", async () => {
  await expect(prepare(-1)).rejects.toThrow("positive safe integer");
  await expect(
    prepareHistorySessionSnapshot({
      history: { id: 1, sessionId, userId: "126" },
      userId,
      agentId,
      sessionKey,
      sessions,
    }),
  ).rejects.toThrow("does not match");
  expect(Object.keys(mocks.store)).toHaveLength(0);
});

it("rejects symlink directories and keeps files outside the session root unchanged", async () => {
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "snapshot-outside-"));
  try {
    await fs.symlink(
      outside,
      path.join(root, sessionId),
      process.platform === "win32" ? "junction" : "dir",
    );
    await expect(prepare(123)).rejects.toThrow("symbolic link");
    expect(await fs.readdir(outside)).toEqual([]);
  } finally {
    await fs.rm(outside, { recursive: true, force: true });
  }
});
