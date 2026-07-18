// Tests session and trajectory export command packaging, filesystem writes, and approval routing.
import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FsSafeError } from "../../infra/fs-safe.js";
import { buildExportSessionReply } from "./commands-export-session.js";
import type { HandleCommandsParams } from "./commands-types.js";

// Tests session export command packaging, filesystem writes, and prompt bundle capture.

const hoisted = await vi.hoisted(async () => {
  const { createExportCommandSessionMocks } = await import("./commands-export-test-mocks.js");
  return {
    ...createExportCommandSessionMocks(vi),
    resolveCommandsSystemPromptBundleMock: vi.fn(async () => ({
      systemPrompt: "system prompt",
      tools: [],
      skillsPrompt: "",
      bootstrapFiles: [],
      injectedFiles: [],
      sandboxRuntime: { sandboxed: false, mode: "off" },
    })),
    writeSessionExportFileMock: vi.fn(
      async (_params: {
        workspaceDir: string;
        requestedPath?: string;
        defaultFileName: string;
        contents: string;
      }) => ({
        absolutePath: "/tmp/workspace/openclaw-session.html",
        displayPath: "openclaw-session.html",
      }),
    ),
    migrateSessionEntriesMock: vi.fn((_entries: unknown[]) => undefined),
    readAcpSessionMetaForEntryMock: vi.fn<
      (params: { sessionKey: string; entry?: { sessionId?: string } }) => unknown
    >(() => undefined),
    loadTranscriptEventsMock: vi.fn(async (): Promise<unknown[]> => []),
    exportHtmlTemplateContents: new Map<string, string>(),
    sessionTranscriptEvents: [] as unknown[],
  };
});

vi.mock("../../acp/runtime/session-meta.js", () => ({
  readAcpSessionMetaForEntry: hoisted.readAcpSessionMetaForEntryMock,
}));

vi.mock("../../config/sessions/paths.js", () => ({
  resolveDefaultSessionStorePath: hoisted.resolveDefaultSessionStorePathMock,
  resolveSessionFilePath: hoisted.resolveSessionFilePathMock,
  resolveSessionFilePathOptions: hoisted.resolveSessionFilePathOptionsMock,
}));

vi.mock("../../config/sessions/store.js", () => ({
  loadSessionStore: hoisted.loadSessionStoreMock,
}));

vi.mock("../../config/sessions/session-accessor.js", () => ({
  loadSessionEntry: (scope: { storePath?: string; sessionKey: string }) =>
    (hoisted.loadSessionStoreMock(scope.storePath) as Record<string, unknown>)[scope.sessionKey],
  loadTranscriptEvents: hoisted.loadTranscriptEventsMock,
}));

vi.mock("./commands-system-prompt.js", () => ({
  resolveCommandsSystemPromptBundle: hoisted.resolveCommandsSystemPromptBundleMock,
}));

vi.mock("./commands-export-session-file.js", () => ({
  writeSessionExportFile: hoisted.writeSessionExportFileMock,
}));

vi.mock("../../agents/sessions/session-manager.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../agents/sessions/session-manager.js")>();
  return {
    ...actual,
    migrateSessionEntries: hoisted.migrateSessionEntriesMock,
  };
});

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  const mockedFs = {
    ...actual,
    readFileSync: vi.fn((filePath: string) => {
      for (const [suffix, contents] of hoisted.exportHtmlTemplateContents) {
        if (filePath.endsWith(suffix)) {
          return contents;
        }
      }
      if (filePath.includes("/export-html/")) {
        return actual.readFileSync(filePath, "utf8");
      }
      return actual.readFileSync(filePath, "utf8");
    }),
  };
  return {
    ...mockedFs,
    default: mockedFs,
  };
});

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  const mockedFsPromises = {
    ...actual,
    readFile: vi.fn(async (filePath: string, encoding?: BufferEncoding) => {
      for (const [suffix, contents] of hoisted.exportHtmlTemplateContents) {
        if (filePath.endsWith(suffix)) {
          return contents;
        }
      }
      return actual.readFile(filePath, encoding);
    }),
  };
  return {
    ...mockedFsPromises,
    default: mockedFsPromises,
  };
});

