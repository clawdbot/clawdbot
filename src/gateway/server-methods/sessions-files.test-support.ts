import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect } from "vitest";
import type { GatewayRequestHandlers, RespondFn } from "./types.js";

type SessionFilesMethod =
  | "sessions.files.list"
  | "sessions.files.get"
  | "sessions.files.set"
  | "sessions.files.reveal";

type ResponderCall = { ok: boolean; payload?: unknown; error?: unknown };
type ReturnValueMock = { mockReturnValue: (value: unknown) => unknown };

function createResponder() {
  const calls: ResponderCall[] = [];
  const respond: RespondFn = (ok, payload, error) => {
    calls.push({ ok, payload, error });
  };
  return { calls, respond };
}

export function createSessionFilesHandlerInvoker(handlers: GatewayRequestHandlers) {
  return async (
    method: SessionFilesMethod,
    params: Record<string, unknown>,
    context: Record<string, unknown> = {},
  ) => {
    const responder = createResponder();
    await handlers[method]?.({
      req: { type: "req", id: method, method, params: {} },
      params,
      client: null,
      isWebchatConnect: () => false,
      respond: responder.respond,
      context: context as never,
    });
    return responder.calls;
  };
}

export function expectOkPayload(calls: ResponderCall[]): Record<string, any> {
  expect(calls).toHaveLength(1);
  expect(calls[0]?.ok).toBe(true);
  return calls[0]?.payload as Record<string, any>;
}

export function expectError(calls: ResponderCall[]): Record<string, any> {
  expect(calls).toHaveLength(1);
  expect(calls[0]?.ok).toBe(false);
  return calls[0]?.error as Record<string, any>;
}

export function assistantToolCall(name: string, args: Record<string, unknown>) {
  return {
    role: "assistant",
    content: [
      {
        type: "toolCall",
        name,
        arguments: args,
      },
    ],
  };
}

export function visibleMessageEvent(message: unknown, seq: number) {
  return {
    event: { id: `event-${String(seq)}`, message },
    eventSeq: seq,
    parentId: seq > 1 ? `event-${String(seq - 1)}` : null,
    seq,
  };
}

export function createVisibleMessagesMock(readVisibleMessageDelta: ReturnValueMock) {
  return (messages: unknown[], cursor = "visible-messages-final"): void => {
    readVisibleMessageDelta.mockReturnValue({
      kind: "page",
      cursor,
      events: messages.map(visibleMessageEvent),
      hasMore: false,
      serializedBytes: 100,
    });
  };
}

export function writeWorkspaceFile(root: string, filePath: string, content: string): void {
  const resolved = path.join(root, filePath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, content, "utf8");
}

export function createWorkspaceFixture(prefix: string): string {
  const tempRoot = fs.realpathSync(os.tmpdir());
  const workspaceRoot = fs.mkdtempSync(path.join(tempRoot, prefix));
  writeWorkspaceFile(workspaceRoot, "package.json", '{"name":"openclaw-test"}\n');
  writeWorkspaceFile(workspaceRoot, "src/readme.md", "# Read me\n");
  writeWorkspaceFile(workspaceRoot, "ui/chat.ts", "export const chat = true;\n");
  writeWorkspaceFile(workspaceRoot, "ui/vite.config.ts", "export default {};\n");
  return workspaceRoot;
}

export function hashContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export function createSessionEntryFixture(
  workspaceRoot: string,
  sessionId: string,
  storePath = path.join(workspaceRoot, ".sessions.json"),
) {
  return {
    canonicalKey: "agent:main:main",
    cfg: {},
    storePath,
    entry: {
      sessionId,
      sessionFile: `${sessionId}.jsonl`,
      spawnedCwd: workspaceRoot,
    },
  };
}

export function useSqliteSession(
  loadSessionEntry: ReturnValueMock,
  workspaceRoot: string,
  sessionId: string,
  storePath = path.join(workspaceRoot, `${sessionId}.sqlite`),
): string {
  loadSessionEntry.mockReturnValue({
    canonicalKey: "agent:main:main",
    cfg: {},
    storePath,
    entry: {
      sessionId,
      sessionFile: `sqlite:main:${sessionId}:${storePath}`,
      spawnedCwd: workspaceRoot,
    },
  });
  return storePath;
}
