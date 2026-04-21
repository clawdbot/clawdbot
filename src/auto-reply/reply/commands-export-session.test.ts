import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HandleCommandsParams } from "./commands-types.js";

const hoisted = vi.hoisted(() => ({
  resolveDefaultSessionStorePathMock: vi.fn(() => "/tmp/target-store/sessions.json"),
  resolveSessionFilePathMock: vi.fn(() => "/tmp/target-store/session.jsonl"),
  resolveSessionFilePathOptionsMock: vi.fn(
    (params: { agentId: string; storePath: string }) => params,
  ),
  loadSessionStoreMock: vi.fn(() => ({
    "agent:target:session": {
      sessionId: "session-1",
      updatedAt: 1,
    },
  })),
  resolveCommandsSystemPromptBundleMock: vi.fn(async () => ({
    systemPrompt: "system prompt",
    tools: [],
    skillsPrompt: "",
    bootstrapFiles: [],
    injectedFiles: [],
    sandboxRuntime: { sandboxed: false, mode: "off" },
  })),
  getEntriesMock: vi.fn(() => []),
  getHeaderMock: vi.fn(() => null),
  getLeafIdMock: vi.fn(() => null),
  writeFileSyncMock: vi.fn(),
  mkdirSyncMock: vi.fn(),
  existsSyncMock: vi.fn(() => true),
}));

vi.mock("@mariozechner/pi-coding-agent", () => ({
  SessionManager: {
    open: vi.fn(() => ({
      getEntries: hoisted.getEntriesMock,
      getHeader: hoisted.getHeaderMock,
      getLeafId: hoisted.getLeafIdMock,
    })),
  },
}));

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

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  const mockedFs = {
    ...actual,
    existsSync: hoisted.existsSyncMock,
    mkdirSync: hoisted.mkdirSyncMock,
    writeFileSync: hoisted.writeFileSyncMock,
    readFileSync: vi.fn((filePath: string) => {
      if (filePath.endsWith("template.html")) {
        return "<html>{{CSS}}{{JS}}{{SESSION_DATA}}{{MARKED_JS}}{{HIGHLIGHT_JS}}</html>";
      }
      return "";
    }),
  };
  return {
    ...mockedFs,
    default: mockedFs,
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
    hoisted.existsSyncMock.mockReturnValue(true);
  });

  it("resolves store and transcript paths from the target session agent", async () => {
    const { buildExportSessionReply } = await import("./commands-export-session.js");

    await buildExportSessionReply(makeParams());

    expect(hoisted.resolveDefaultSessionStorePathMock).toHaveBeenCalledWith("target");
    expect(hoisted.resolveSessionFilePathOptionsMock).toHaveBeenCalledWith({
      agentId: "target",
      storePath: "/tmp/target-store/sessions.json",
    });
  });

  it("prefers the active command storePath over the default target-agent store", async () => {
    const { buildExportSessionReply } = await import("./commands-export-session.js");
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
    const { buildExportSessionReply } = await import("./commands-export-session.js");
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
    expect(hoisted.resolveCommandsSystemPromptBundleMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionEntry: expect.objectContaining({
          sessionId: "session-from-store",
        }),
      }),
    );
  });
});
