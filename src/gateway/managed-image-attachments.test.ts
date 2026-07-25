// Managed image attachment tests cover storage, HTTP serving, cleanup, and
// operator authorization for generated image artifacts attached to gateway replies.
import fs from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createNoisyPngBuffer as createNoisyPngFixtureBuffer,
  createSolidPngBuffer,
} from "../../test/helpers/image-fixtures.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createPinnedLookup } from "../infra/net/ssrf.js";
import { setMediaStoreNetworkDepsForTest } from "../media/store.test-support.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  insertManagedImageRecord,
  MANAGED_OUTGOING_ORIGINALS_SUBDIR,
  readManagedImageRecord,
} from "./managed-image-record-store.js";

const authorizeGatewayHttpRequestOrReplyMock = vi.fn();
const resolveOpenAiCompatibleHttpOperatorScopesMock = vi.fn();
const resolveOpenAiCompatibleHttpSenderIsOwnerMock = vi.fn();
const loadSessionEntryMock = vi.fn();
const readSessionMessagesMock = vi.fn();
const resolveSessionHistoryTranscriptPathMock = vi.fn();
const getRuntimeConfigMock = vi.fn(() => ({}));
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

vi.mock("../config/config.js", () => ({
  getRuntimeConfig: getRuntimeConfigMock,
}));

vi.mock("./http-utils.js", () => ({
  authorizeGatewayHttpRequestOrReply: authorizeGatewayHttpRequestOrReplyMock,
  resolveOpenAiCompatibleHttpOperatorScopes: resolveOpenAiCompatibleHttpOperatorScopesMock,
  resolveOpenAiCompatibleHttpSenderIsOwner: resolveOpenAiCompatibleHttpSenderIsOwnerMock,
}));

vi.mock("./session-utils.js", () => ({
  loadSessionEntry: loadSessionEntryMock,
  loadSessionEntryReadOnly: loadSessionEntryMock,
  resolveSessionHistoryTranscriptPathAsync: resolveSessionHistoryTranscriptPathMock,
}));

vi.mock("./session-transcript-readers.js", () => ({
  readSessionMessagesAsync: readSessionMessagesMock,
  readSessionMessagesWithSourceAsync: async (...args: unknown[]) => ({
    messages: await readSessionMessagesMock(...args),
    transcriptPath: await resolveSessionHistoryTranscriptPathMock(...args),
  }),
}));

const {
  DEFAULT_MANAGED_IMAGE_ATTACHMENT_LIMITS,
  attachManagedOutgoingImagesToMessage,
  cleanupManagedOutgoingImageRecords,
  createManagedOutgoingImageBlocks,
  handleManagedOutgoingImageHttpRequest,
  resolveManagedImageAttachmentLimits,
} = await import("./managed-image-attachments.js");

type RequestResult = {
  statusCode: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
};

const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WnXcZ0AAAAASUVORK5CYII=";

async function createPngDataUrl(width: number, height: number): Promise<string> {
  const buffer = createSolidPngBuffer(width, height, { r: 24, g: 64, b: 128 });
  return `data:image/png;base64,${buffer.toString("base64")}`;
}

async function createNoisyPngBuffer(width: number, height: number): Promise<Buffer> {
  return createNoisyPngFixtureBuffer(width, height);
}

function requireAttachmentIdFromUrl(url: unknown): string {
  expect(url).toBeTypeOf("string");
  const attachmentId = String(url).split("/").at(-2);
  if (!attachmentId) {
    throw new Error(`expected attachment id in URL ${String(url)}`);
  }
  return attachmentId;
}

async function expectPathMissing(targetPath: string): Promise<void> {
  try {
    await fs.access(targetPath);
  } catch (error) {
    expect((error as NodeJS.ErrnoException).code).toBe("ENOENT");
    return;
  }
  throw new Error(`expected ${targetPath} to be missing`);
}

type ManagedImageBlock = {
  type?: string;
  alt?: string;
  mimeType?: string;
  url?: string;
  openUrl?: string;
};

function requireBlock(blocks: unknown[], index = 0): ManagedImageBlock {
  const block = blocks[index];
  if (!block) {
    throw new Error(`expected block ${index}`);
  }
  return block as ManagedImageBlock;
}

function requireManagedOriginalPath(stateDir: string, attachmentId: string): string {
  const record = readManagedImageRecord(attachmentId, stateDir);
  if (!record) {
    throw new Error(`expected managed image record ${attachmentId}`);
  }
  return path.join(stateDir, "media", record.original.mediaSubdir, record.original.mediaId);
}

async function createFixture(
  stateDir: string,
  options?: { sessionKey?: string; agentId?: string; attachmentId?: string; filename?: string },
) {
  const attachmentId = options?.attachmentId ?? "11111111-1111-4111-8111-111111111111";
  const sessionKey = options?.sessionKey ?? "agent:main:main";
  const filename = options?.filename ?? `${attachmentId}-cat-full.png`;
  const originalPath = path.join(stateDir, "media", MANAGED_OUTGOING_ORIGINALS_SUBDIR, filename);
  await fs.mkdir(path.dirname(originalPath), { recursive: true });
  await fs.writeFile(originalPath, Buffer.from("original-image"));
  insertManagedImageRecord(
    {
      attachmentId,
      sessionKey,
      ...(options?.agentId ? { agentId: options.agentId } : {}),
      messageId: "msg-1",
      createdAt: new Date().toISOString(),
      alt: "Cat",
      original: {
        mediaRoot: path.join(stateDir, "media"),
        mediaId: filename,
        mediaSubdir: MANAGED_OUTGOING_ORIGINALS_SUBDIR,
        contentType: "image/png",
        width: 1024,
        height: 768,
        sizeBytes: 14,
        filename: "cat.png",
      },
    },
    stateDir,
  );
  return { attachmentId, sessionKey, originalPath };
}