function makeParams(): HandleCommandsParams {
  return {
    cfg: {},
    ctx: {
      SessionKey: "agent:main:slash-session",
    },
    command: {
      commandBodyNormalized: "/export-session",
      isAuthorizedSender: true,
      senderIsOwner: true,
      senderId: "sender-1",
      channel: "quietchat",
      surface: "quietchat",
      ownerList: [],
      rawBodyNormalized: "/export-session",
    },
    sessionEntry: {
      sessionId: "session-1",
      updatedAt: 1,
    },
    sessionKey: "agent:target:session",
    workspaceDir: "/tmp/workspace",
    directives: {},
    elevated: { enabled: true, allowed: true, failures: [] },
    defaultGroupActivation: () => "mention",
    resolvedVerboseLevel: "off",
    resolvedReasoningLevel: "off",
    resolveDefaultThinkingLevel: async () => undefined,
    provider: "openai",
    model: "gpt-5.4",
    contextTokens: 0,
    isGroup: false,
  } as unknown as HandleCommandsParams;
}

function exportWriteParams(callIndex = 0): { contents: string } {
  const call = hoisted.writeSessionExportFileMock.mock.calls.at(callIndex);
  if (!call) {
    throw new Error(`Expected export write call ${callIndex}`);
  }
  return call[0];
}

function writtenHtml(): string {
  const value = exportWriteParams().contents;
  if (typeof value !== "string") {
    throw new Error("Expected exported HTML");
  }
  return value;
}

function sessionDataFromHtml(html: string): Record<string, unknown> {
  const match = html.match(/id="session-data"[^>]*>([^<]+)</);
  if (!match) {
    throw new Error("Expected session-data script in exported HTML");
  }
  return JSON.parse(
    Buffer.from(expectDefined(match[1], "match[1] test invariant").trim(), "base64").toString(
      "utf-8",
    ),
  );
}

