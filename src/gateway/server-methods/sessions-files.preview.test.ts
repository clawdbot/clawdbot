import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sessionsFilesHandlers } from "./sessions-files.js";
import {
  createSessionFilesHandlerInvoker,
  createVisibleMessagesMock,
  expectOkPayload,
  hashContent,
  IMAGE_PREVIEW_FIXTURES,
  prepareSessionFilesTest,
  removeWorkspaceFixture,
  TEXT_PREVIEW_FIXTURES,
} from "./sessions-files.test-support.js";

const mocks = vi.hoisted(() => ({
  execOpenPath: vi.fn(),
  loadSessionEntry: vi.fn(),
  resolveAgentWorkspaceDir: vi.fn(),
  resolveDefaultAgentId: vi.fn(),
  readSessionTranscriptVisibleMessageDeltaCore: vi.fn(),
}));

vi.mock("../../agents/agent-scope.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/agent-scope.js")>()),
  resolveAgentWorkspaceDir: mocks.resolveAgentWorkspaceDir,
  resolveDefaultAgentId: mocks.resolveDefaultAgentId,
}));
vi.mock("../session-utils.js", async () => {
  const actual = await vi.importActual<typeof import("../session-utils.js")>("../session-utils.js");
  return {
    ...actual,
    loadSessionEntry: mocks.loadSessionEntry,
    loadGatewaySessionEntryReadOnly: mocks.loadSessionEntry,
  };
});
vi.mock("../session-transcript-readers.js", async () => {
  const actual = await vi.importActual<typeof import("../session-transcript-readers.js")>(
    "../session-transcript-readers.js",
  );
  return {
    ...actual,
    readSessionTranscriptVisibleMessageDeltaCore:
      mocks.readSessionTranscriptVisibleMessageDeltaCore,
  };
});

const invokeSessionFilesHandler = createSessionFilesHandlerInvoker(sessionsFilesHandlers);
const mockVisibleMessages = createVisibleMessagesMock(
  mocks.readSessionTranscriptVisibleMessageDeltaCore,
);

describe("sessions.files preview formats", () => {
  let workspaceRoot: string;

  beforeEach(() => {
    workspaceRoot = prepareSessionFilesTest(mocks, mockVisibleMessages);
  });
  afterEach(() => {
    removeWorkspaceFixture(workspaceRoot);
  });

  it.each(IMAGE_PREVIEW_FIXTURES)(
    "previews sniffed $format bytes as a base64 image without a CAS hash",
    async (fixture) => {
      const fileName = `preview-${fixture.format.toLowerCase()}.bin`;
      fs.writeFileSync(path.join(workspaceRoot, fileName), fixture.bytes);
      const payload = expectOkPayload(
        await invokeSessionFilesHandler("sessions.files.get", {
          sessionKey: "agent:main:main",
          path: fileName,
        }),
      );
      expect(payload.file).toMatchObject({
        content: fixture.bytes.toString("base64"),
        contentEncoding: "base64",
        mimeType: fixture.mimeType,
        path: fileName,
        previewKind: "image",
      });
      expect(payload.file.hash).toBeUndefined();
    },
  );

  it.each(TEXT_PREVIEW_FIXTURES)("keeps detected $format text editable", async (fixture) => {
    const fileName = `detected-${fixture.format.toLowerCase().replaceAll(" ", "-")}.bin`;
    fs.writeFileSync(path.join(workspaceRoot, fileName), fixture.content, "utf8");
    const payload = expectOkPayload(
      await invokeSessionFilesHandler("sessions.files.get", {
        sessionKey: "agent:main:main",
        path: fileName,
      }),
    );
    expect(payload.file).toMatchObject({
      content: fixture.content,
      contentEncoding: "utf8",
      hash: hashContent(fixture.content),
      mimeType: fixture.mimeType,
      path: fileName,
      previewKind: "text",
    });
  });

  it("returns unsupported binary metadata without lossy inline content", async () => {
    const binary = Buffer.concat([Buffer.from("SQLite format 3\0"), Buffer.alloc(64, 7)]);
    fs.writeFileSync(path.join(workspaceRoot, "cache.db"), binary);
    const payload = expectOkPayload(
      await invokeSessionFilesHandler("sessions.files.get", {
        sessionKey: "agent:main:main",
        path: "cache.db",
      }),
    );
    expect(payload.file).toMatchObject({
      mimeType: "application/x-sqlite3",
      missing: false,
      path: "cache.db",
      previewKind: "unsupported",
      size: binary.length,
    });
    expect(payload.file.content).toBeUndefined();
    expect(payload.file.contentEncoding).toBeUndefined();
    expect(payload.file.hash).toBeUndefined();
  });
});