async function requestManagedImage(params: {
  stateDir: string;
  pathName: string;
  method?: string;
  scopes?: string[];
  denyAuth?: boolean;
  authResponse?: Record<string, unknown>;
  headers?: Record<string, string>;
  transcriptMessages?: Record<string, unknown>[];
  sessionEntry?: { sessionId: string; sessionFile?: string };
  resolvedTranscriptPath?: string | null;
  onReadTranscriptMessages?: () => Promise<void> | void;
}) {
  authorizeGatewayHttpRequestOrReplyMock.mockImplementation(async ({ res }) => {
    if (params.denyAuth) {
      res.statusCode = 401;
      res.end();
      return null;
    }
    return { ok: true, ...params.authResponse };
  });
  resolveOpenAiCompatibleHttpOperatorScopesMock.mockReturnValue(params.scopes ?? ["operator.read"]);
  resolveOpenAiCompatibleHttpSenderIsOwnerMock.mockImplementation((_req, requestAuth) => {
    if (requestAuth.authMethod === "token" || requestAuth.authMethod === "password") {
      return true;
    }
    return (
      requestAuth.trustDeclaredOperatorScopes === true &&
      (params.scopes ?? ["operator.read"]).includes("operator.admin")
    );
  });
  loadSessionEntryMock.mockReturnValue({
    storePath: path.join(params.stateDir, "gateway-sessions.json"),
    entry: params.sessionEntry ?? { sessionId: "sess-1", sessionFile: "session.jsonl" },
  });
  resolveSessionHistoryTranscriptPathMock.mockResolvedValue(
    params.resolvedTranscriptPath ?? params.sessionEntry?.sessionFile ?? "session.jsonl",
  );
  readSessionMessagesMock.mockImplementation(async () => {
    await params.onReadTranscriptMessages?.();
    return (
      params.transcriptMessages ?? [
        {
          role: "assistant",
          content: [
            {
              type: "image",
              url: params.pathName,
              openUrl: params.pathName,
            },
          ],
          __openclaw: { id: "msg-1" },
        },
      ]
    );
  });

  const auth = { mode: "test" } as never;
  const server = http.createServer((req, res) => {
    void (async () => {
      const handled = await handleManagedOutgoingImageHttpRequest(req, res, {
        auth,
        trustedProxies: ["127.0.0.1/32"],
        allowRealIpFallback: false,
        stateDir: params.stateDir,
      });
      if (!handled) {
        res.statusCode = 404;
        res.end("unhandled");
      }
    })();
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;

  try {
    const result = await new Promise<RequestResult>((resolve, reject) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port: address.port,
          path: params.pathName,
          method: params.method ?? "GET",
          headers: params.headers,
        },
        (res) => {
          void (async () => {
            const chunks: Buffer[] = [];
            for await (const chunk of res) {
              chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
            }
            resolve({
              statusCode: res.statusCode ?? 0,
              headers: res.headers,
              body: Buffer.concat(chunks),
            });
          })();
        },
      );
      req.on("error", reject);
      req.end();
    });

    return { result, auth };
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

describe("resolveManagedImageAttachmentLimits", () => {
  it("keeps the existing public limit shape", () => {
    expect(resolveManagedImageAttachmentLimits()).toEqual(DEFAULT_MANAGED_IMAGE_ATTACHMENT_LIMITS);
  });
});

describe("handleManagedOutgoingImageHttpRequest", () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = tempDirs.make("managed-images-");
    vi.clearAllMocks();
  });

  afterEach(async () => {
    closeOpenClawStateDatabaseForTest();
    setMediaStoreNetworkDepsForTest();
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  it("serves full images for authorized chat-history readers", async () => {
    const { attachmentId, sessionKey } = await createFixture(stateDir);

    const { result } = await requestManagedImage({
      stateDir,
      pathName: `/api/chat/media/outgoing/${encodeURIComponent(sessionKey)}/${attachmentId}/full`,
      authResponse: { authMethod: "token" },
    });

    expect(result.statusCode).toBe(200);
    expect(result.headers["content-type"]).toBe("image/png");
    expect(result.headers["content-disposition"]).toContain("inline");
    expect(result.body.toString("utf-8")).toBe("original-image");
    expect(readSessionMessagesMock).toHaveBeenCalledWith(
      {
        agentId: undefined,
        sessionEntry: {
          sessionFile: "session.jsonl",
          sessionId: "sess-1",
        },
        sessionId: "sess-1",
        sessionKey: "agent:main:main",
        storePath: path.join(stateDir, "gateway-sessions.json"),
      },
      expect.objectContaining({ allowResetArchiveFallback: true }),
    );
  });

  it("keeps serving and deleting an original after the configured media root changes", async () => {
    const fixture = await createFixture(stateDir);
    const externalConfigDir = tempDirs.make("managed-image-moved-config-");
    const isolatedHome = tempDirs.make("managed-image-moved-home-");

    try {
      await withEnvAsync(
        {
          OPENCLAW_CONFIG_PATH: path.join(externalConfigDir, "config.json"),
          OPENCLAW_HOME: isolatedHome,
          OPENCLAW_STATE_DIR: undefined,
        },
        async () => {
          const pathName = `/api/chat/media/outgoing/${encodeURIComponent(fixture.sessionKey)}/${fixture.attachmentId}/full`;
          const { result } = await requestManagedImage({
            stateDir,
            pathName,
            authResponse: { authMethod: "token" },
          });
          expect(result.statusCode).toBe(200);
          expect(result.body.toString("utf8")).toBe("original-image");

          await cleanupManagedOutgoingImageRecords({
            stateDir,
            sessionKey: fixture.sessionKey,
            forceDeleteSessionRecords: true,
          });
          await expectPathMissing(fixture.originalPath);
        },
      );
    } finally {
      await fs.rm(externalConfigDir, { recursive: true, force: true });
      await fs.rm(isolatedHome, { recursive: true, force: true });
    }
  });

  it("does not read retired record JSON at runtime", async () => {
    const attachmentId = "11111111-1111-4111-8111-111111111111";
    const sessionKey = "agent:main:main";
    const originalPath = path.join(
      stateDir,
      "media",
      MANAGED_OUTGOING_ORIGINALS_SUBDIR,
      "legacy.png",
    );
    const recordPath = path.join(stateDir, "media", "outgoing", "records", `${attachmentId}.json`);
    await fs.mkdir(path.dirname(originalPath), { recursive: true });
    await fs.mkdir(path.dirname(recordPath), { recursive: true });
    await fs.writeFile(originalPath, "legacy-image");
    await fs.writeFile(
      recordPath,
      JSON.stringify({
        attachmentId,
        sessionKey,
        messageId: "msg-1",
        createdAt: new Date().toISOString(),
        alt: "Legacy",
        original: {
          path: originalPath,
          contentType: "image/png",
          width: 1,
          height: 1,
          sizeBytes: 12,
          filename: "legacy.png",
        },
      }),
    );

    const { result } = await requestManagedImage({
      stateDir,
      pathName: `/api/chat/media/outgoing/${encodeURIComponent(sessionKey)}/${attachmentId}/full`,
      authResponse: { authMethod: "token" },
    });

    expect(result.statusCode).toBe(404);
    await expect(fs.access(recordPath)).resolves.toBeUndefined();
  });

  it("rejects unauthenticated requests before serving bytes", async () => {
    const { attachmentId, sessionKey } = await createFixture(stateDir);

    const { result } = await requestManagedImage({
      stateDir,
      pathName: `/api/chat/media/outgoing/${encodeURIComponent(sessionKey)}/${attachmentId}/full`,
      denyAuth: true,
    });

    expect(result.statusCode).toBe(401);
    expect(result.body.byteLength).toBe(0);
  });

  it("rejects non-owner trusted-proxy requests with self-declared session ownership", async () => {
    const { attachmentId, sessionKey } = await createFixture(stateDir);

    const { result } = await requestManagedImage({
      stateDir,
      pathName: `/api/chat/media/outgoing/${encodeURIComponent(sessionKey)}/${attachmentId}/full`,
      authResponse: { authMethod: "trusted-proxy", trustDeclaredOperatorScopes: true },
      headers: { "x-openclaw-requester-session-key": sessionKey },
    });

    expect(result.statusCode).toBe(403);
  });

  it("rejects device-token access with self-declared session ownership", async () => {
    const { attachmentId, sessionKey } = await createFixture(stateDir);

    const { result } = await requestManagedImage({
      stateDir,
      pathName: `/api/chat/media/outgoing/${encodeURIComponent(sessionKey)}/${attachmentId}/full`,
      authResponse: { authMethod: "device-token" },
      headers: { "x-openclaw-requester-session-key": sessionKey },
    });

    expect(result.statusCode).toBe(403);
  });

  it("serves owner trusted-proxy requests with admin scope", async () => {
    const { attachmentId, sessionKey } = await createFixture(stateDir);

    const { result } = await requestManagedImage({
      stateDir,
      pathName: `/api/chat/media/outgoing/${encodeURIComponent(sessionKey)}/${attachmentId}/full`,
      authResponse: { authMethod: "trusted-proxy", trustDeclaredOperatorScopes: true },
      scopes: ["operator.admin"],
    });

    expect(result.statusCode).toBe(200);
    expect(result.body.toString("utf-8")).toBe("original-image");
  });

  it("rejects non-GET methods", async () => {
    const { attachmentId, sessionKey } = await createFixture(stateDir);

    const { result } = await requestManagedImage({
      stateDir,
      pathName: `/api/chat/media/outgoing/${encodeURIComponent(sessionKey)}/${attachmentId}/full`,
      method: "POST",
      headers: { "x-openclaw-requester-session-key": sessionKey },
    });

    expect(result.statusCode).toBe(405);
  });

  it("rejects malformed encoded session keys", async () => {
    const { attachmentId } = await createFixture(stateDir);

    const { result } = await requestManagedImage({
      stateDir,
      pathName: `/api/chat/media/outgoing/%E0%A4%A/${attachmentId}/full`,
      authResponse: { authMethod: "device-token" },
    });

    expect(result.statusCode).toBe(404);
  });

  it("reuses the session attachment index across requests until the transcript changes", async () => {
    const { attachmentId, sessionKey } = await createFixture(stateDir);
    const sessionFile = path.join(stateDir, "sessions", "sess-main.jsonl");
    await fs.mkdir(path.dirname(sessionFile), { recursive: true });
    await fs.writeFile(sessionFile, '{"message":{}}\n', "utf-8");

    const transcriptMessages = [
      {
        __openclaw: { id: "msg-1" },
        content: [
          {
            type: "image",
            url: `/api/chat/media/outgoing/${encodeURIComponent(sessionKey)}/${attachmentId}/full`,
            openUrl: `/api/chat/media/outgoing/${encodeURIComponent(sessionKey)}/${attachmentId}/full`,
          },
        ],
      },
    ];

    const pathName = `/api/chat/media/outgoing/${encodeURIComponent(sessionKey)}/${attachmentId}/full`;
    const first = await requestManagedImage({
      stateDir,
      pathName,
      authResponse: { authMethod: "token" },
      sessionEntry: { sessionId: "sess-main", sessionFile },
      transcriptMessages,
    });
    const second = await requestManagedImage({
      stateDir,
      pathName,
      authResponse: { authMethod: "token" },
      sessionEntry: { sessionId: "sess-main", sessionFile },
      transcriptMessages,
    });

    expect(first.result.statusCode).toBe(200);
    expect(second.result.statusCode).toBe(200);
    expect(readSessionMessagesMock).toHaveBeenCalledTimes(1);

    await fs.writeFile(sessionFile, '{"message":{}}\n{"message":{"content":"updated"}}\n', "utf-8");

    const third = await requestManagedImage({
      stateDir,
      pathName,
      authResponse: { authMethod: "token" },
      sessionEntry: { sessionId: "sess-main", sessionFile },
      transcriptMessages,
    });

    expect(third.result.statusCode).toBe(200);
    expect(readSessionMessagesMock).toHaveBeenCalledTimes(2);
  });

  it("reuses the session attachment index for archive-backed requests", async () => {
    const { attachmentId, sessionKey } = await createFixture(stateDir);
    const archiveFile = path.join(
      stateDir,
      "sessions",
      "sess-main.jsonl.reset.2026-02-16T22-26-34.000Z",
    );
    await fs.mkdir(path.dirname(archiveFile), { recursive: true });
    await fs.writeFile(archiveFile, '{"message":{}}\n', "utf-8");

    const transcriptMessages = [
      {
        __openclaw: { id: "msg-1" },
        content: [
          {
            type: "image",
            url: `/api/chat/media/outgoing/${encodeURIComponent(sessionKey)}/${attachmentId}/full`,
            openUrl: `/api/chat/media/outgoing/${encodeURIComponent(sessionKey)}/${attachmentId}/full`,
          },
        ],
      },
    ];

    const pathName = `/api/chat/media/outgoing/${encodeURIComponent(sessionKey)}/${attachmentId}/full`;
    const first = await requestManagedImage({
      stateDir,
      pathName,
      authResponse: { authMethod: "token" },
      sessionEntry: { sessionId: "sess-main" },
      resolvedTranscriptPath: archiveFile,
      transcriptMessages,
    });
    const second = await requestManagedImage({
      stateDir,
      pathName,
      authResponse: { authMethod: "token" },
      sessionEntry: { sessionId: "sess-main" },
      resolvedTranscriptPath: archiveFile,
      transcriptMessages,
    });

    expect(first.result.statusCode).toBe(200);
    expect(second.result.statusCode).toBe(200);
    expect(readSessionMessagesMock).toHaveBeenCalledTimes(1);
  });

  it("does not cache a session attachment index when the transcript changes during the read", async () => {
    const { attachmentId, sessionKey } = await createFixture(stateDir);
    const sessionFile = path.join(stateDir, "sessions", "sess-main.jsonl");
    await fs.mkdir(path.dirname(sessionFile), { recursive: true });
    await fs.writeFile(sessionFile, '{"message":{}}\n', "utf-8");

    const transcriptMessages = [
      {
        __openclaw: { id: "msg-1" },
        content: [
          {
            type: "image",
            url: `/api/chat/media/outgoing/${encodeURIComponent(sessionKey)}/${attachmentId}/full`,
            openUrl: `/api/chat/media/outgoing/${encodeURIComponent(sessionKey)}/${attachmentId}/full`,
          },
        ],
      },
    ];

    let mutatedTranscript = false;
    const pathName = `/api/chat/media/outgoing/${encodeURIComponent(sessionKey)}/${attachmentId}/full`;
    const first = await requestManagedImage({
      stateDir,
      pathName,
      authResponse: { authMethod: "token" },
      sessionEntry: { sessionId: "sess-main", sessionFile },
      transcriptMessages,
      onReadTranscriptMessages: async () => {
        if (!mutatedTranscript) {
          mutatedTranscript = true;
          await fs.appendFile(sessionFile, '{"message":{"content":"updated"}}\n', "utf-8");
        }
      },
    });
    const second = await requestManagedImage({
      stateDir,
      pathName,
      authResponse: { authMethod: "token" },
      sessionEntry: { sessionId: "sess-main", sessionFile },
      transcriptMessages,
    });

    expect(first.result.statusCode).toBe(200);
    expect(second.result.statusCode).toBe(200);
    expect(readSessionMessagesMock).toHaveBeenCalledTimes(2);
  });
});

