import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, vi } from "vitest";
import type { GatewayRequestHandlers, RespondFn } from "./types.js";

type SessionFilesMethod =
  | "sessions.files.list"
  | "sessions.files.get"
  | "sessions.files.set"
  | "sessions.files.reveal";

type ResponderCall = { ok: boolean; payload?: unknown; error?: unknown };
type ReturnValueMock = { mockReturnValue: (value: unknown) => unknown };

export const IMAGE_PREVIEW_FIXTURES = [
  {
    format: "AVIF",
    mimeType: "image/avif",
    bytes: Buffer.from([
      0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66, 0x00, 0x00, 0x00,
      0x00, 0x61, 0x76, 0x69, 0x66,
    ]),
  },
  { format: "GIF", mimeType: "image/gif", bytes: Buffer.from("GIF89a", "ascii") },
  {
    format: "JPEG",
    mimeType: "image/jpeg",
    bytes: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]),
  },
  {
    format: "PNG",
    mimeType: "image/png",
    bytes: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
      "base64",
    ),
  },
  {
    format: "WebP",
    mimeType: "image/webp",
    bytes: Buffer.concat([Buffer.from("RIFF", "ascii"), Buffer.alloc(4), Buffer.from("WEBP")]),
  },
] as const;

export const TEXT_PREVIEW_FIXTURES = [
  { format: "RTF", mimeType: "application/rtf", content: "{\\rtf1\\ansi hello}" },
  { format: "XML", mimeType: "text/xml", content: '<?xml version="1.0"?><root/>' },
  { format: "WebVTT", mimeType: "text/vtt", content: "WEBVTT\n\n00:00.000 --> 00:01.000\nHi" },
  { format: "vCard", mimeType: "text/vcard", content: "BEGIN:VCARD\nVERSION:4.0\nEND:VCARD\n" },
  {
    format: "iCalendar",
    mimeType: "text/calendar",
    content: "BEGIN:VCALENDAR\nVERSION:2.0\nEND:VCALENDAR\n",
  },
  {
    format: "registry",
    mimeType: "application/x-ms-regedit",
    content: "REGEDIT4\r\n\r\n[HKEY_CURRENT_USER\\Software]",
  },
  {
    format: "ASCII STL",
    mimeType: "model/stl",
    content: "solid test\nfacet normal 0 0 0\nendfacet\nendsolid test\n",
  },
] as const;

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
      context: {
        getRuntimeConfig: () => ({ agents: { list: [{ id: "main", default: true }] } }),
        ...context,
      } as never,
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

export function removeWorkspaceFixture(workspaceRoot: string): void {
  fs.rmSync(workspaceRoot, { recursive: true, force: true });
}

export function prepareSessionFilesTest(
  mocks: {
    execOpenPath: ReturnValueMock & { mockResolvedValue: (value: unknown) => unknown };
    loadSessionEntry: ReturnValueMock;
    readSessionTranscriptVisibleMessageDeltaCore: ReturnValueMock & { mockReset: () => unknown };
    resolveAgentWorkspaceDir: ReturnValueMock;
    resolveDefaultAgentId: ReturnValueMock;
  },
  mockVisibleMessages: (messages: unknown[]) => void,
): string {
  vi.clearAllMocks();
  mocks.readSessionTranscriptVisibleMessageDeltaCore.mockReset();
  const workspaceRoot = createWorkspaceFixture("openclaw-session-files-test-");
  mocks.resolveDefaultAgentId.mockReturnValue("main");
  mocks.resolveAgentWorkspaceDir.mockReturnValue(workspaceRoot);
  mocks.execOpenPath.mockResolvedValue(undefined);
  mocks.loadSessionEntry.mockReturnValue(createSessionEntryFixture(workspaceRoot, "sess-main"));
  mockVisibleMessages([
    assistantToolCall("edit", { path: "ui/chat.ts" }),
    assistantToolCall("read", { path: "src/readme.md" }),
    assistantToolCall("apply_patch", {
      input: "*** Begin Patch\n*** Update File: package.json\n*** End Patch\n",
    }),
  ]);
  return workspaceRoot;
}

export function hashContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function createSessionEntryFixture(
  workspaceRoot: string,
  sessionId: string,
  storePath = path.join(workspaceRoot, ".sessions.json"),
) {
  return {
    agentId: "main",
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
    agentId: "main",
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