describe("buildExportSessionReply", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.resolveDefaultSessionStorePathMock.mockReturnValue("/tmp/target-store/sessions.json");
    hoisted.resolveSessionFilePathMock.mockReturnValue("/tmp/target-store/session.jsonl");
    hoisted.resolveSessionFilePathOptionsMock.mockImplementation(
      (params: { agentId: string; storePath: string }) => params,
    );
    hoisted.loadSessionStoreMock.mockReturnValue({
      "agent:target:session": {
        sessionId: "session-1",
        updatedAt: 1,
      },
    });
    hoisted.resolveCommandsSystemPromptBundleMock.mockResolvedValue({
      systemPrompt: "system prompt",
      tools: [],
      skillsPrompt: "",
      bootstrapFiles: [],
      injectedFiles: [],
      sandboxRuntime: { sandboxed: false, mode: "off" },
    });
    hoisted.writeSessionExportFileMock.mockResolvedValue({
      absolutePath: "/tmp/workspace/openclaw-session.html",
      displayPath: "openclaw-session.html",
    });
    hoisted.readAcpSessionMetaForEntryMock.mockReturnValue(undefined);
    hoisted.loadTranscriptEventsMock.mockImplementation(
      async () => hoisted.sessionTranscriptEvents,
    );
    hoisted.exportHtmlTemplateContents.clear();
    hoisted.sessionTranscriptEvents = [];
  });

  it("resolves store and transcript paths from the target session agent", async () => {
    await buildExportSessionReply(makeParams());

    expect(hoisted.resolveDefaultSessionStorePathMock).toHaveBeenCalledWith("target");
    expect(hoisted.resolveSessionFilePathOptionsMock).toHaveBeenCalledWith({
      agentId: "target",
      storePath: "/tmp/target-store/sessions.json",
    });
  });

  it("prefers the active command storePath over the default target-agent store", async () => {
    hoisted.loadSessionStoreMock.mockReturnValue({
      "agent:target:session": {
        sessionId: "session-1",
        updatedAt: 1,
      },
    });

    await buildExportSessionReply({
      ...makeParams(),
      storePath: "/tmp/custom-store/sessions.json",
    });

    expect(hoisted.resolveDefaultSessionStorePathMock).not.toHaveBeenCalled();
    expect(hoisted.loadSessionStoreMock).toHaveBeenCalledWith("/tmp/custom-store/sessions.json");
    expect(hoisted.resolveSessionFilePathOptionsMock).toHaveBeenCalledWith({
      agentId: "target",
      storePath: "/tmp/custom-store/sessions.json",
    });
  });

  it("uses the target store entry even when the wrapper sessionEntry is missing", async () => {
    hoisted.loadSessionStoreMock.mockReturnValue({
      "agent:target:session": {
        sessionId: "session-from-store",
        updatedAt: 2,
      },
    });

    const reply = await buildExportSessionReply({
      ...makeParams(),
      sessionEntry: undefined,
    });

    expect(reply.text).toContain("✅ Session exported!");
    const [systemPromptBundleParams] = expectDefined(
      (
        hoisted.resolveCommandsSystemPromptBundleMock.mock.calls as unknown as Array<
          [{ sessionEntry?: { sessionId?: string; updatedAt?: number } }]
        >
      )[0],
      "(hoisted.resolveCommandsSystemPromptBundleMock.mock.calls as unknown as Array<\n        [{ sessionEntry?: { sessionId?: string; updatedAt?: number } }]\n      >)[0] test invariant",
    );
    expect(systemPromptBundleParams?.sessionEntry?.sessionId).toBe("session-from-store");
    expect(systemPromptBundleParams?.sessionEntry?.updatedAt).toBe(2);
  });

  it("injects scripts and session data through the real export template", async () => {
    await buildExportSessionReply(makeParams());

    const html = writtenHtml();
    expect(html).not.toContain("{{CSS}}");
    expect(html).not.toContain("{{JS}}");
    expect(html).not.toContain("{{SESSION_DATA}}");
    expect(html).not.toContain("{{MARKED_JS}}");
    expect(html).not.toContain("{{HIGHLIGHT_JS}}");
    expect(html).not.toContain("data-openclaw-export-placeholder");
    expect(html).toContain(
      Buffer.from(
        JSON.stringify({
          header: null,
          entries: [],
          leafId: null,
          hasLeafControl: false,
          systemPrompt: "system prompt",
          tools: [],
        }),
      ).toString("base64"),
    );
    expect(html).toContain('const base64 = document.getElementById("session-data").textContent;');
  });

  it("exports the active target selected by a terminal leaf control", async () => {
    const entries = [
      {
        type: "message",
        id: "active-tail",
        parentId: null,
        timestamp: "2026-06-15T00:00:01.000Z",
        message: { role: "assistant", content: "active" },
      },
      {
        type: "message",
        id: "inactive-tail",
        parentId: "active-tail",
        timestamp: "2026-06-15T00:00:02.000Z",
        message: { role: "assistant", content: "side delivery" },
      },
      {
        type: "leaf",
        id: "active-leaf",
        parentId: "inactive-tail",
        timestamp: "2026-06-15T00:00:03.000Z",
        targetId: "active-tail",
      },
    ];
    hoisted.sessionTranscriptEvents = entries;

    await buildExportSessionReply(makeParams());

    expect(writtenHtml()).toContain(
      Buffer.from(
        JSON.stringify({
          header: null,
          entries: [entries[0], entries[1], { ...entries[2], parentId: "active-tail" }],
          leafId: "active-tail",
          hasLeafControl: true,
          systemPrompt: "system prompt",
          tools: [],
        }),
      ).toString("base64"),
    );
  });

  it("normalizes a leaf control parent before exporting its active descendant", async () => {
    const rawEntries = [
      {
        type: "message",
        id: "active-tail",
        parentId: null,
        timestamp: "2026-06-15T00:00:01.000Z",
        message: { role: "assistant", content: "active" },
      },
      {
        type: "message",
        id: "inactive-tail",
        parentId: "active-tail",
        timestamp: "2026-06-15T00:00:02.000Z",
        message: { role: "assistant", content: "side delivery" },
      },
      {
        type: "leaf",
        id: "active-leaf",
        parentId: "inactive-tail",
        timestamp: "2026-06-15T00:00:03.000Z",
        targetId: "active-tail",
      },
      {
        type: "message",
        id: "replacement",
        parentId: "active-leaf",
        timestamp: "2026-06-15T00:00:04.000Z",
        message: { role: "assistant", content: "replacement" },
      },
    ];
    hoisted.sessionTranscriptEvents = rawEntries;

    await buildExportSessionReply(makeParams());

    expect(writtenHtml()).toContain(
      Buffer.from(
        JSON.stringify({
          header: null,
          entries: [
            rawEntries[0],
            rawEntries[1],
            { ...rawEntries[2], parentId: "active-tail" },
            { ...rawEntries[3], parentId: "active-tail" },
          ],
          leafId: "replacement",
          hasLeafControl: true,
          systemPrompt: "system prompt",
          tools: [],
        }),
      ).toString("base64"),
    );
  });

  it("normalizes parentless history addressed by a leaf control", async () => {
    const rawEntries = [
      {
        type: "message",
        id: "active-root",
        timestamp: "2026-06-15T00:00:01.000Z",
        message: { role: "user", content: "root" },
      },
      {
        type: "message",
        id: "active-tail",
        timestamp: "2026-06-15T00:00:02.000Z",
        message: { role: "assistant", content: "active" },
      },
      {
        type: "message",
        id: "inactive-tail",
        parentId: "active-tail",
        timestamp: "2026-06-15T00:00:03.000Z",
        message: { role: "assistant", content: "side delivery" },
      },
      {
        type: "leaf",
        id: "active-leaf",
        parentId: "inactive-tail",
        timestamp: "2026-06-15T00:00:04.000Z",
        targetId: "active-tail",
      },
    ];
    hoisted.sessionTranscriptEvents = rawEntries;

    await buildExportSessionReply(makeParams());

    expect(writtenHtml()).toContain(
      Buffer.from(
        JSON.stringify({
          header: null,
          entries: [
            { ...rawEntries[0], parentId: null },
            { ...rawEntries[1], parentId: "active-root" },
            rawEntries[2],
            { ...rawEntries[3], parentId: "active-tail" },
          ],
          leafId: "active-tail",
          hasLeafControl: true,
          systemPrompt: "system prompt",
          tools: [],
        }),
      ).toString("base64"),
    );
  });

  it("preserves an explicitly empty branch selected by a terminal leaf control", async () => {
    const entries = [
      {
        type: "message",
        id: "inactive-tail",
        parentId: null,
        timestamp: "2026-06-15T00:00:01.000Z",
        message: { role: "assistant", content: "inactive" },
      },
      {
        type: "leaf",
        id: "empty-leaf",
        parentId: "inactive-tail",
        timestamp: "2026-06-15T00:00:02.000Z",
        targetId: null,
      },
      {
        type: "metadata",
        id: "opaque-after-leaf",
        parentId: "inactive-tail",
      },
    ];
    hoisted.sessionTranscriptEvents = entries;

    await buildExportSessionReply(makeParams());

    expect(writtenHtml()).toContain(
      Buffer.from(
        JSON.stringify({
          header: null,
          entries: [entries[0], { ...entries[1], parentId: null }, entries[2]],
          leafId: null,
          hasLeafControl: true,
          systemPrompt: "system prompt",
          tools: [],
        }),
      ).toString("base64"),
    );
  });

  it("passes the generated HTML and explicit path to the export boundary", async () => {
    const params = makeParams();
    params.command.commandBodyNormalized = "/export-session exports/session.html";
    hoisted.writeSessionExportFileMock.mockResolvedValueOnce({
      absolutePath: "/tmp/workspace/exports/session.html",
      displayPath: "exports/session.html",
    });

    const reply = await buildExportSessionReply(params);

    expect(hoisted.writeSessionExportFileMock).toHaveBeenCalledWith({
      workspaceDir: "/tmp/workspace",
      requestedPath: "exports/session.html",
      defaultFileName: expect.stringMatching(/^openclaw-session-session--.+\.html$/),
      contents: expect.stringContaining('id="session-data"'),
    });
    expect(reply.text).toContain("📄 File: exports/session.html");
  });

  it("turns an unsafe output path into a bounded user-facing error", async () => {
    const params = makeParams();
    params.command.commandBodyNormalized = "/export-session ../outside.html";
    hoisted.writeSessionExportFileMock.mockRejectedValueOnce(
      new FsSafeError("outside-workspace", "file is outside workspace root"),
    );

    await expect(buildExportSessionReply(params)).resolves.toEqual({
      text: "❌ Output path must be a regular file inside the workspace.",
    });
  });

  it("preserves replacement text with dollar sequences", async () => {
    hoisted.exportHtmlTemplateContents.set(
      "template.html",
      [
        '<style data-openclaw-export-placeholder="CSS"></style>',
        '<script id="session-data" type="application/json" data-openclaw-export-placeholder="SESSION_DATA"></script>',
        '<script data-openclaw-export-placeholder="MARKED_JS"></script>',
        '<script data-openclaw-export-placeholder="HIGHLIGHT_JS"></script>',
        '<script data-openclaw-export-placeholder="JS"></script>',
      ].join(""),
    );
    hoisted.exportHtmlTemplateContents.set("template.css", "/* {{THEME_VARS}} */$&$1");
    hoisted.exportHtmlTemplateContents.set("template.js", "const marker = '$&$1';");
    hoisted.exportHtmlTemplateContents.set("vendor/marked.min.js", "const markedMarker = '$&$1';");
    hoisted.exportHtmlTemplateContents.set(
      "vendor/highlight.min.js",
      "const highlightMarker = '$&$1';",
    );

    await buildExportSessionReply(makeParams());

    const html = writtenHtml();
    expect(html).toContain("$&$1");
    expect(html).toContain("const marker = '$&$1';");
    expect(html).toContain("const markedMarker = '$&$1';");
    expect(html).toContain("const highlightMarker = '$&$1';");
  });

  it("exports marker-backed sessions by identity without requiring the marker as a file", async () => {
    hoisted.resolveSessionFilePathMock.mockReturnValue(
      "sqlite:target:session-1:/tmp/target-store/openclaw-agent.sqlite",
    );
    hoisted.loadSessionStoreMock.mockReturnValue({
      "agent:target:session": {
        sessionFile: "sqlite:target:session-1:/tmp/target-store/openclaw-agent.sqlite",
        sessionId: "session-1",
        updatedAt: 1,
      },
    });
    hoisted.sessionTranscriptEvents = [
      {
        type: "message",
        id: "entry-1",
        timestamp: "2026-05-16T00:00:00.000Z",
        message: { role: "user", content: "valid user" },
      },
      {
        type: "message",
        id: "entry-3",
        timestamp: "2026-05-16T00:00:02.000Z",
        message: { role: "assistant", content: "valid assistant" },
      },
    ];

    const reply = await buildExportSessionReply(makeParams());

    expect(reply.text).toContain("📊 Entries: 2");
    expect(hoisted.loadTranscriptEventsMock).toHaveBeenCalledWith({
      agentId: "target",
      sessionId: "session-1",
      sessionKey: "agent:target:session",
      storePath: "/tmp/target-store/sessions.json",
    });
  });

  it("skips invalid loaded transcript events before exporting", async () => {
    hoisted.sessionTranscriptEvents = [
      {
        type: "message",
        id: "entry-1",
        timestamp: "2026-05-16T00:00:00.000Z",
        message: { role: "user", content: "valid user" },
      },
      {
        type: "message",
        id: "entry-2",
        timestamp: "2026-05-16T00:00:01.000Z",
        message: { content: "missing role" },
      },
      {
        type: "message",
        id: "entry-3",
        timestamp: "2026-05-16T00:00:02.000Z",
        message: { role: "assistant", content: "valid assistant" },
      },
    ];

    const reply = await buildExportSessionReply(makeParams());

    expect(reply.text).toContain("📊 Entries: 2");
    expect(reply.text).toContain(
      "⚠️ Skipped 1 malformed transcript row that was not a session entry. rows 2",
    );
  });

  it("warns when the session only contains user messages (backend-delegated transcript)", async () => {
    hoisted.loadSessionStoreMock.mockReturnValue({
      "agent:target:session": {
        sessionId: "session-1",
        updatedAt: 1,
        cliSessionBindings: {
          "claude-cli": { sessionId: "backend-session-1" },
        },
      },
    });
    hoisted.sessionTranscriptEvents = [
      {
        type: "message",
        id: "entry-1",
        timestamp: "2026-05-16T00:00:00.000Z",
        message: { role: "user", content: "hello" },
      },
      {
        type: "message",
        id: "entry-2",
        timestamp: "2026-05-16T00:00:01.000Z",
        message: { role: "user", content: "world" },
      },
    ];

    const reply = await buildExportSessionReply(makeParams());

    expect(reply.text).toContain("backend runtime");
    expect(reply.text).toContain("not included in this export");
    const data = sessionDataFromHtml(writtenHtml());
    expect(typeof data.warning).toBe("string");
    expect(data.warning).toContain("backend runtime");
  });

  it("warns when persisted ACP metadata is stored outside the session entry", async () => {
    hoisted.readAcpSessionMetaForEntryMock.mockReturnValue({
      backend: "acpx",
      mode: "persistent",
      agent: "claude",
      runtimeSessionName: "backend-session-1",
      state: "idle",
      lastActivityAt: 1,
    });
    hoisted.sessionTranscriptEvents = [
      {
        type: "message",
        id: "entry-1",
        timestamp: "2026-05-16T00:00:00.000Z",
        message: { role: "user", content: "hello" },
      },
    ];

    const reply = await buildExportSessionReply(makeParams());

    expect(hoisted.readAcpSessionMetaForEntryMock).toHaveBeenCalledWith({
      sessionKey: "agent:target:session",
      entry: {
        sessionId: "session-1",
        updatedAt: 1,
      },
    });
    expect(reply.text).toContain("backend runtime");
    expect(sessionDataFromHtml(writtenHtml()).warning).toContain("backend runtime");
  });

  it("continues exporting when persisted ACP metadata cannot be read", async () => {
    hoisted.readAcpSessionMetaForEntryMock.mockImplementation(() => {
      throw new Error("state database unavailable");
    });
    hoisted.sessionTranscriptEvents = [
      {
        type: "message",
        id: "entry-1",
        timestamp: "2026-05-16T00:00:00.000Z",
        message: { role: "user", content: "hello" },
      },
    ];

    const reply = await buildExportSessionReply(makeParams());

    expect(reply.text).toContain("Session exported");
    expect(reply.text).not.toContain("backend runtime");
    expect(sessionDataFromHtml(writtenHtml()).warning).toBeUndefined();
  });

  it("does not warn for a normal user-only transcript without backend session metadata", async () => {
    hoisted.sessionTranscriptEvents = [
      {
        type: "message",
        id: "entry-1",
        timestamp: "2026-05-16T00:00:00.000Z",
        message: { role: "user", content: "hello" },
      },
    ];

    const reply = await buildExportSessionReply(makeParams());

    expect(reply.text).not.toContain("backend runtime");
    expect(sessionDataFromHtml(writtenHtml()).warning).toBeUndefined();
  });

  it("ignores malformed persisted backend session metadata", async () => {
    hoisted.loadSessionStoreMock.mockReturnValue({
      "agent:target:session": {
        sessionId: "session-1",
        updatedAt: 1,
        claudeCliSessionId: 123,
        cliSessionBindings: {
          "claude-cli": null,
        },
        cliSessionIds: {
          acpx: 123,
        },
      },
    } as never);
    hoisted.sessionTranscriptEvents = [
      {
        type: "message",
        id: "entry-1",
        timestamp: "2026-05-16T00:00:00.000Z",
        message: { role: "user", content: "hello" },
      },
    ];

    const reply = await buildExportSessionReply(makeParams());

    expect(reply.text).not.toContain("backend runtime");
    expect(sessionDataFromHtml(writtenHtml()).warning).toBeUndefined();
  });

  it("does not warn when the transcript includes assistant messages", async () => {
    hoisted.loadSessionStoreMock.mockReturnValue({
      "agent:target:session": {
        sessionId: "session-1",
        updatedAt: 1,
        acp: {
          backend: "acpx",
          mode: "persistent",
          agent: "claude",
          runtimeSessionName: "backend-session-1",
          state: "idle",
          lastActivityAt: 1,
        },
      },
    });
    hoisted.sessionTranscriptEvents = [
      {
        type: "message",
        id: "entry-1",
        timestamp: "2026-05-16T00:00:00.000Z",
        message: { role: "user", content: "hello" },
      },
      {
        type: "message",
        id: "entry-2",
        timestamp: "2026-05-16T00:00:01.000Z",
        message: { role: "assistant", content: "hi" },
      },
    ];

    const reply = await buildExportSessionReply(makeParams());

    expect(reply.text).not.toContain("backend runtime");
    expect(reply.text).not.toContain("not included in this export");
    expect(sessionDataFromHtml(writtenHtml()).warning).toBeUndefined();
  });
});

await import("./commands-export-session-file.test-support.js");
await import("./commands-export-trajectory.test-support.js");