describe("createManagedOutgoingImageBlocks", () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = tempDirs.make("managed-image-blocks-");
    vi.clearAllMocks();
  });

  afterEach(async () => {
    closeOpenClawStateDatabaseForTest();
    setMediaStoreNetworkDepsForTest();
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  it("creates inline/open blocks that both point at the full image", async () => {
    const blocks = await createManagedOutgoingImageBlocks({
      sessionKey: "agent:main:main",
      mediaUrls: [`data:image/png;base64,${TINY_PNG_BASE64}`],
      stateDir,
      messageId: "msg-1",
    });

    expect(blocks).toHaveLength(1);
    const block = requireBlock(blocks);
    expect(block.type).toBe("image");
    expect(block.alt).toBe("Generated image 1");
    expect(block.mimeType).toBe("image/png");
    expect(block.url).toBe(block.openUrl);
    expect(String(block.url)).toMatch(/\/full$/);

    const attachmentId = requireAttachmentIdFromUrl(block.url);
    const record = readManagedImageRecord(attachmentId, stateDir);
    expect(record?.original.mediaSubdir).toBe(MANAGED_OUTGOING_ORIGINALS_SUBDIR);
    expect(record?.original.mediaId).toMatch(/\.png$/);
  });

  it("rejects oversized image data urls before decoding the payload", async () => {
    const oversizedDataUrl = "data:image/png;base64,AAAAAA==";

    await expect(
      createManagedOutgoingImageBlocks({
        sessionKey: "agent:main:main",
        mediaUrls: [oversizedDataUrl],
        stateDir,
        limits: {
          ...DEFAULT_MANAGED_IMAGE_ATTACHMENT_LIMITS,
          maxBytes: 3,
        },
      }),
    ).rejects.toThrow(/Generated image 1.*byte limit/);

    await expectPathMissing(path.join(stateDir, "media", "outgoing", "records"));
  });

  it("rejects semicolon-heavy malformed data urls without backtracking", async () => {
    const semicolons = ";".repeat(64);
    const malformed = `data:image/png${semicolons}`;

    await expect(
      createManagedOutgoingImageBlocks({
        sessionKey: "agent:main:main",
        mediaUrls: [malformed],
        stateDir,
      }),
    ).rejects.toThrow("Invalid image data URL");
  });

  it("rejects malformed data urls with a later ;base64, marker after a payload comma", async () => {
    await expect(
      createManagedOutgoingImageBlocks({
        sessionKey: "agent:main:main",
        mediaUrls: ["data:image/png;base64,garbage;base64,iVBORw0KGgo="],
        stateDir,
      }),
    ).rejects.toThrow("Invalid image data URL");
  });

  it("requires the base64 marker to be adjacent to the payload comma", async () => {
    await expect(
      createManagedOutgoingImageBlocks({
        sessionKey: "agent:main:main",
        mediaUrls: [`data:image/png;base64\n,${TINY_PNG_BASE64}`],
        stateDir,
      }),
    ).rejects.toThrow("Invalid image data URL");
  });

  it("preserves parameterized image data urls", async () => {
    const blocks = await createManagedOutgoingImageBlocks({
      sessionKey: "agent:main:main",
      mediaUrls: [`data:image/png;charset=utf-8;base64,${TINY_PNG_BASE64}`],
      stateDir,
    });

    expect(requireBlock(blocks).mimeType).toBe("image/png");
  });

  it("rejects data urls without a media type", async () => {
    await expect(
      createManagedOutgoingImageBlocks({
        sessionKey: "agent:main:main",
        mediaUrls: [`data:;base64,${TINY_PNG_BASE64}`],
        stateDir,
      }),
    ).rejects.toThrow("Invalid image data URL");
  });

  it("rewrites local image sources into managed display blocks without leaking the source path", async () => {
    const sourcePath = path.join(stateDir, "workspace", "fixtures", "dot.png");
    await fs.mkdir(path.dirname(sourcePath), { recursive: true });
    await fs.writeFile(sourcePath, Buffer.from(TINY_PNG_BASE64, "base64"));

    await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
      const blocks = await createManagedOutgoingImageBlocks({
        stateDir,
        sessionKey: "agent:main:main",
        mediaUrls: [sourcePath],
        localRoots: [path.join(stateDir, "workspace")],
      });

      expect(blocks).toHaveLength(1);
      const block = requireBlock(blocks);
      expect(block.type).toBe("image");
      expect(block.url).toContain("/api/chat/media/outgoing/agent%3Amain%3Amain/");
      expect(block.openUrl).toContain("/full");
      expect(block.url).toBe(block.openUrl);
      expect(JSON.stringify(block)).not.toContain(sourcePath);

      const attachmentId = requireAttachmentIdFromUrl(block.url);
      const record = readManagedImageRecord(attachmentId, stateDir);
      const originalPath = requireManagedOriginalPath(stateDir, attachmentId);
      expect(record?.original.filename).toMatch(/\.png$/);
      expect(originalPath).not.toBe(sourcePath);
      expect(originalPath).toContain(path.join(stateDir, "media", "outgoing", "originals"));
    });
  });

  it("ingests external image URLs into managed storage instead of hotlinking them", async () => {
    const imageBuffer = Buffer.from(TINY_PNG_BASE64, "base64");
    const upstream = http.createServer((req, res) => {
      expect(req.url).toBe("/remote-cat.png?sig=secret");
      res.statusCode = 200;
      res.setHeader("content-type", "image/png");
      res.end(imageBuffer);
    });

    await new Promise<void>((resolve) => {
      upstream.listen(0, "127.0.0.1", resolve);
    });
    const address = upstream.address() as AddressInfo;
    setMediaStoreNetworkDepsForTest({
      resolvePinnedHostname: async (hostname) => ({
        hostname,
        addresses: ["127.0.0.1"],
        lookup: createPinnedLookup({ hostname, addresses: ["127.0.0.1"] }),
      }),
    });

    try {
      await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        const sourceUrl = `http://127.0.0.1:${address.port}/remote-cat.png?sig=secret`;
        const blocks = await createManagedOutgoingImageBlocks({
          stateDir,
          sessionKey: "agent:main:main",
          mediaUrls: [sourceUrl],
        });

        expect(blocks).toHaveLength(1);
        const block = requireBlock(blocks);
        expect(block.alt).toBe("remote-cat.png");
        expect(block.type).toBe("image");
        expect(block.url).toContain("/api/chat/media/outgoing/agent%3Amain%3Amain/");
        expect(block.openUrl).toContain("/full");
        expect(block.url).toBe(block.openUrl);
        expect(JSON.stringify(block)).not.toContain("127.0.0.1");
        expect(JSON.stringify(block)).not.toContain("sig=secret");

        const attachmentId = requireAttachmentIdFromUrl(block.url);
        const record = readManagedImageRecord(attachmentId, stateDir);
        const originalPath = requireManagedOriginalPath(stateDir, attachmentId);
        expect(originalPath).toContain(path.join(stateDir, "media", "outgoing", "originals"));
        expect(JSON.stringify(record)).not.toContain("127.0.0.1");
        expect(JSON.stringify(record)).not.toContain("sig=secret");
        expect(await fs.readFile(originalPath)).toEqual(imageBuffer);
      });
    } finally {
      setMediaStoreNetworkDepsForTest();
      await new Promise<void>((resolve, reject) => {
        upstream.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("serves managed originals from a split config-path media root", async () => {
    const openClawHome = tempDirs.make("managed-image-home-");
    const externalConfigDir = tempDirs.make("managed-image-config-");
    const splitStateDir = path.join(openClawHome, ".openclaw");
    const sourcePath = path.join(splitStateDir, "workspace", "fixtures", "dot.png");
    await fs.mkdir(path.dirname(sourcePath), { recursive: true });
    await fs.writeFile(sourcePath, Buffer.from(TINY_PNG_BASE64, "base64"));

    try {
      await withEnvAsync(
        {
          OPENCLAW_HOME: openClawHome,
          OPENCLAW_CONFIG_PATH: path.join(externalConfigDir, "config.json"),
          OPENCLAW_STATE_DIR: undefined,
        },
        async () => {
          const blocks = await createManagedOutgoingImageBlocks({
            stateDir: splitStateDir,
            sessionKey: "agent:main:main",
            messageId: "msg-1",
            mediaUrls: [sourcePath],
            localRoots: [path.join(splitStateDir, "workspace")],
          });

          const attachmentId = requireAttachmentIdFromUrl(blocks[0]?.url);
          const record = readManagedImageRecord(attachmentId, splitStateDir);
          if (!record) {
            throw new Error(`expected managed image record ${attachmentId}`);
          }
          const originalPath = path.join(
            externalConfigDir,
            "media",
            record.original.mediaSubdir,
            record.original.mediaId,
          );

          expect(originalPath).toContain(
            path.join(externalConfigDir, "media", "outgoing", "originals"),
          );
          expect(record.original.mediaRoot).toBe(path.join(externalConfigDir, "media"));
          await expect(fs.access(originalPath)).resolves.toBeUndefined();

          const { result } = await requestManagedImage({
            stateDir: splitStateDir,
            pathName: String(blocks[0]?.url),
            authResponse: { authMethod: "token" },
          });
          expect(result.statusCode).toBe(200);
          expect(result.body).toEqual(Buffer.from(TINY_PNG_BASE64, "base64"));

          await cleanupManagedOutgoingImageRecords({
            stateDir: splitStateDir,
            sessionKey: "agent:main:main",
            forceDeleteSessionRecords: true,
          });
          await expectPathMissing(originalPath);
        },
      );
    } finally {
      closeOpenClawStateDatabaseForTest();
      await fs.rm(openClawHome, { recursive: true, force: true });
      await fs.rm(externalConfigDir, { recursive: true, force: true });
    }
  });

  it("merges configured managed image limits with defaults", () => {
    expect(resolveManagedImageAttachmentLimits()).toEqual(DEFAULT_MANAGED_IMAGE_ATTACHMENT_LIMITS);
    expect(
      resolveManagedImageAttachmentLimits({
        maxWidth: 8192,
        maxHeight: 2048,
      }),
    ).toEqual({
      ...DEFAULT_MANAGED_IMAGE_ATTACHMENT_LIMITS,
      maxWidth: 8192,
      maxHeight: 2048,
    });
  });

  it("rejects managed outgoing images that exceed configured byte limits", async () => {
    await expect(
      createManagedOutgoingImageBlocks({
        stateDir,
        sessionKey: "agent:main:main",
        mediaUrls: [`data:image/png;base64,${TINY_PNG_BASE64}`],
        limits: { maxBytes: 32 },
      }),
    ).rejects.toThrow(/0MB limit|32 bytes|byte limit/i);
  });

  it("adds a warning block when an image is resized to fit limits", async () => {
    const blocks = await createManagedOutgoingImageBlocks({
      sessionKey: "agent:main:main",
      mediaUrls: [await createPngDataUrl(200, 120)],
      stateDir,
      limits: { maxWidth: 64, maxHeight: 64, maxPixels: 4096 },
    });

    expect(blocks).toHaveLength(2);
    expect(blocks[0]?.type).toBe("image");
    expect(requireBlock(blocks, 1).type).toBe("text");
  });

  it("skips broken attachments when continueOnPrepareError is enabled", async () => {
    const onPrepareError = vi.fn();
    const blocks = await createManagedOutgoingImageBlocks({
      sessionKey: "agent:main:main",
      mediaUrls: [await createPngDataUrl(32, 32), path.join(stateDir, "missing.png")],
      stateDir,
      localRoots: [stateDir],
      continueOnPrepareError: true,
      onPrepareError,
    });

    expect(blocks).toHaveLength(1);
    expect(requireBlock(blocks).type).toBe("image");
    expect(onPrepareError).toHaveBeenCalledTimes(1);
    const firstPrepareError = onPrepareError.mock.calls[0]?.[0];
    expect(firstPrepareError).toBeInstanceOf(Error);
    expect(firstPrepareError?.message).toMatch(
      /Managed image attachment .* could not be prepared/i,
    );
  });

  it("accepts URL images up to the configured managed-image byte limit", async () => {
    const imageBuffer = await createNoisyPngBuffer(1600, 1200);
    expect(imageBuffer.byteLength).toBeGreaterThan(5 * 1024 * 1024);
    expect(imageBuffer.byteLength).toBeLessThan(DEFAULT_MANAGED_IMAGE_ATTACHMENT_LIMITS.maxBytes);

    const server = http.createServer((_req, res) => {
      res.statusCode = 200;
      res.setHeader("content-type", "image/png");
      res.end(imageBuffer);
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address() as AddressInfo;
    setMediaStoreNetworkDepsForTest({
      resolvePinnedHostname: async (hostname) => ({
        hostname,
        addresses: ["127.0.0.1"],
        lookup: createPinnedLookup({ hostname, addresses: ["127.0.0.1"] }),
      }),
    });

    try {
      await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        const blocks = await createManagedOutgoingImageBlocks({
          sessionKey: "agent:main:main",
          mediaUrls: [`http://127.0.0.1:${address.port}/large-image.png`],
          stateDir,
        });

        expect(blocks).toHaveLength(1);
        expect(requireBlock(blocks).type).toBe("image");
      });
    } finally {
      setMediaStoreNetworkDepsForTest();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("rejects local image paths outside allowed roots", async () => {
    const outsideDir = tempDirs.make("managed-image-outside-");
    const outsidePath = path.join(outsideDir, "outside.png");
    await fs.writeFile(outsidePath, Buffer.from(TINY_PNG_BASE64, "base64"));

    try {
      await expect(
        createManagedOutgoingImageBlocks({
          sessionKey: "agent:main:main",
          mediaUrls: [outsidePath],
          stateDir,
          localRoots: [path.join(stateDir, "workspace")],
        }),
      ).rejects.toThrow(/could not be prepared/i);
    } finally {
      await fs.rm(outsideDir, { recursive: true, force: true });
    }
  });

  it("accepts local image paths inside allowed roots", async () => {
    const allowedDir = path.join(stateDir, "workspace", "uploads");
    const allowedPath = path.join(allowedDir, "inside.png");
    await fs.mkdir(allowedDir, { recursive: true });
    await fs.writeFile(allowedPath, Buffer.from(TINY_PNG_BASE64, "base64"));

    const blocks = await createManagedOutgoingImageBlocks({
      sessionKey: "agent:main:main",
      mediaUrls: [allowedPath],
      stateDir,
      localRoots: [path.join(stateDir, "workspace")],
    });

    expect(blocks).toHaveLength(1);
    expect(requireBlock(blocks).type).toBe("image");
  });

  it("allows managed inbound image paths before validating explicit roots", async () => {
    const inboundPath = path.join(stateDir, "media", "inbound", "inbound.png");
    await fs.mkdir(path.dirname(inboundPath), { recursive: true });
    await fs.writeFile(inboundPath, Buffer.from(TINY_PNG_BASE64, "base64"));

    await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
      const blocks = await createManagedOutgoingImageBlocks({
        sessionKey: "agent:main:main",
        mediaUrls: [inboundPath],
        stateDir,
        localRoots: [path.parse(stateDir).root],
      });

      expect(blocks).toHaveLength(1);
      expect(requireBlock(blocks).type).toBe("image");
    });
  });

  it("rejects relative local image paths that resolve outside allowed roots", async () => {
    const allowedWorkspaceDir = path.join(stateDir, "workspace");
    const outsidePath = path.join(stateDir, "outside.png");
    await fs.mkdir(allowedWorkspaceDir, { recursive: true });
    await fs.writeFile(outsidePath, Buffer.from(TINY_PNG_BASE64, "base64"));

    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(allowedWorkspaceDir);
    try {
      await expect(
        createManagedOutgoingImageBlocks({
          sessionKey: "agent:main:main",
          mediaUrls: ["../outside.png"],
          stateDir,
          localRoots: [allowedWorkspaceDir],
        }),
      ).rejects.toThrow(/could not be prepared/i);
    } finally {
      cwdSpy.mockRestore();
    }
  });

  it("drops downloaded non-image sources without leaving orphaned originals", async () => {
    const pdfPath = path.join(stateDir, "not-an-image.pdf");
    await fs.writeFile(pdfPath, Buffer.from("%PDF-1.4\n% test\n"));

    const blocks = await createManagedOutgoingImageBlocks({
      sessionKey: "agent:main:main",
      mediaUrls: [pdfPath],
      stateDir,
      localRoots: [stateDir],
    });
    expect(blocks).toStrictEqual([]);
    const originalsDir = path.join(stateDir, "media", "outgoing", "originals");
    let originals: string[] | null = null;
    try {
      originals = await fs.readdir(originalsDir);
    } catch (error) {
      expect((error as NodeJS.ErrnoException).code).toBe("ENOENT");
    }
    expect(originals ?? []).toStrictEqual([]);
  });

  it("skips oversized downloaded non-image sources instead of failing finalization", async () => {
    const audioPath = path.join(stateDir, "large-audio.mp3");
    await fs.writeFile(audioPath, Buffer.alloc(2048, 1));

    const blocks = await createManagedOutgoingImageBlocks({
      sessionKey: "agent:main:main",
      mediaUrls: [audioPath],
      stateDir,
      localRoots: [stateDir],
      limits: { maxBytes: 1024 },
    });
    expect(blocks).toStrictEqual([]);
    const originalsDir = path.join(stateDir, "media", "outgoing", "originals");
    let originals: string[] | null = null;
    try {
      originals = await fs.readdir(originalsDir);
    } catch (error) {
      expect((error as NodeJS.ErrnoException).code).toBe("ENOENT");
    }
    expect(originals ?? []).toStrictEqual([]);
  });

  it("does not reap older transient records while creating a new managed image", async () => {
    const staleOriginalPath = path.join(stateDir, "files", "stale-cat.png");
    const staleAttachmentId = "stale-att";
    const staleRecordPath = path.join(
      stateDir,
      "media",
      "outgoing",
      "records",
      `${staleAttachmentId}.json`,
    );
    await fs.mkdir(path.dirname(staleOriginalPath), { recursive: true });
    await fs.mkdir(path.dirname(staleRecordPath), { recursive: true });
    await fs.writeFile(staleOriginalPath, Buffer.from(TINY_PNG_BASE64, "base64"));
    await fs.writeFile(
      staleRecordPath,
      JSON.stringify(
        {
          attachmentId: staleAttachmentId,
          sessionKey: "agent:main:main",
          messageId: null,
          createdAt: new Date(0).toISOString(),
          updatedAt: new Date(0).toISOString(),
          retentionClass: "transient",
          alt: "Stale cat",
          original: {
            path: staleOriginalPath,
            contentType: "image/png",
            width: 1,
            height: 1,
            sizeBytes: Buffer.from(TINY_PNG_BASE64, "base64").byteLength,
            filename: "stale-cat.png",
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    await createManagedOutgoingImageBlocks({
      sessionKey: "agent:main:main",
      mediaUrls: [`data:image/png;base64,${TINY_PNG_BASE64}`],
      stateDir,
    });

    await expect(fs.access(staleRecordPath)).resolves.toBeUndefined();
    await expect(fs.access(staleOriginalPath)).resolves.toBeUndefined();
  });
});

describe("attachManagedOutgoingImagesToMessage", () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = tempDirs.make("managed-image-attach-");
    vi.clearAllMocks();
  });

  afterEach(async () => {
    closeOpenClawStateDatabaseForTest();
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  it("upgrades transient image records to history when the message is committed", async () => {
    const blocks = await createManagedOutgoingImageBlocks({
      sessionKey: "agent:main:main",
      mediaUrls: [`data:image/png;base64,${TINY_PNG_BASE64}`],
      stateDir,
    });

    await attachManagedOutgoingImagesToMessage({
      messageId: "msg-committed",
      blocks: blocks as Record<string, unknown>[],
      stateDir,
    });

    const attachmentId = requireAttachmentIdFromUrl(blocks[0]?.url);
    const record = readManagedImageRecord(attachmentId, stateDir);
    expect(record?.messageId).toBe("msg-committed");
    expect(record?.retentionClass).toBe("history");
    expect(typeof record?.updatedAt).toBe("string");
  });
});

describe("cleanupManagedOutgoingImageRecords", () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = tempDirs.make("managed-image-cleanup-");
    vi.clearAllMocks();
    getRuntimeConfigMock.mockReturnValue({});
  });

  afterEach(async () => {
    closeOpenClawStateDatabaseForTest();
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  it("cleans up dereferenced records and original files", async () => {
    const fixture = await createFixture(stateDir);
    loadSessionEntryMock.mockReturnValue({
      storePath: path.join(stateDir, "gateway-sessions.json"),
      entry: { sessionId: "sess-main", sessionFile: "/tmp/sess-main.jsonl" },
    });
    readSessionMessagesMock.mockReturnValue([]);

    const result = await cleanupManagedOutgoingImageRecords({ stateDir });

    expect(result.deletedRecordCount).toBe(1);
    expect(result.deletedFileCount).toBe(1);
    expect(result.retainedCount).toBe(0);
    await expectPathMissing(fixture.originalPath);
  });

  it("retries a durably claimed file deletion after a filesystem failure", async () => {
    const fixture = await createFixture(stateDir);
    loadSessionEntryMock.mockReturnValue({
      storePath: path.join(stateDir, "gateway-sessions.json"),
      entry: { sessionId: "sess-main", sessionFile: "/tmp/sess-main.jsonl" },
    });
    readSessionMessagesMock.mockReturnValue([]);
    const rmSpy = vi.spyOn(fs, "rm").mockRejectedValueOnce(new Error("synthetic rm failure"));

    let failed: Awaited<ReturnType<typeof cleanupManagedOutgoingImageRecords>>;
    try {
      failed = await cleanupManagedOutgoingImageRecords({ stateDir });
    } finally {
      rmSpy.mockRestore();
    }

    expect(failed).toEqual({ deletedRecordCount: 0, deletedFileCount: 0, retainedCount: 1 });
    expect(readManagedImageRecord(fixture.attachmentId, stateDir)).toBeNull();
    await expect(fs.access(fixture.originalPath)).resolves.toBeUndefined();

    const retried = await cleanupManagedOutgoingImageRecords({ stateDir });

    expect(retried).toEqual({ deletedRecordCount: 1, deletedFileCount: 1, retainedCount: 0 });
    await expectPathMissing(fixture.originalPath);
  });

  it("reaps aged files left before a SQLite record was committed", async () => {
    const orphanPath = path.join(
      stateDir,
      "media",
      MANAGED_OUTGOING_ORIGINALS_SUBDIR,
      "orphan.png",
    );
    await fs.mkdir(path.dirname(orphanPath), { recursive: true });
    await fs.writeFile(orphanPath, "orphan");
    await fs.utimes(orphanPath, new Date(0), new Date(0));

    const result = await cleanupManagedOutgoingImageRecords({
      stateDir,
      nowMs: 1_000_000,
      transientMaxAgeMs: 1_000,
    });

    expect(result).toEqual({ deletedRecordCount: 0, deletedFileCount: 1, retainedCount: 0 });
    await expectPathMissing(orphanPath);
  });

  it("does not reap old unindexed files while legacy metadata still exists", async () => {
    const orphanPath = path.join(
      stateDir,
      "media",
      MANAGED_OUTGOING_ORIGINALS_SUBDIR,
      "legacy-owned.png",
    );
    const legacyRecordPath = path.join(
      stateDir,
      "media",
      "outgoing",
      "records",
      "11111111-1111-4111-8111-111111111111.json",
    );
    await fs.mkdir(path.dirname(orphanPath), { recursive: true });
    await fs.mkdir(path.dirname(legacyRecordPath), { recursive: true });
    await fs.writeFile(orphanPath, "legacy");
    await fs.writeFile(legacyRecordPath, "{}");
    await fs.utimes(orphanPath, new Date(0), new Date(0));

    const result = await cleanupManagedOutgoingImageRecords({
      stateDir,
      nowMs: 1_000_000,
      transientMaxAgeMs: 1_000,
    });

    expect(result).toEqual({ deletedRecordCount: 0, deletedFileCount: 0, retainedCount: 0 });
    await expect(fs.access(orphanPath)).resolves.toBeUndefined();
  });

  it("fails closed when the legacy metadata directory cannot be inspected", async () => {
    const orphanPath = path.join(
      stateDir,
      "media",
      MANAGED_OUTGOING_ORIGINALS_SUBDIR,
      "unknown-owner.png",
    );
    await fs.mkdir(path.dirname(orphanPath), { recursive: true });
    await fs.writeFile(orphanPath, "unknown");
    await fs.utimes(orphanPath, new Date(0), new Date(0));
    const readdirSpy = vi
      .spyOn(fs, "readdir")
      .mockRejectedValueOnce(Object.assign(new Error("denied"), { code: "EACCES" }));

    let result!: Awaited<ReturnType<typeof cleanupManagedOutgoingImageRecords>>;
    try {
      result = await cleanupManagedOutgoingImageRecords({ stateDir, nowMs: 1_000_000 });
    } finally {
      readdirSpy.mockRestore();
    }

    expect(result).toEqual({ deletedRecordCount: 0, deletedFileCount: 0, retainedCount: 0 });
    await expect(fs.access(orphanPath)).resolves.toBeUndefined();
  });

  it("retains committed records that are still referenced by a full-image block", async () => {
    const fixture = await createFixture(stateDir);
    loadSessionEntryMock.mockReturnValue({
      storePath: path.join(stateDir, "gateway-sessions.json"),
      entry: { sessionId: "sess-main", sessionFile: "/tmp/sess-main.jsonl" },
    });
    readSessionMessagesMock.mockReturnValue([
      {
        __openclaw: { id: "msg-1" },
        content: [
          {
            type: "image",
            url: `/api/chat/media/outgoing/${encodeURIComponent(fixture.sessionKey)}/${fixture.attachmentId}/full`,
            openUrl: `/api/chat/media/outgoing/${encodeURIComponent(fixture.sessionKey)}/${fixture.attachmentId}/full`,
          },
        ],
      },
    ]);

    const result = await cleanupManagedOutgoingImageRecords({ stateDir });

    expect(result.deletedRecordCount).toBe(0);
    expect(result.deletedFileCount).toBe(0);
    expect(result.retainedCount).toBe(1);
    await expect(fs.access(fixture.originalPath)).resolves.toBeUndefined();
    expect(readSessionMessagesMock).toHaveBeenCalledWith(
      {
        agentId: undefined,
        sessionEntry: {
          sessionFile: "/tmp/sess-main.jsonl",
          sessionId: "sess-main",
        },
        sessionId: "sess-main",
        sessionKey: "agent:main:main",
        storePath: path.join(stateDir, "gateway-sessions.json"),
      },
      expect.objectContaining({ allowResetArchiveFallback: true }),
    );
  });

  it("reads each session transcript once while evaluating committed records", async () => {
    const firstFixture = await createFixture(stateDir, {
      attachmentId: "11111111-1111-4111-8111-111111111111",
      filename: "att-1.png",
    });
    const secondFixture = await createFixture(stateDir, {
      attachmentId: "22222222-2222-4222-8222-222222222222",
      filename: "att-2.png",
    });
    loadSessionEntryMock.mockReturnValue({
      storePath: path.join(stateDir, "gateway-sessions.json"),
      entry: { sessionId: "sess-main", sessionFile: "/tmp/sess-main.jsonl" },
    });
    readSessionMessagesMock.mockReturnValue([
      {
        __openclaw: { id: "msg-1" },
        content: [
          {
            type: "image",
            url: `/api/chat/media/outgoing/${encodeURIComponent(firstFixture.sessionKey)}/${firstFixture.attachmentId}/full`,
            openUrl: `/api/chat/media/outgoing/${encodeURIComponent(firstFixture.sessionKey)}/${firstFixture.attachmentId}/full`,
          },
          {
            type: "image",
            url: `/api/chat/media/outgoing/${encodeURIComponent(secondFixture.sessionKey)}/${secondFixture.attachmentId}/full`,
            openUrl: `/api/chat/media/outgoing/${encodeURIComponent(secondFixture.sessionKey)}/${secondFixture.attachmentId}/full`,
          },
        ],
      },
    ]);

    const result = await cleanupManagedOutgoingImageRecords({ stateDir });

    expect(result.deletedRecordCount).toBe(0);
    expect(result.deletedFileCount).toBe(0);
    expect(result.retainedCount).toBe(2);
    expect(readSessionMessagesMock).toHaveBeenCalledTimes(1);
  });

  it("does not delete files still referenced by other sessions during session-scoped cleanup", async () => {
    const retainedFixture = await createFixture(stateDir, {
      sessionKey: "agent:other:session",
      attachmentId: "33333333-3333-4333-8333-333333333333",
    });
    const deletedFixture = await createFixture(stateDir, {
      sessionKey: "agent:main:main",
      attachmentId: "44444444-4444-4444-8444-444444444444",
    });

    loadSessionEntryMock.mockImplementation((sessionKey: string) => ({
      storePath: path.join(stateDir, "gateway-sessions.json"),
      entry: {
        sessionId: sessionKey === retainedFixture.sessionKey ? "sess-other" : "sess-main",
        sessionFile: "/tmp/session.jsonl",
      },
    }));
    readSessionMessagesMock.mockReturnValue([]);

    const result = await cleanupManagedOutgoingImageRecords({
      stateDir,
      sessionKey: deletedFixture.sessionKey,
      forceDeleteSessionRecords: true,
    });

    expect(result.deletedRecordCount).toBe(1);
    expect(result.retainedCount).toBe(1);
    await expect(fs.access(retainedFixture.originalPath)).resolves.toBeUndefined();
  });

  it("retains other selected-agent global records during scoped cleanup", async () => {
    const retainedFixture = await createFixture(stateDir, {
      sessionKey: "global",
      agentId: "work",
      attachmentId: "55555555-5555-4555-8555-555555555555",
    });
    const deletedFixture = await createFixture(stateDir, {
      sessionKey: "global",
      agentId: "main",
      attachmentId: "66666666-6666-4666-8666-666666666666",
    });
    loadSessionEntryMock.mockReturnValue({
      storePath: path.join(stateDir, "gateway-sessions.json"),
      entry: { sessionId: "sess-main-global", sessionFile: "/tmp/global-main.jsonl" },
    });
    readSessionMessagesMock.mockReturnValue([]);

    const result = await cleanupManagedOutgoingImageRecords({
      stateDir,
      sessionKey: "global",
      agentId: "main",
    });

    expect(loadSessionEntryMock).toHaveBeenCalledWith("global", { agentId: "main" });
    expect(result.deletedRecordCount).toBe(1);
    expect(result.retainedCount).toBe(1);
    await expect(fs.access(retainedFixture.originalPath)).resolves.toBeUndefined();
    await expectPathMissing(deletedFixture.originalPath);
  });

  it("treats legacy unscoped global records as the configured default agent", async () => {
    getRuntimeConfigMock.mockReturnValue({
      agents: { list: [{ id: "main" }, { id: "work", default: true }] },
    });
    const deletedFixture = await createFixture(stateDir, {
      sessionKey: "global",
      attachmentId: "88888888-8888-4888-8888-888888888888",
    });
    const retainedFixture = await createFixture(stateDir, {
      sessionKey: "global",
      agentId: "main",
      attachmentId: "99999999-9999-4999-8999-999999999999",
    });
    loadSessionEntryMock.mockReturnValue({
      storePath: path.join(stateDir, "gateway-sessions.json"),
      entry: { sessionId: "sess-work-global", sessionFile: "/tmp/global-work.jsonl" },
    });
    readSessionMessagesMock.mockReturnValue([]);

    const result = await cleanupManagedOutgoingImageRecords({
      stateDir,
      sessionKey: "global",
      agentId: "work",
    });

    expect(result.deletedRecordCount).toBe(1);
    expect(result.retainedCount).toBe(1);
    await expectPathMissing(deletedFixture.originalPath);
    await expect(fs.access(retainedFixture.originalPath)).resolves.toBeUndefined();
  });

  it("does not retain selected-agent global records during full cleanup", async () => {
    const fixture = await createFixture(stateDir, {
      sessionKey: "global",
      agentId: "work",
      attachmentId: "77777777-7777-4777-8777-777777777777",
    });
    loadSessionEntryMock.mockReturnValue({
      storePath: path.join(stateDir, "gateway-sessions.json"),
      entry: { sessionId: "sess-work-global", sessionFile: "/tmp/global-work.jsonl" },
    });
    readSessionMessagesMock.mockReturnValue([]);

    const result = await cleanupManagedOutgoingImageRecords({ stateDir });

    expect(result.deletedRecordCount).toBe(1);
    expect(result.retainedCount).toBe(0);
    await expectPathMissing(fixture.originalPath);
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
