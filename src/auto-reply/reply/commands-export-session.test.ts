import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HandleCommandsParams } from "./commands-types.js";

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
    writeFileMock: vi.fn(
      async (_filePath: string, _data: string, _encoding?: BufferEncoding) => undefined,
    ),
    mkdirMock: vi.fn(async (_filePath: string, _options?: { recursive?: boolean }) => undefined),
    accessMock: vi.fn(async (_filePath: string) => undefined),
    pathExistsMock: vi.fn(async (_filePath: string) => true),
    exportHtmlTemplateContents: new Map<string, string>(),
  };
});

vi.mock("../../config/sessions/paths.js", () => ({
  resolveDefaultSessionStorePath: hoisted.resolveDefaultSessionStorePathMock,
  resolveSessionFilePath: hoisted.resolveSessionFilePathMock,
  resolveSessionFilePathOptions: hoisted.resolveSessionFilePathOptionsMock,
}));

vi.mock("../../config/sessions/store.js", () => ({
  loadSessionStore: hoisted.loadSessionStoreMock,
}));

vi.mock("./commands-system-prompt.js", () => ({
  resolveCommandsSystemPromptBundle: hoisted.resolveCommandsSystemPromptBundleMock,
}));

vi.mock("../../infra/fs-safe.js", () => ({
  pathExists: hoisted.pathExistsMock,
}));

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
      return "";
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
    access: hoisted.accessMock,
    mkdir: hoisted.mkdirMock,
    writeFile: hoisted.writeFileMock,
    readFile: vi.fn(async (filePath: string, encoding?: BufferEncoding) => {
      if (filePath === "/tmp/target-store/session.jsonl") {
        return "";
      }
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

import { buildExportSessionReply } from "./commands-export-session.js";

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

function writeFileArg(callIndex: number, argIndex: number): unknown {
  const call = hoisted.writeFileMock.mock.calls.at(callIndex);
  if (!call) {
    throw new Error(`Expected writeFile call ${callIndex}`);
  }
  if (!(argIndex in call)) {
    throw new Error(`Expected writeFile call ${callIndex} argument ${argIndex}`);
  }
  return call[argIndex];
}

function writeFilePath(callIndex: number): string {
  const value = writeFileArg(callIndex, 0);
  if (typeof value !== "string") {
    throw new Error(`Expected writeFile call ${callIndex} path`);
  }
  return value;
}

function writtenHtml(): string {
  const value = writeFileArg(0, 1);
  if (typeof value !== "string") {
    throw new Error("Expected exported HTML");
  }
  return value;
}

describe("buildExportSessionReply", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

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
    hoisted.accessMock.mockResolvedValue(undefined);
    hoisted.pathExistsMock.mockResolvedValue(true);
    hoisted.exportHtmlTemplateContents.clear();
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
    expect(hoisted.loadSessionStoreMock).toHaveBeenCalledWith("/tmp/custom-store/sessions.json", {
      skipCache: true,
    });
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
    const [[systemPromptBundleParams]] = hoisted.resolveCommandsSystemPromptBundleMock.mock
      .calls as unknown as Array<[{ sessionEntry?: { sessionId?: string; updatedAt?: number } }]>;
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
          systemPrompt: "system prompt",
          tools: [],
        }),
      ).toString("base64"),
    );
    expect(html).toContain('const base64 = document.getElementById("session-data").textContent;');
  });

  it("suffixes colliding default export filenames instead of overwriting", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-05T10:11:12.345Z"));
    const collision = Object.assign(new Error("exists"), { code: "EEXIST" });
    hoisted.writeFileMock.mockRejectedValueOnce(collision).mockResolvedValueOnce(undefined);

    const reply = await buildExportSessionReply(makeParams());

    const expectedBase = path.join(
      "/tmp/workspace",
      "openclaw-session-session--2026-05-05T10-11-12.html",
    );
    const expectedSuffix = path.join(
      "/tmp/workspace",
      "openclaw-session-session--2026-05-05T10-11-12-2.html",
    );
    expect(writeFilePath(0)).toBe(expectedBase);
    expect(writeFileArg(0, 2)).toEqual({
      encoding: "utf-8",
      flag: "wx",
    });
    expect(writeFilePath(1)).toBe(expectedSuffix);
    expect(reply.text).toContain("📄 File: openclaw-session-session--2026-05-05T10-11-12-2.html");
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
});
