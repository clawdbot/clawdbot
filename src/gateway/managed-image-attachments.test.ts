// Managed image attachment tests cover storage, HTTP serving, cleanup, and
// operator authorization for generated image artifacts attached to gateway replies.
import fs from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { maxBytesForKind } from "@openclaw/media-core/constants";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import {
  createNoisyPngBuffer as createNoisyPngFixtureBuffer,
  createSolidPngBuffer,
} from "../../test/helpers/image-fixtures.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { extractToolResultMediaArtifact } from "../agents/embedded-agent-tool-media.js";
import type { ReplyMediaAttachment } from "../auto-reply/reply-payload.js";
import { resolveSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import { resolveExistingAgentSessionStoreTargetsReadOnlyResult } from "../config/sessions/targets-read-availability.js";
import { createPinnedLookup } from "../infra/net/ssrf.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import {
  completeSessionDelivery,
  enqueueSessionDelivery,
} from "../infra/session-delivery-queue-storage.js";
import { readImageProbeFromHeader, resizeToJpeg } from "../media/image-ops.js";
import { setMediaStoreNetworkDepsForTest } from "../media/store.test-support.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  attachManagedImageRecordToMessage,
  insertManagedImageRecord,
  listManagedImageRecordEntries,
  MANAGED_OUTGOING_ORIGINALS_SUBDIR,
  readManagedImageRecord,
} from "./managed-image-record-store.js";
import { makeMockHttpResponse } from "./test-http-response.js";

type PlaybackTranscodeResolution = Awaited<
  ReturnType<(typeof import("../media/playback-transcode.js"))["resolvePlaybackTranscode"]>
>;
type PlaybackModeForSourceResolver = (
  ...args: Parameters<
    (typeof import("../media/playback-transcode.js"))["resolvePlaybackModeForSource"]
  >
) => ReturnType<(typeof import("../media/playback-transcode.js"))["resolvePlaybackModeForSource"]>;

const authorizeGatewayHttpRequestOrReplyMock = vi.fn();
const resolveOpenAiCompatibleHttpOperatorScopesMock = vi.fn();
const resolveOpenAiCompatibleHttpSenderIsOwnerMock = vi.fn();
const loadSessionEntryMock = vi.fn();
const readSessionMessagesMock = vi.fn();
const getRuntimeConfigMock = vi.fn(() => ({}));
const probePlaybackMediaFileDescriptorMock = vi.fn(async () => ({ durationMs: 1000 }));
const resolvePlaybackModeForSourceMock = vi.fn<PlaybackModeForSourceResolver>();
const resolvePlaybackTranscodeMock = vi.fn(async (): Promise<PlaybackTranscodeResolution> => ({
  kind: "passthrough",
}));
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

beforeEach(() => {
  resolvePlaybackModeForSourceMock.mockReset();
  resolvePlaybackModeForSourceMock.mockImplementation(async ({ mimeType }) =>
    mimeType === "audio/x-caf" ? "transcode" : "native",
  );
});

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
  loadGatewaySessionEntryReadOnly: loadSessionEntryMock,
}));

vi.mock("./session-transcript-readers.js", () => ({
  readSessionMessagesAsync: readSessionMessagesMock,
  readSessionMessagesWithSourceAsync: async (...args: unknown[]) => ({
    messages: await readSessionMessagesMock(...args),
  }),
}));

vi.mock("../media/media-probe.js", () => ({
  probePlaybackMediaFileDescriptor: probePlaybackMediaFileDescriptorMock,
}));

vi.mock("../media/playback-transcode.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../media/playback-transcode.js")>();
  resolvePlaybackModeForSourceMock.mockImplementation(async ({ mimeType }) =>
    mimeType === "audio/x-caf" ? "transcode" : "native",
  );
  return {
    ...actual,
    resolvePlaybackModeForSource: resolvePlaybackModeForSourceMock,
    resolvePlaybackTranscode: resolvePlaybackTranscodeMock,
  };
});

const {
  DEFAULT_MANAGED_IMAGE_ATTACHMENT_LIMITS,
  MANAGED_OUTGOING_IMAGE_ARTIFACT_ID_PREFIX,
  MANAGED_OUTGOING_MEDIA_ARTIFACT_ID_PREFIX,
  attachManagedOutgoingMediaToMessage: attachManagedOutgoingImagesToMessage,
  cleanupManagedOutgoingMediaRecords: cleanupManagedOutgoingImageRecords,
  createManagedOutgoingMediaBlocks: createManagedOutgoingImageBlocksActual,
  handleManagedOutgoingMediaHttpRequest: handleManagedOutgoingImageHttpRequest,
  prepareOutgoingMediaFromReplyPayload,
  resolveManagedOutgoingMediaArtifactDownload: resolveManagedOutgoingImageArtifactDownload,
  resolveManagedImageAttachmentLimits,
} = await import("./managed-image-attachments.js");

type ManagedOutgoingImageTestParams = Omit<
  Parameters<typeof createManagedOutgoingImageBlocksActual>[0],
  "items"
> & {
  mediaUrls?: string[] | null;
  attachments?: ReplyMediaAttachment[] | null;
  allowLocalNonImage?: boolean;
};

function createManagedOutgoingImageBlocks(params: ManagedOutgoingImageTestParams) {
  const { mediaUrls, attachments, allowLocalNonImage, ...ownerParams } = params;
  return createManagedOutgoingImageBlocksActual({
    ...ownerParams,
    items: (mediaUrls ?? []).map((url, index) => {
      const attachment = attachments?.[index];
      return Object.assign(
        { url, trustedLocal: allowLocalNonImage === true },
        typeof attachment?.name === "string" ? { filename: attachment.name } : {},
        typeof attachment?.mimeType === "string" ? { mimeType: attachment.mimeType } : {},
        typeof attachment?.durationMs === "number" ? { durationMs: attachment.durationMs } : {},
        typeof attachment?.width === "number" ? { width: attachment.width } : {},
        typeof attachment?.height === "number" ? { height: attachment.height } : {},
      );
    }),
  });
}

async function replaceTestSessionEntry(
  scope: {
    agentId: string;
    env: NodeJS.ProcessEnv;
    sessionKey: string;
    storePath?: string;
  },
  entry: { sessionId: string; updatedAt: number },
): Promise<void> {
  const { replaceSessionEntry } = await import("../config/sessions/session-accessor.js");
  await replaceSessionEntry(scope, entry);
}

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
  artifactId?: string;
  alt?: string;
  mimeType?: string;
  sizeBytes?: number;
  url?: string;
  openUrl?: string;
  fileName?: string;
  playback?: "native" | "transcode";
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

function prepareAgentSessionStore(stateDir: string, agentId: string): void {
  const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
  openOpenClawAgentDatabase({ agentId, env });
  closeOpenClawAgentDatabasesForTest();
}

async function prepareManagedSessionStore(stateDir: string): Promise<void> {
  closeOpenClawAgentDatabasesForTest();
  const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
  const storePath = path.join(stateDir, "sessions.sqlite");
  await replaceTestSessionEntry(
    {
      agentId: "main",
      env,
      sessionKey: "agent:main:main",
      storePath,
    },
    { sessionId: "sess-1", updatedAt: Date.now() },
  );
  closeOpenClawAgentDatabasesForTest();
  const { loadExactSessionEntryReadOnlyResult } =
    await import("../config/sessions/session-accessor.sqlite-entry-availability.js");
  expect(
    loadExactSessionEntryReadOnlyResult({
      agentId: "main",
      env,
      sessionKey: "agent:main:main",
      storePath,
    }),
  ).toMatchObject({ found: true, value: { sessionKey: "agent:main:main" } });
  getRuntimeConfigMock.mockReturnValue({ session: { store: storePath } });
}

async function createFixture(
  stateDir: string,
  options?: {
    sessionKey?: string;
    agentId?: string;
    attachmentId?: string;
    filename?: string;
    contentType?: string;
    body?: Buffer;
    messageId?: string | null;
    createdAt?: string;
  },
) {
  const attachmentId = options?.attachmentId ?? "11111111-1111-4111-8111-111111111111";
  const sessionKey = options?.sessionKey ?? "agent:main:main";
  const filename = options?.filename ?? `${attachmentId}-cat-full.png`;
  const originalPath = path.join(stateDir, "media", MANAGED_OUTGOING_ORIGINALS_SUBDIR, filename);
  await fs.mkdir(path.dirname(originalPath), { recursive: true });
  const body = options?.body ?? Buffer.from("original-image");
  await fs.writeFile(originalPath, body);
  insertManagedImageRecord(
    {
      attachmentId,
      sessionKey,
      ...(options?.agentId ? { agentId: options.agentId } : {}),
      messageId: options?.messageId === undefined ? "msg-1" : options.messageId,
      createdAt: options?.createdAt ?? new Date().toISOString(),
      alt: "Cat",
      original: {
        mediaRoot: path.join(stateDir, "media"),
        mediaId: filename,
        mediaSubdir: MANAGED_OUTGOING_ORIGINALS_SUBDIR,
        contentType: options?.contentType ?? "image/png",
        width: options?.contentType?.startsWith("image/") === false ? null : 1024,
        height: options?.contentType?.startsWith("image/") === false ? null : 768,
        sizeBytes: body.byteLength,
        filename: options?.filename ?? "cat.png",
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
  headers?: http.ClientRequestArgs["headers"];
  transcriptMessages?: Record<string, unknown>[];
  sessionEntry?: { sessionId: string; sessionFile?: string };
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
    storePath: path.join(params.stateDir, "sessions.sqlite"),
    entry: params.sessionEntry ?? { sessionId: "sess-1", sessionFile: "session.jsonl" },
  });
  readSessionMessagesMock.mockImplementation(async () => {
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

describe("handleManagedOutgoingImageHttpRequest", () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = tempDirs.make("managed-images-");
    vi.clearAllMocks();
    await prepareManagedSessionStore(stateDir);
  });

  afterEach(async () => {
    closeOpenClawStateDatabaseForTest();
    setMediaStoreNetworkDepsForTest();
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  it("serves full images for authorized chat-history readers", async () => {
    const { attachmentId, sessionKey } = await createFixture(stateDir);
    expect(
      resolveExistingAgentSessionStoreTargetsReadOnlyResult(getRuntimeConfigMock(), "main", {
        env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
      }),
    ).toMatchObject({
      available: true,
      targets: [{ storePath: path.join(stateDir, "sessions.sqlite") }],
    });

    const { result } = await requestManagedImage({
      stateDir,
      pathName: `/api/chat/media/outgoing/${encodeURIComponent(sessionKey)}/${attachmentId}/full`,
      authResponse: { authMethod: "token" },
    });

    expect(readSessionMessagesMock).toHaveBeenCalled();
    expect(result.statusCode).toBe(200);
    expect(result.headers["content-type"]).toBe("image/png");
    expect(result.headers["content-disposition"]).toContain("inline");
    expect(result.body.toString("utf-8")).toBe("original-image");
  });

  it("serves Unicode media filenames with an encoded content disposition", async () => {
    const { attachmentId, sessionKey } = await createFixture(stateDir, {
      filename: "音声.mp3",
      contentType: "audio/mpeg",
      body: Buffer.from([0xff, 0xfb, 0x90, 0x00]),
    });
    const pathName = `/api/chat/media/outgoing/${encodeURIComponent(sessionKey)}/${attachmentId}/full`;

    const { result } = await requestManagedImage({
      stateDir,
      pathName,
      authResponse: { authMethod: "token" },
      transcriptMessages: [
        {
          role: "assistant",
          content: [{ type: "audio", url: pathName, openUrl: pathName }],
          __openclaw: { id: "msg-1" },
        },
      ],
    });

    expect(result.statusCode).toBe(200);
    expect(result.headers["content-disposition"]).toContain("filename*=UTF-8''");
    expect(result.headers["content-disposition"]).toContain("%E9%9F%B3%E5%A3%B0.mp3");
  });

  it("serves a byte range from the validated managed image", async () => {
    const { attachmentId, sessionKey } = await createFixture(stateDir);

    const { result } = await requestManagedImage({
      stateDir,
      pathName: `/api/chat/media/outgoing/${encodeURIComponent(sessionKey)}/${attachmentId}/full`,
      authResponse: { authMethod: "token" },
      headers: { range: "bytes=9-13" },
    });

    expect(result.statusCode).toBe(206);
    expect(result.headers["accept-ranges"]).toBe("bytes");
    expect(result.headers["content-range"]).toBe("bytes 9-13/14");
    expect(result.headers["content-length"]).toBe("5");
    expect(result.headers.etag).toMatch(/^"[A-Za-z0-9_-]+"$/);
    expect(result.body.toString("utf8")).toBe("image");
  });

  it("resumes managed media only for an exact If-Range HTTP-date", async () => {
    const { attachmentId, sessionKey, originalPath } = await createFixture(stateDir);
    const modified = new Date("2025-07-08T18:40:00.789Z");
    await fs.utimes(originalPath, modified, modified);
    const lastModified = (await fs.stat(originalPath)).mtime.toUTCString();
    const pathName = `/api/chat/media/outgoing/${encodeURIComponent(sessionKey)}/${attachmentId}/full`;
    const request = { stateDir, pathName, authResponse: { authMethod: "token" } };

    const initial = await requestManagedImage({ ...request, method: "HEAD" });
    expect(initial.result.statusCode).toBe(200);
    expect(initial.result.headers["last-modified"]).toBe(lastModified);
    expect(initial.result.body).toHaveLength(0);

    const partial = await requestManagedImage({
      ...request,
      headers: { range: "bytes=9-13", "if-range": lastModified },
    });
    expect(partial.result.statusCode).toBe(206);
    expect(partial.result.headers["last-modified"]).toBe(lastModified);
    expect(partial.result.body.toString("utf8")).toBe("image");

    const future = await requestManagedImage({
      ...request,
      headers: {
        range: "bytes=9-13",
        "if-range": new Date(Date.parse(lastModified) + 1000).toUTCString(),
      },
    });
    expect(future.result.statusCode).toBe(200);
    expect(future.result.headers["last-modified"]).toBe(lastModified);
    expect(future.result.body.toString("utf8")).toBe("original-image");
  });

  it("bounds future managed-media validators to the actual HTTP response date", async () => {
    const nowMs = Math.floor(Date.now() / 1000) * 1000;
    const dateNow = vi.spyOn(Date, "now").mockReturnValue(nowMs);
    try {
      const { attachmentId, sessionKey, originalPath } = await createFixture(stateDir);
      const future = new Date(nowMs + 60_000);
      await fs.utimes(originalPath, future, future);
      const futureLastModified = (await fs.stat(originalPath)).mtime.toUTCString();
      const expectedLastModified = new Date(nowMs).toUTCString();
      const pathName = `/api/chat/media/outgoing/${encodeURIComponent(sessionKey)}/${attachmentId}/full`;
      const request = { stateDir, pathName, authResponse: { authMethod: "token" } };

      const initial = await requestManagedImage({ ...request, method: "HEAD" });
      expect(initial.result.statusCode).toBe(200);
      expect(initial.result.headers["last-modified"]).toBe(expectedLastModified);
      expect(Date.parse(initial.result.headers.date ?? "")).toBeGreaterThanOrEqual(
        Date.parse(expectedLastModified),
      );

      const partial = await requestManagedImage({
        ...request,
        headers: { range: "bytes=0-4", "if-range": expectedLastModified },
      });
      expect(partial.result.statusCode).toBe(206);
      expect(partial.result.headers["last-modified"]).toBe(expectedLastModified);

      const stale = await requestManagedImage({
        ...request,
        headers: { range: "bytes=0-4", "if-range": futureLastModified },
      });
      expect(stale.result.statusCode).toBe(200);

      const unchanged = await requestManagedImage({
        ...request,
        headers: { "if-none-match": String(initial.result.headers.etag) },
      });
      expect(unchanged.result.statusCode).toBe(304);
      expect(unchanged.result.headers["last-modified"]).toBe(expectedLastModified);

      const unsatisfiable = await requestManagedImage({
        ...request,
        headers: { range: "bytes=999-" },
      });
      expect(unsatisfiable.result.statusCode).toBe(416);
      expect(unsatisfiable.result.headers["last-modified"]).toBe(expectedLastModified);
    } finally {
      dateNow.mockRestore();
    }
  });

  it.each(["GET", "HEAD"])(
    "revalidates managed media ETags before ranges for %s",
    async (method) => {
      const { attachmentId, sessionKey } = await createFixture(stateDir);
      const pathName = `/api/chat/media/outgoing/${encodeURIComponent(sessionKey)}/${attachmentId}/full`;
      const initial = await requestManagedImage({
        stateDir,
        pathName,
        authResponse: { authMethod: "token" },
      });
      const etag = initial.result.headers.etag;
      expect(etag).toMatch(/^"[A-Za-z0-9_-]+"$/);

      const { result } = await requestManagedImage({
        stateDir,
        pathName,
        method,
        authResponse: { authMethod: "token" },
        headers: {
          "if-none-match": `W/${String(etag)}`,
          range: "bytes=0-3",
          "if-range": '"stale"',
        },
      });

      expect(result.statusCode).toBe(304);
      expect(result.headers.etag).toBe(etag);
      expect(result.headers["content-length"]).toBeUndefined();
      expect(result.headers["content-range"]).toBeUndefined();
      expect(result.body).toHaveLength(0);
    },
  );

  it.each(["GET", "HEAD"] as const)(
    "revalidates managed media with If-Modified-Since before ranges for %s",
    async (method) => {
      const { attachmentId, sessionKey } = await createFixture(stateDir);
      const pathName = `/api/chat/media/outgoing/${encodeURIComponent(sessionKey)}/${attachmentId}/full`;
      const request = { stateDir, pathName, authResponse: { authMethod: "token" } };
      const initial = await requestManagedImage({ ...request, method: "HEAD" });
      const lastModified = initial.result.headers["last-modified"];
      expect(lastModified).toEqual(expect.any(String));

      const unchanged = await requestManagedImage({
        ...request,
        method,
        headers: {
          "if-modified-since": String(lastModified),
          range: "bytes=0-3",
          "if-range": '"stale"',
        },
      });

      expect(unchanged.result.statusCode).toBe(304);
      expect(unchanged.result.headers["last-modified"]).toBe(lastModified);
      expect(unchanged.result.headers["content-length"]).toBeUndefined();
      expect(unchanged.result.headers["content-range"]).toBeUndefined();
      expect(unchanged.result.body).toHaveLength(0);
    },
  );

  it.each(["GET", "HEAD"] as const)(
    "ignores duplicate managed-media dates discarded by normalized Node headers for %s",
    async (method) => {
      const { attachmentId, sessionKey } = await createFixture(stateDir);
      const pathName = `/api/chat/media/outgoing/${encodeURIComponent(sessionKey)}/${attachmentId}/full`;
      const request = { stateDir, pathName, authResponse: { authMethod: "token" } };
      const initial = await requestManagedImage({ ...request, method: "HEAD" });
      const lastModified = String(initial.result.headers["last-modified"]);

      const duplicate = await requestManagedImage({
        ...request,
        method,
        headers: [
          "Host",
          "127.0.0.1",
          "If-Modified-Since",
          lastModified,
          "iF-mOdIfIeD-sInCe",
          "not-an-http-date",
        ],
      });

      expect(duplicate.result.statusCode).toBe(200);
      expect(duplicate.result.headers["last-modified"]).toBe(lastModified);
    },
  );

  it("serves a ticketed byte range from managed audio", async () => {
    const body = Buffer.from("original-audio");
    const { attachmentId, sessionKey } = await createFixture(stateDir, {
      filename: "voice.mp3",
      contentType: "audio/mpeg",
      body,
    });
    const canonicalPath = `/api/chat/media/outgoing/${encodeURIComponent(sessionKey)}/${attachmentId}/full`;
    loadSessionEntryMock.mockReturnValue({
      storePath: path.join(stateDir, "gateway-sessions.json"),
      entry: { sessionId: "sess-1", sessionFile: "session.jsonl" },
    });
    readSessionMessagesMock.mockResolvedValue([
      {
        role: "assistant",
        content: [{ type: "audio", url: canonicalPath, openUrl: canonicalPath }],
        __openclaw: { id: "msg-1" },
      },
    ]);
    const download = await resolveManagedOutgoingImageArtifactDownload({
      sessionKey,
      artifactId: `${MANAGED_OUTGOING_MEDIA_ARTIFACT_ID_PREFIX}${attachmentId}`,
      stateDir,
    });

    const { result } = await requestManagedImage({
      stateDir,
      pathName: download?.url ?? "",
      denyAuth: true,
      headers: { range: "bytes=9-13" },
      transcriptMessages: [
        {
          role: "assistant",
          content: [{ type: "audio", url: canonicalPath, openUrl: canonicalPath }],
          __openclaw: { id: "msg-1" },
        },
      ],
    });

    expect(download?.type).toBe("audio");
    expect(result.statusCode).toBe(206);
    expect(result.headers["content-type"]).toBe("audio/mpeg");
    expect(result.headers["content-range"]).toBe(`bytes 9-13/${body.byteLength}`);
    expect(result.body.toString("utf8")).toBe("audio");
  });

  it("returns 202 while a managed playback transcode is preparing", async () => {
    resolvePlaybackTranscodeMock.mockResolvedValueOnce({ kind: "preparing" });
    const { attachmentId, sessionKey } = await createFixture(stateDir, {
      filename: "voice.caf",
      contentType: "audio/x-caf",
      body: Buffer.from("caff-original"),
    });

    const { result } = await requestManagedImage({
      stateDir,
      pathName: `/api/chat/media/outgoing/${encodeURIComponent(sessionKey)}/${attachmentId}/full?playback=1`,
      authResponse: { authMethod: "token" },
    });

    expect(result.statusCode).toBe(202);
    expect(result.headers["content-type"]).toContain("application/json");
    expect(JSON.parse(result.body.toString("utf8"))).toEqual({ status: "preparing" });
  });

  it("falls back to original managed bytes when playback transcode fails", async () => {
    resolvePlaybackTranscodeMock.mockResolvedValueOnce({ kind: "fallback" });
    const body = Buffer.from("caff-original");
    const { attachmentId, sessionKey } = await createFixture(stateDir, {
      filename: "voice.caf",
      contentType: "audio/x-caf",
      body,
    });

    const { result } = await requestManagedImage({
      stateDir,
      pathName: `/api/chat/media/outgoing/${encodeURIComponent(sessionKey)}/${attachmentId}/full?playback=1`,
      authResponse: { authMethod: "token" },
    });

    expect(result.statusCode).toBe(200);
    expect(result.headers["content-type"]).toBe("audio/x-caf");
    expect(result.headers["cache-control"]).toBe("private, no-cache");
    expect(result.headers.etag).toBeUndefined();
    expect(result.headers["last-modified"]).toBeUndefined();
    expect(result.body).toEqual(body);
  });

  it("closes the opened managed-media descriptor when playback resolution rejects", async () => {
    const { attachmentId, sessionKey, originalPath } = await createFixture(stateDir, {
      filename: "voice.caf",
      contentType: "audio/x-caf",
      body: Buffer.from("caff-original"),
    });
    authorizeGatewayHttpRequestOrReplyMock.mockResolvedValue({ ok: true, authMethod: "token" });
    resolveOpenAiCompatibleHttpOperatorScopesMock.mockReturnValue(["operator.read"]);
    resolveOpenAiCompatibleHttpSenderIsOwnerMock.mockReturnValue(true);
    loadSessionEntryMock.mockReturnValue({
      storePath: path.join(stateDir, "gateway-sessions.json"),
      entry: { sessionId: "sess-1", sessionFile: "session.jsonl" },
    });
    readSessionMessagesMock.mockResolvedValue([
      {
        role: "assistant",
        content: [
          {
            type: "audio",
            url: `/api/chat/media/outgoing/${encodeURIComponent(sessionKey)}/${attachmentId}/full`,
          },
        ],
        __openclaw: { id: "msg-1" },
      },
    ]);
    resolvePlaybackTranscodeMock.mockRejectedValueOnce(new Error("playback inspection failed"));
    const originalOpen = fs.open;
    let closeOpenedHandle: MockInstance<() => Promise<void>> | undefined;
    const openSpy = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await originalOpen(...args);
      if (String(args[0]) === originalPath) {
        closeOpenedHandle = vi.spyOn(handle, "close");
      }
      return handle;
    });
    const { res } = makeMockHttpResponse();

    try {
      await expect(
        handleManagedOutgoingImageHttpRequest(
          {
            url: `/api/chat/media/outgoing/${encodeURIComponent(sessionKey)}/${attachmentId}/full?playback=1`,
            method: "GET",
            headers: {},
          } as http.IncomingMessage,
          res,
          { auth: { mode: "test" } as never, stateDir },
        ),
      ).rejects.toThrow("playback inspection failed");
      expect(closeOpenedHandle).toHaveBeenCalledOnce();
    } finally {
      openSpy.mockRestore();
    }
  });

  it("passes native managed playback bytes through unchanged", async () => {
    const body = Buffer.from("ID3-native-audio");
    const { attachmentId, sessionKey } = await createFixture(stateDir, {
      filename: "voice.mp3",
      contentType: "audio/mpeg",
      body,
    });

    const { result } = await requestManagedImage({
      stateDir,
      pathName: `/api/chat/media/outgoing/${encodeURIComponent(sessionKey)}/${attachmentId}/full?playback=1`,
      authResponse: { authMethod: "token" },
    });

    expect(resolvePlaybackTranscodeMock).toHaveBeenCalledWith(
      expect.objectContaining({ mimeType: "audio/mpeg", kind: "audio" }),
    );
    expect(result.statusCode).toBe(200);
    expect(result.headers["cache-control"]).toBe("private, no-cache");
    expect(result.headers.etag).toBeUndefined();
    expect(result.headers["last-modified"]).toBeUndefined();
    expect(result.body).toEqual(body);
  });

  it("serves byte ranges from a cached managed playback transcode", async () => {
    const transcodedPath = path.join(stateDir, "cached-voice.m4a");
    const transcoded = Buffer.from("normalized-audio");
    await fs.writeFile(transcodedPath, transcoded);
    const playback = {
      kind: "transcoded",
      path: transcodedPath,
      contentType: "audio/mp4",
      extension: ".m4a",
    } as const;
    resolvePlaybackTranscodeMock.mockResolvedValueOnce(playback);
    const { attachmentId, sessionKey } = await createFixture(stateDir, {
      filename: "voice.caf",
      contentType: "audio/x-caf",
      body: Buffer.from("caff-original"),
    });

    const { result } = await requestManagedImage({
      stateDir,
      pathName: `/api/chat/media/outgoing/${encodeURIComponent(sessionKey)}/${attachmentId}/full?playback=1`,
      authResponse: { authMethod: "token" },
      headers: { range: "bytes=11-15" },
    });

    expect(result.statusCode).toBe(206);
    expect(result.headers["content-type"]).toBe("audio/mp4");
    expect(result.headers["cache-control"]).toBe("private, no-cache");
    expect(result.headers.etag).toBeUndefined();
    expect(result.headers["last-modified"]).toBeUndefined();
    expect(result.headers["content-disposition"]).toContain('filename="voice.m4a"');
    expect(result.headers["content-range"]).toBe(`bytes 11-15/${transcoded.byteLength}`);
    expect(result.body.toString("utf8")).toBe("audio");

    for (const method of ["GET", "HEAD"]) {
      resolvePlaybackTranscodeMock.mockResolvedValueOnce(playback);
      const exists = await requestManagedImage({
        stateDir,
        pathName: `/api/chat/media/outgoing/${encodeURIComponent(sessionKey)}/${attachmentId}/full?playback=1`,
        authResponse: { authMethod: "token" },
        method,
        headers: { "if-none-match": "*", range: "bytes=11-15" },
      });
      expect(exists.result.statusCode).toBe(304);
      expect(exists.result.headers.etag).toBeUndefined();
      expect(exists.result.headers["content-length"]).toBeUndefined();
      expect(exists.result.body).toHaveLength(0);
    }
  });

  it.each(["", "?playback=1"])(
    "advertises immutable image byte ranges without a body for HEAD%s",
    async (query) => {
      const { attachmentId, sessionKey } = await createFixture(stateDir);

      const { result } = await requestManagedImage({
        stateDir,
        pathName: `/api/chat/media/outgoing/${encodeURIComponent(sessionKey)}/${attachmentId}/full${query}`,
        method: "HEAD",
        authResponse: { authMethod: "token" },
      });

      expect(result.statusCode).toBe(200);
      expect(result.headers["accept-ranges"]).toBe("bytes");
      expect(result.headers["content-length"]).toBe("14");
      expect(result.headers.etag).toMatch(/^"[A-Za-z0-9_-]+"$/);
      expect(result.body).toHaveLength(0);
    },
  );

  it("serves an empty managed image without a body", async () => {
    const { attachmentId, sessionKey, originalPath } = await createFixture(stateDir);
    await fs.writeFile(originalPath, Buffer.alloc(0));

    const { result } = await requestManagedImage({
      stateDir,
      pathName: `/api/chat/media/outgoing/${encodeURIComponent(sessionKey)}/${attachmentId}/full`,
      authResponse: { authMethod: "token" },
    });

    expect(result.statusCode).toBe(200);
    expect(result.headers["content-length"]).toBe("0");
    expect(result.body).toHaveLength(0);
  });

  it("serves an exact transcript image through a short-lived artifact ticket", async () => {
    const { attachmentId, sessionKey } = await createFixture(stateDir);
    const canonicalPath = `/api/chat/media/outgoing/${encodeURIComponent(sessionKey)}/${attachmentId}/full`;
    loadSessionEntryMock.mockReturnValue({
      storePath: path.join(stateDir, "gateway-sessions.json"),
      entry: { sessionId: "sess-1", sessionFile: "session.jsonl" },
    });
    readSessionMessagesMock.mockResolvedValue([
      {
        role: "assistant",
        content: [{ type: "image", url: canonicalPath, openUrl: canonicalPath }],
        __openclaw: { id: "msg-1" },
      },
    ]);

    const download = await resolveManagedOutgoingImageArtifactDownload({
      sessionKey,
      artifactId: `${MANAGED_OUTGOING_IMAGE_ARTIFACT_ID_PREFIX}${attachmentId}`,
      stateDir,
    });
    expect(download?.url).toContain("mediaTicket=");

    vi.clearAllMocks();
    const { result } = await requestManagedImage({
      stateDir,
      pathName: download?.url ?? "",
      denyAuth: true,
    });

    expect(result.statusCode).toBe(200);
    expect(result.body.toString("utf-8")).toBe("original-image");
    expect(authorizeGatewayHttpRequestOrReplyMock).not.toHaveBeenCalled();

    const wrongAttachmentId = "22222222-2222-4222-8222-222222222222";
    const wrong = await requestManagedImage({
      stateDir,
      pathName: (download?.url ?? "").replace(attachmentId, wrongAttachmentId),
      denyAuth: true,
    });
    expect(wrong.result.statusCode).toBe(401);
    expect(authorizeGatewayHttpRequestOrReplyMock).toHaveBeenCalledTimes(1);
  });

  it("keeps a managed audio filename stable in artifact downloads", async () => {
    const { attachmentId, sessionKey } = await createFixture(stateDir, {
      filename: "meeting-note.mp3",
      contentType: "audio/mpeg",
      body: Buffer.from([0xff, 0xfb, 0x90, 0x00]),
    });
    const canonicalPath = `/api/chat/media/outgoing/${encodeURIComponent(sessionKey)}/${attachmentId}/full`;
    loadSessionEntryMock.mockReturnValue({
      storePath: path.join(stateDir, "sessions.sqlite"),
      entry: { sessionId: "sess-1" },
    });
    readSessionMessagesMock.mockResolvedValue([
      {
        role: "assistant",
        content: [{ type: "audio", url: canonicalPath, openUrl: canonicalPath }],
        __openclaw: { id: "msg-1" },
      },
    ]);

    const download = await resolveManagedOutgoingImageArtifactDownload({
      sessionKey,
      artifactId: `${MANAGED_OUTGOING_MEDIA_ARTIFACT_ID_PREFIX}${attachmentId}`,
      stateDir,
    });

    expect(download?.title).toBe("meeting-note.mp3");
  });

  it("serves a bounded thumbnail through the full-image artifact ticket", async () => {
    const source = createSolidPngBuffer(640, 320, { r: 24, g: 64, b: 128 });
    const { attachmentId, sessionKey } = await createFixture(stateDir, { body: source });
    const canonicalPath = `/api/chat/media/outgoing/${encodeURIComponent(sessionKey)}/${attachmentId}/full`;
    const transcriptMessages = [
      {
        role: "assistant",
        content: [{ type: "image", url: canonicalPath, openUrl: canonicalPath }],
        __openclaw: { id: "msg-1" },
      },
    ];
    loadSessionEntryMock.mockReturnValue({
      storePath: path.join(stateDir, "sessions.sqlite"),
      entry: { sessionId: "sess-1", sessionFile: "session.jsonl" },
    });
    readSessionMessagesMock.mockResolvedValue(transcriptMessages);
    const download = await resolveManagedOutgoingImageArtifactDownload({
      sessionKey,
      artifactId: `${MANAGED_OUTGOING_IMAGE_ARTIFACT_ID_PREFIX}${attachmentId}`,
      stateDir,
    });
    const thumbnailUrl = download?.url.replace(/\/full(?=\?)/u, "/thumbnail") ?? "";

    vi.clearAllMocks();
    const { result } = await requestManagedImage({
      stateDir,
      pathName: thumbnailUrl,
      denyAuth: true,
      transcriptMessages,
    });

    expect(result.statusCode).toBe(200);
    expect(result.headers["content-type"]).toBe("image/png");
    expect(result.headers["content-disposition"]).toContain("cat-thumbnail.png");
    expect(readImageProbeFromHeader(result.body)).toMatchObject({ width: 300, height: 150 });
    expect(authorizeGatewayHttpRequestOrReplyMock).not.toHaveBeenCalled();
  });

  it("rejects a managed global artifact owned by another agent", async () => {
    const { attachmentId } = await createFixture(stateDir, {
      sessionKey: "global",
      agentId: "ops",
    });

    const download = await resolveManagedOutgoingImageArtifactDownload({
      sessionKey: "global",
      agentId: "research",
      artifactId: `${MANAGED_OUTGOING_IMAGE_ARTIFACT_ID_PREFIX}${attachmentId}`,
      stateDir,
    });

    expect(download).toBeNull();
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
});

describe("createManagedOutgoingImageBlocks", () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = tempDirs.make("managed-image-blocks-");
    vi.clearAllMocks();
    await prepareManagedSessionStore(stateDir);
  });

  it("prepares deduplicated media with metadata and per-item trust aligned by URL", () => {
    expect(
      prepareOutgoingMediaFromReplyPayload({
        mediaUrls: ["/tmp/a.json", "/tmp/a.json", "/tmp/b.json"],
        trustedLocalMedia: true,
        attachments: [
          {
            path: "/tmp/a.json",
            name: "a.json",
            mimeType: "application/json",
            trustedLocalMedia: false,
          },
          {
            path: "/tmp/b.json",
            name: "b.json",
            mimeType: "application/json",
            trustedLocalMedia: true,
          },
        ],
      }),
    ).toEqual([
      {
        url: "/tmp/a.json",
        filename: "a.json",
        mimeType: "application/json",
        trustedLocal: false,
      },
      {
        url: "/tmp/b.json",
        filename: "b.json",
        mimeType: "application/json",
        trustedLocal: true,
      },
    ]);
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
    expect(block.artifactId).toBe(`${MANAGED_OUTGOING_IMAGE_ARTIFACT_ID_PREFIX}${attachmentId}`);
    expect(block.sizeBytes).toBe(Buffer.from(TINY_PNG_BASE64, "base64").byteLength);
    const record = readManagedImageRecord(attachmentId, stateDir);
    expect(record?.original.mediaSubdir).toBe(MANAGED_OUTGOING_ORIGINALS_SUBDIR);
    expect(record?.original.mediaId).toMatch(/\.png$/);
  });

  it.each([
    { providedName: "friendly-cover.png", expectedName: "friendly-cover.png" },
    { providedName: "../album\\cover\r\n.png", expectedName: "cover.png" },
  ])(
    "preserves safe generated image filenames in the record and HTTP response",
    async ({ providedName, expectedName }) => {
      const blocks = await createManagedOutgoingImageBlocks({
        sessionKey: "agent:main:main",
        mediaUrls: [`data:image/png;base64,${TINY_PNG_BASE64}`],
        attachments: [{ type: "image", name: providedName }],
        stateDir,
        messageId: "msg-1",
      });
      const block = requireBlock(blocks);
      const attachmentId = requireAttachmentIdFromUrl(block.url);

      expect(readManagedImageRecord(attachmentId, stateDir)?.original.filename).toBe(expectedName);

      const { result } = await requestManagedImage({
        stateDir,
        pathName: String(block.url),
        authResponse: { authMethod: "token" },
      });

      expect(result.statusCode).toBe(200);
      expect(result.headers["content-disposition"]).toContain(`filename="${expectedName}"`);
    },
  );

  it.each([
    { kind: "audio" as const, contentType: "audio/mpeg", fileName: "theme.mp3" },
    { kind: "video" as const, contentType: "video/mp4", fileName: "clip.mp4" },
  ])(
    "creates managed $kind blocks with media artifact ids",
    async ({ kind, contentType, fileName }) => {
      const sourcePath = path.join(stateDir, "workspace", fileName);
      await fs.mkdir(path.dirname(sourcePath), { recursive: true });
      await fs.writeFile(
        sourcePath,
        kind === "audio"
          ? Buffer.from([0xff, 0xfb, 0x90, 0x00])
          : Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32]),
      );

      const blocks = await createManagedOutgoingImageBlocks({
        sessionKey: "agent:main:main",
        mediaUrls: [sourcePath],
        stateDir,
        localRoots: [path.join(stateDir, "workspace")],
        allowLocalNonImage: true,
      });

      expect(blocks).toHaveLength(1);
      const block = requireBlock(blocks);
      expect(block).toMatchObject({
        type: kind,
        mimeType: contentType,
        fileName,
        playback: "native",
      });
      const attachmentId = requireAttachmentIdFromUrl(block.url);
      expect(block.artifactId).toBe(`${MANAGED_OUTGOING_MEDIA_ARTIFACT_ID_PREFIX}${attachmentId}`);
      expect(readManagedImageRecord(attachmentId, stateDir)?.original).toMatchObject({
        contentType,
        width: null,
        height: null,
      });
    },
  );

  it.each([
    {
      kind: "audio" as const,
      sourceName: "theme.mp3",
      providedName: "../album\\cover\r\n.mp3",
      expectedName: "cover.mp3",
    },
    {
      kind: "video" as const,
      sourceName: "clip.mp4",
      providedName: "../album\\NUL\r\n.webp",
      expectedName: "NUL_.mp4",
    },
  ])(
    "sanitizes generated $kind filenames in media blocks, records, and downloads",
    async ({ kind, sourceName, providedName, expectedName }) => {
      const sourcePath = path.join(stateDir, "workspace", sourceName);
      await fs.mkdir(path.dirname(sourcePath), { recursive: true });
      await fs.writeFile(
        sourcePath,
        kind === "audio"
          ? Buffer.from([0xff, 0xfb, 0x90, 0x00])
          : Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32]),
      );
      const blocks = await createManagedOutgoingImageBlocks({
        sessionKey: "agent:main:main",
        mediaUrls: [sourcePath],
        attachments: [{ type: kind, path: sourcePath, name: providedName }],
        stateDir,
        localRoots: [path.dirname(sourcePath)],
        allowLocalNonImage: true,
        messageId: "msg-1",
      });
      const block = requireBlock(blocks);
      const pathName = String(block.url);

      expect(block).toMatchObject({ type: kind, fileName: expectedName });
      expect(
        readManagedImageRecord(requireAttachmentIdFromUrl(pathName), stateDir)?.original.filename,
      ).toBe(expectedName);

      const { result } = await requestManagedImage({
        stateDir,
        pathName,
        authResponse: { authMethod: "token" },
        transcriptMessages: [
          {
            role: "assistant",
            content: [{ type: kind, url: pathName, openUrl: pathName }],
            __openclaw: { id: "msg-1" },
          },
        ],
      });

      expect(result.statusCode).toBe(200);
      expect(result.headers["content-disposition"]).toContain(`filename="${expectedName}"`);
    },
  );

  it.each([
    { kind: "audio" as const, contentType: "audio/mpeg" },
    { kind: "video" as const, contentType: "video/mp4" },
  ])(
    "preserves generated $kind labels without attachment metadata",
    async ({ kind, contentType }) => {
      const buffer =
        kind === "audio"
          ? Buffer.from([0xff, 0xfb, 0x90, 0x00])
          : Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32]);
      const blocks = await createManagedOutgoingImageBlocks({
        sessionKey: "agent:main:main",
        mediaUrls: [`data:${contentType};base64,${buffer.toString("base64")}`],
        stateDir,
      });

      expect(requireBlock(blocks)).toMatchObject({
        type: kind,
        fileName: `Generated ${kind} 1`,
      });
    },
  );

  it("prepares generated audio when provider attachment metadata contains malformed values", async () => {
    const sourcePath = path.join(stateDir, "workspace", "theme.mp3");
    await fs.mkdir(path.dirname(sourcePath), { recursive: true });
    await fs.writeFile(sourcePath, Buffer.from([0xff, 0xfb, 0x90, 0x00]));
    const extracted = extractToolResultMediaArtifact({
      details: {
        media: {
          mediaUrls: [sourcePath],
          attachments: [
            {
              type: "audio",
              path: sourcePath,
              name: 1,
              mimeType: false,
              durationMs: -1,
              width: Infinity,
            },
          ],
        },
      },
    });
    const onPrepareError = vi.fn();

    const blocks = await createManagedOutgoingImageBlocks({
      sessionKey: "agent:main:main",
      mediaUrls: extracted?.mediaUrls,
      attachments: extracted?.attachments,
      stateDir,
      localRoots: [path.dirname(sourcePath)],
      allowLocalNonImage: true,
      continueOnPrepareError: true,
      onPrepareError,
    });

    expect(onPrepareError).not.toHaveBeenCalled();
    expect(blocks).toHaveLength(1);
    expect(requireBlock(blocks)).toMatchObject({ type: "audio", fileName: "theme.mp3" });
  });

  it("marks exotic managed media metadata for playback transcoding", async () => {
    const sourcePath = path.join(stateDir, "workspace", "voice.caf");
    await fs.mkdir(path.dirname(sourcePath), { recursive: true });
    await fs.writeFile(sourcePath, Buffer.concat([Buffer.from("caff"), Buffer.alloc(16)]));

    const blocks = await createManagedOutgoingImageBlocks({
      sessionKey: "agent:main:main",
      mediaUrls: [sourcePath],
      stateDir,
      localRoots: [path.dirname(sourcePath)],
      allowLocalNonImage: true,
    });

    expect(requireBlock(blocks)).toMatchObject({
      type: "audio",
      mimeType: "audio/x-caf",
      playback: "transcode",
    });
  });

  it("returns a visible failure without publishing a record when playback inspection fails", async () => {
    const sourcePath = path.join(stateDir, "workspace", "voice.mp3");
    await fs.mkdir(path.dirname(sourcePath), { recursive: true });
    await fs.writeFile(sourcePath, Buffer.from([0xff, 0xfb, 0x90, 0x00]));
    resolvePlaybackModeForSourceMock.mockRejectedValueOnce(
      new Error("synthetic playback inspection failure"),
    );

    const blocks = await createManagedOutgoingImageBlocks({
      sessionKey: "agent:main:main",
      mediaUrls: [sourcePath],
      stateDir,
      localRoots: [path.dirname(sourcePath)],
      allowLocalNonImage: true,
      continueOnPrepareError: true,
    });

    expect(blocks).toEqual([
      {
        type: "attachment_error",
        attachment: {
          code: "delivery-failed",
          kind: "audio",
          label: "voice.mp3",
          mimeType: "audio/mpeg",
        },
      },
    ]);
    expect(listManagedImageRecordEntries({ stateDir })).toEqual([]);
    await expectPathMissing(path.join(stateDir, "media", "outgoing", "originals"));
  });

  it.each(["audio", "video"] as const)("caps managed %s data URLs by media kind", async (kind) => {
    const maxBytes = maxBytesForKind(kind);
    const contentType = kind === "audio" ? "audio/mpeg" : "video/mp4";
    const oversized = Buffer.alloc(maxBytes + 1).toString("base64");

    await expect(
      createManagedOutgoingImageBlocks({
        sessionKey: "agent:main:main",
        mediaUrls: [`data:${contentType};base64,${oversized}`],
        stateDir,
      }),
    ).rejects.toThrow(new RegExp(`Managed ${kind} attachment.*16 MiB byte limit`));
  });

  it("requires explicit reply trust for local audio", async () => {
    const sourcePath = path.join(stateDir, "workspace", "voice.mp3");
    await fs.mkdir(path.dirname(sourcePath), { recursive: true });
    await fs.writeFile(sourcePath, Buffer.from([0xff, 0xfb, 0x90, 0x00]));

    await expect(
      createManagedOutgoingImageBlocks({
        sessionKey: "agent:main:main",
        mediaUrls: [sourcePath],
        stateDir,
        localRoots: [path.join(stateDir, "workspace")],
      }),
    ).rejects.toThrow(/Managed audio attachment.*could not be prepared/u);
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

  it.each([
    { name: "local paths", sourceForPath: (sourcePath: string) => sourcePath },
    {
      name: "file URLs",
      sourceForPath: (sourcePath: string) => {
        const sourceUrl = pathToFileURL(sourcePath);
        sourceUrl.searchParams.set("sig", "secret");
        sourceUrl.hash = "preview";
        return sourceUrl.href;
      },
    },
  ])(
    "rewrites $name into managed display blocks without leaking the source path",
    async ({ sourceForPath }) => {
      const sourcePath = path.join(stateDir, "workspace", "fixtures", "dot.png");
      await fs.mkdir(path.dirname(sourcePath), { recursive: true });
      await fs.writeFile(sourcePath, Buffer.from(TINY_PNG_BASE64, "base64"));

      await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        const blocks = await createManagedOutgoingImageBlocks({
          stateDir,
          sessionKey: "agent:main:main",
          mediaUrls: [sourceForPath(sourcePath)],
          localRoots: [path.join(stateDir, "workspace")],
        });

        expect(blocks).toHaveLength(1);
        const block = requireBlock(blocks);
        expect(block.type).toBe("image");
        expect(block.url).toContain("/api/chat/media/outgoing/agent%3Amain%3Amain/");
        expect(block.openUrl).toContain("/full");
        expect(block.url).toBe(block.openUrl);
        expect(block.alt).toBe("dot.png");
        expect(JSON.stringify(block)).not.toContain(sourcePath);
        expect(JSON.stringify(block)).not.toContain("sig=secret");
        expect(JSON.stringify(block)).not.toContain("preview");

        const attachmentId = requireAttachmentIdFromUrl(block.url);
        const record = readManagedImageRecord(attachmentId, stateDir);
        const originalPath = requireManagedOriginalPath(stateDir, attachmentId);
        expect(record?.original.filename).toMatch(/\.png$/);
        expect(originalPath).not.toBe(sourcePath);
        expect(originalPath).toContain(path.join(stateDir, "media", "outgoing", "originals"));
      });
    },
  );

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
          await prepareManagedSessionStore(splitStateDir);
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

  it.each([
    { orientation: undefined, dimensions: "200×120" },
    { orientation: 5, dimensions: "120×200" },
    { orientation: 6, dimensions: "120×200" },
    { orientation: 7, dimensions: "120×200" },
    { orientation: 8, dimensions: "120×200" },
  ])(
    "reports display dimensions in resize warnings for orientation $orientation",
    async ({ orientation, dimensions }) => {
      let mediaUrl = await createPngDataUrl(200, 120);
      if (orientation !== undefined) {
        const jpeg = await resizeToJpeg({
          buffer: createSolidPngBuffer(200, 120, { r: 24, g: 64, b: 128 }),
          maxSide: 200,
          quality: 80,
        });
        // EXIF IFD0 contains one SHORT orientation tag; pixel axes remain 200×120.
        const exif = Buffer.from(
          "ffe1002245786966000049492a0008000000010012010300010000000100000000000000",
          "hex",
        );
        exif.writeUInt16LE(orientation, 28);
        const rotated = Buffer.concat([jpeg.subarray(0, 2), exif, jpeg.subarray(2)]);
        expect(readImageProbeFromHeader(rotated)).toMatchObject({
          width: 200,
          height: 120,
          orientation,
        });
        mediaUrl = `data:image/jpeg;base64,${rotated.toString("base64")}`;
      }
      const blocks = await createManagedOutgoingImageBlocks({
        sessionKey: "agent:main:main",
        mediaUrls: [mediaUrl],
        stateDir,
        limits: { maxWidth: 64, maxHeight: 64, maxPixels: 4096 },
      });

      expect(blocks).toHaveLength(2);
      expect(blocks[0]?.type).toBe("image");
      expect(requireBlock(blocks, 1)).toMatchObject({
        type: "text",
        text: expect.stringContaining(`resized from ${dimensions} to `),
      });
    },
  );

  it("updates generated image filenames to the actual format after resizing", async () => {
    const blocks = await createManagedOutgoingImageBlocks({
      sessionKey: "agent:main:main",
      mediaUrls: [await createPngDataUrl(200, 120)],
      attachments: [{ type: "image", name: "generated-poster.webp" }],
      stateDir,
      limits: { maxWidth: 64, maxHeight: 64, maxPixels: 4096 },
    });
    const block = requireBlock(blocks);
    const record = readManagedImageRecord(requireAttachmentIdFromUrl(block.url), stateDir);

    expect(record?.original.contentType).toBe("image/jpeg");
    expect(record?.original.filename).toBe("generated-poster.jpg");
    expect(record?.original.mediaId).toMatch(/\.jpg$/);
    expect(requireBlock(blocks, 1).type).toBe("text");
  });

  it("returns a named failure block when continueOnPrepareError is enabled", async () => {
    const onPrepareError = vi.fn();
    const blocks = await createManagedOutgoingImageBlocks({
      sessionKey: "agent:main:main",
      mediaUrls: [await createPngDataUrl(32, 32), path.join(stateDir, "missing.png")],
      stateDir,
      localRoots: [stateDir],
      continueOnPrepareError: true,
      onPrepareError,
    });

    expect(blocks).toHaveLength(2);
    expect(requireBlock(blocks).type).toBe("image");
    expect(requireBlock(blocks, 1)).toMatchObject({
      type: "attachment_error",
      attachment: {
        code: "delivery-failed",
        kind: "image",
        label: "missing.png",
      },
    });
    expect(onPrepareError).toHaveBeenCalledTimes(1);
    const firstPrepareError = onPrepareError.mock.calls[0]?.[0];
    expect(firstPrepareError).toBeInstanceOf(Error);
    expect(firstPrepareError?.message).toMatch(
      /Managed image attachment .* could not be prepared/i,
    );
  });

  it("returns an error block for malformed media data URLs and keeps later media", async () => {
    const onPrepareError = vi.fn();
    const blocks = await createManagedOutgoingImageBlocks({
      sessionKey: "agent:main:main",
      mediaUrls: ["data:audio/mpeg;base64,not-valid!", await createPngDataUrl(8, 8)],
      stateDir,
      continueOnPrepareError: true,
      onPrepareError,
    });

    expect(blocks).toHaveLength(2);
    expect(requireBlock(blocks)).toMatchObject({
      type: "attachment_error",
      attachment: { code: "delivery-failed", kind: "audio" },
    });
    expect(requireBlock(blocks, 1).type).toBe("image");
    expect(onPrepareError).toHaveBeenCalledOnce();
  });

  it("reports media with no supported content type instead of dropping it silently", async () => {
    const sourcePath = path.join(stateDir, "workspace", "mystery.blob");
    await fs.mkdir(path.dirname(sourcePath), { recursive: true });
    await fs.writeFile(sourcePath, Buffer.from([0, 1, 2, 3]));
    const onPrepareError = vi.fn();

    const blocks = await createManagedOutgoingImageBlocksActual({
      sessionKey: "agent:main:main",
      items: [{ url: sourcePath, trustedLocal: true }],
      stateDir,
      localRoots: [path.dirname(sourcePath)],
      continueOnPrepareError: true,
      onPrepareError,
    });

    expect(blocks).toEqual([
      {
        type: "attachment_error",
        attachment: {
          code: "delivery-failed",
          kind: "document",
          label: "mystery.blob",
        },
      },
    ]);
    expect(onPrepareError).toHaveBeenCalledOnce();
    expect(onPrepareError.mock.calls[0]?.[0]).toMatchObject({
      message: expect.stringMatching(/could not be prepared/u),
    });
  });

  it.each([
    {
      fileName: "config.xml",
      mimeType: "application/xml",
      body: "<config/>",
    },
    { fileName: "vector.svg", mimeType: "image/svg+xml", body: "<svg/>" },
    { fileName: "worker.py", mimeType: "text/x-python", body: "print('ready')" },
    { fileName: "script.js", mimeType: "text/javascript", body: "export default true" },
    {
      fileName: "mystery.blob",
      mimeType: "application/octet-stream",
      body: Buffer.from([0, 1, 2, 3]),
    },
  ])("rejects unsupported $mimeType metadata before persistence", async (fixture) => {
    const sourcePath = path.join(stateDir, "workspace", fixture.fileName);
    await fs.mkdir(path.dirname(sourcePath), { recursive: true });
    await fs.writeFile(sourcePath, fixture.body);

    const onPrepareError = vi.fn();
    const blocks = await createManagedOutgoingImageBlocksActual({
      sessionKey: "agent:main:main",
      items: [
        {
          url: sourcePath,
          filename: fixture.fileName,
          mimeType: fixture.mimeType,
          trustedLocal: true,
        },
      ],
      stateDir,
      localRoots: [path.dirname(sourcePath)],
      continueOnPrepareError: true,
      onPrepareError,
    });

    expect(blocks).toEqual([
      {
        type: "attachment_error",
        attachment: {
          code: "delivery-failed",
          kind: "document",
          label: fixture.fileName,
          mimeType: fixture.mimeType,
        },
      },
    ]);
    expect(onPrepareError).toHaveBeenCalledOnce();
    expect(listManagedImageRecordEntries({ stateDir })).toEqual([]);
    const originalsDir = path.join(stateDir, "media", MANAGED_OUTGOING_ORIGINALS_SUBDIR);
    await expectPathMissing(originalsDir);
  });

  it.each(["GET", "HEAD"])("does not serve legacy SVG records over %s", async (method) => {
    const body = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>');
    const { attachmentId, sessionKey } = await createFixture(stateDir, {
      filename: "vector.svg",
      contentType: "image/svg+xml",
      body,
    });
    const pathName = `/api/chat/media/outgoing/${encodeURIComponent(sessionKey)}/${attachmentId}/full`;

    const { result } = await requestManagedImage({
      stateDir,
      pathName,
      method,
      authResponse: { authMethod: "token" },
      transcriptMessages: [
        {
          role: "assistant",
          content: [
            {
              type: "attachment",
              attachment: {
                kind: "document",
                label: "vector.svg",
                mimeType: "image/svg+xml",
                url: pathName,
              },
            },
          ],
          __openclaw: { id: "msg-1" },
        },
      ],
    });

    expect(result.statusCode).toBe(404);
    expect(result.headers["content-disposition"]).toBeUndefined();
    expect(result.body).toEqual(method === "HEAD" ? Buffer.alloc(0) : Buffer.from("not found"));
  });

  it("rolls back earlier managed artifacts when a later item fails", async () => {
    const sourcePath = path.join(stateDir, "workspace", "mystery.blob");
    await fs.mkdir(path.dirname(sourcePath), { recursive: true });
    await fs.writeFile(sourcePath, Buffer.from([0, 1, 2, 3]));

    await expect(
      createManagedOutgoingImageBlocksActual({
        sessionKey: "agent:main:main",
        items: [
          {
            url: `data:image/png;base64,${TINY_PNG_BASE64}`,
            trustedLocal: false,
          },
          { url: sourcePath, trustedLocal: true },
        ],
        stateDir,
        localRoots: [path.dirname(sourcePath)],
      }),
    ).rejects.toThrow(/could not be prepared/u);

    expect(listManagedImageRecordEntries({ stateDir })).toEqual([]);
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

  it("creates managed document attachment envelopes for trusted local files", async () => {
    const pdfPath = path.join(stateDir, "not-an-image.pdf");
    await fs.writeFile(pdfPath, Buffer.from("%PDF-1.4\n% test\n"));

    const blocks = await createManagedOutgoingImageBlocks({
      sessionKey: "agent:main:main",
      mediaUrls: [pdfPath],
      stateDir,
      localRoots: [stateDir],
      allowLocalNonImage: true,
      messageId: "msg-1",
    });

    expect(blocks).toEqual([
      {
        type: "attachment",
        attachment: expect.objectContaining({
          artifactId: expect.stringMatching(/^artifact_managed_media_/u),
          kind: "document",
          label: "not-an-image.pdf",
          mimeType: "application/pdf",
          sizeBytes: 16,
          url: expect.stringMatching(/^\/api\/chat\/media\/outgoing\//u),
        }),
      },
    ]);

    const attachment = (blocks[0] as { attachment?: { artifactId?: string; url?: string } })
      .attachment;
    const { result } = await requestManagedImage({
      stateDir,
      pathName: attachment?.url ?? "",
      authResponse: { authMethod: "token" },
      transcriptMessages: [
        {
          role: "assistant",
          content: blocks,
          __openclaw: { id: "msg-1" },
        },
      ],
    });

    expect(result.statusCode).toBe(200);
    expect(result.headers["content-type"]).toBe("application/pdf");
    expect(result.headers["content-disposition"]).toContain("attachment;");
    expect(result.body).toEqual(Buffer.from("%PDF-1.4\n% test\n"));

    const download = await resolveManagedOutgoingImageArtifactDownload({
      sessionKey: "agent:main:main",
      artifactId: attachment?.artifactId ?? "",
      stateDir,
    });
    expect(download).toMatchObject({
      artifactId: attachment?.artifactId,
      type: "file",
      title: "not-an-image.pdf",
      mimeType: "application/pdf",
      sizeBytes: 16,
    });
  });

  it("prepares advertised PowerPoint documents as managed attachments", async () => {
    const pptxPath = path.join(stateDir, "deck.pptx");
    await fs.writeFile(pptxPath, Buffer.from("PK\x03\x04 pptx placeholder"));

    const blocks = await createManagedOutgoingImageBlocks({
      sessionKey: "agent:main:main",
      mediaUrls: [pptxPath],
      stateDir,
      localRoots: [stateDir],
      allowLocalNonImage: true,
      messageId: "msg-pptx",
    });

    expect(blocks).toEqual([
      {
        type: "attachment",
        attachment: expect.objectContaining({
          kind: "document",
          label: "deck.pptx",
          mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        }),
      },
    ]);
  });

  it("does not apply the configured image cap to managed audio", async () => {
    const audioPath = path.join(stateDir, "large-audio.mp3");
    await fs.writeFile(audioPath, Buffer.alloc(2048, 1));

    const blocks = await createManagedOutgoingImageBlocks({
      sessionKey: "agent:main:main",
      mediaUrls: [audioPath],
      stateDir,
      localRoots: [stateDir],
      allowLocalNonImage: true,
      limits: { maxBytes: 1024 },
    });
    expect(blocks).toHaveLength(1);
    expect(requireBlock(blocks)).toMatchObject({
      type: "audio",
      mimeType: "audio/mpeg",
      sizeBytes: 2048,
    });
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
    await prepareManagedSessionStore(stateDir);
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

    attachManagedOutgoingImagesToMessage({
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
    await prepareManagedSessionStore(stateDir);
  });

  afterEach(async () => {
    closeOpenClawAgentDatabasesForTest();
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

  it("retains an aged transient record while its session still has an active run", async () => {
    const fixture = await createFixture(stateDir, {
      messageId: null,
      createdAt: new Date(Date.now() - 16 * 60 * 1000).toISOString(),
    });

    const checkedSessionKeys: string[] = [];
    const result = await cleanupManagedOutgoingImageRecords({
      stateDir,
      hasActiveSessionRun: (sessionKey) => {
        checkedSessionKeys.push(sessionKey);
        return sessionKey === fixture.sessionKey;
      },
    });

    expect(result).toEqual({ deletedRecordCount: 0, deletedFileCount: 0, retainedCount: 1 });
    expect(checkedSessionKeys).toEqual([fixture.sessionKey]);
    await expect(fs.access(fixture.originalPath)).resolves.toBeUndefined();
    expect(
      attachManagedImageRecordToMessage({
        attachmentId: fixture.attachmentId,
        sessionKey: fixture.sessionKey,
        messageId: "msg-late",
        updatedAt: new Date().toISOString(),
        stateDir,
      }),
    ).toBe(true);
    const attached = readManagedImageRecord(fixture.attachmentId, stateDir);
    expect(attached?.messageId).toBe("msg-late");
    expect(attached?.retentionClass).toBe("history");
  });

  it("retains transient records referenced by pending prepared session delivery", async () => {
    const blocks = await createManagedOutgoingImageBlocks({
      sessionKey: "agent:main:main",
      mediaUrls: [`data:image/png;base64,${TINY_PNG_BASE64}`],
      stateDir,
    });
    const attachmentId = requireAttachmentIdFromUrl(blocks[0]?.url);
    const record = readManagedImageRecord(attachmentId, stateDir);
    if (!record) {
      throw new Error("expected pending managed media record");
    }
    const queueId = await enqueueSessionDelivery(
      {
        kind: "agentTurn",
        sessionKey: "agent:main:main",
        message: "deliver generated image",
        messageId: "generated-image-agent-turn",
        expectedMediaUrls: ["/tmp/generated.png"],
        preparedMediaBlocks: {
          "/tmp/generated.png": blocks as Array<Record<string, unknown>>,
        },
      },
      stateDir,
    );
    const afterTtl = Date.parse(record.createdAt) + 16 * 60 * 1000;

    await expect(
      cleanupManagedOutgoingImageRecords({ stateDir, nowMs: afterTtl }),
    ).resolves.toEqual({ deletedRecordCount: 0, deletedFileCount: 0, retainedCount: 1 });

    await completeSessionDelivery(queueId, stateDir);
    await expect(
      cleanupManagedOutgoingImageRecords({ stateDir, nowMs: afterTtl }),
    ).resolves.toEqual({ deletedRecordCount: 1, deletedFileCount: 1, retainedCount: 0 });
  });

  it("reaps an aged transient record once its session has no active run", async () => {
    const fixture = await createFixture(stateDir, {
      messageId: null,
      createdAt: new Date(Date.now() - 16 * 60 * 1000).toISOString(),
    });

    const result = await cleanupManagedOutgoingImageRecords({
      stateDir,
      hasActiveSessionRun: () => false,
    });

    expect(result).toEqual({ deletedRecordCount: 1, deletedFileCount: 1, retainedCount: 0 });
    expect(readManagedImageRecord(fixture.attachmentId, stateDir)).toBeNull();
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

  it("retains history records when the session table is unavailable", async () => {
    const fixture = await createFixture(stateDir);
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    const databasePath = openOpenClawAgentDatabase({ agentId: "main", env }).path;
    closeOpenClawAgentDatabasesForTest();
    const { DatabaseSync } = requireNodeSqlite();
    const database = new DatabaseSync(databasePath);
    database.exec("DROP TABLE session_nodes;");
    database.close();
    getRuntimeConfigMock.mockReturnValue({ session: { store: databasePath } });
    loadSessionEntryMock.mockReturnValue({ storePath: databasePath, entry: undefined });

    const result = await cleanupManagedOutgoingImageRecords({ stateDir });

    expect(result).toEqual({ deletedRecordCount: 0, deletedFileCount: 0, retainedCount: 1 });
    expect(readManagedImageRecord(fixture.attachmentId, stateDir)).not.toBeNull();
    await expect(fs.access(fixture.originalPath)).resolves.toBeUndefined();
    expect(readSessionMessagesMock).not.toHaveBeenCalled();
  });

  it("retains history records when the session row is unreadable", async () => {
    const fixture = await createFixture(stateDir);
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    const opened = openOpenClawAgentDatabase({ agentId: "main", env });
    opened.db
      .prepare(
        "INSERT INTO session_nodes (session_key, current_session_id, entry_json, entry_valid, updated_at) VALUES (?, ?, ?, -1, ?)",
      )
      .run("agent:main:main", "broken-session", "{invalid", Date.now());
    const databasePath = opened.path;
    closeOpenClawAgentDatabasesForTest();
    getRuntimeConfigMock.mockReturnValue({ session: { store: databasePath } });
    loadSessionEntryMock.mockReturnValue({ storePath: databasePath, entry: undefined });

    const result = await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, () =>
      cleanupManagedOutgoingImageRecords({ stateDir }),
    );

    expect(result).toEqual({ deletedRecordCount: 0, deletedFileCount: 0, retainedCount: 1 });
    expect(readManagedImageRecord(fixture.attachmentId, stateDir)).not.toBeNull();
    await expect(fs.access(fixture.originalPath)).resolves.toBeUndefined();
    expect(readSessionMessagesMock).not.toHaveBeenCalled();
  });

  it("does not let a valid fallback mask an unreadable exact row", async () => {
    const fixture = await createFixture(stateDir);
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    const opened = openOpenClawAgentDatabase({ agentId: "main", env });
    opened.db
      .prepare(
        "INSERT INTO session_nodes (session_key, current_session_id, entry_json, entry_valid, updated_at) VALUES (?, ?, ?, -1, ?)",
      )
      .run("agent:main:main", "broken-session", "{invalid", Date.now());
    const databasePath = opened.path;
    closeOpenClawAgentDatabasesForTest();
    getRuntimeConfigMock.mockReturnValue({ session: { store: databasePath } });
    loadSessionEntryMock.mockReturnValue({
      storePath: databasePath,
      entry: { sessionId: "fallback-session", sessionFile: "/tmp/fallback.jsonl" },
    });

    const result = await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, () =>
      cleanupManagedOutgoingImageRecords({ stateDir }),
    );

    expect(result).toEqual({ deletedRecordCount: 0, deletedFileCount: 0, retainedCount: 1 });
    expect(readManagedImageRecord(fixture.attachmentId, stateDir)).not.toBeNull();
    await expect(fs.access(fixture.originalPath)).resolves.toBeUndefined();
    expect(readSessionMessagesMock).not.toHaveBeenCalled();
  });

  it("retains history records when a per-agent session database is missing", async () => {
    const fixture = await createFixture(stateDir);
    const storePath = path.join(stateDir, "agents", "main", "sessions", "sessions.json");
    getRuntimeConfigMock.mockReturnValue({
      session: { store: path.join(stateDir, "agents", "{agentId}", "sessions", "sessions.json") },
    });
    loadSessionEntryMock.mockReturnValue({ storePath, entry: undefined });

    const result = await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, () =>
      cleanupManagedOutgoingImageRecords({ stateDir }),
    );

    expect(result).toEqual({ deletedRecordCount: 0, deletedFileCount: 0, retainedCount: 1 });
    expect(readManagedImageRecord(fixture.attachmentId, stateDir)).not.toBeNull();
    await expect(fs.access(fixture.originalPath)).resolves.toBeUndefined();
    expect(readSessionMessagesMock).not.toHaveBeenCalled();
  });

  it("retains history when a healthy configured store masks an unreadable candidate", async () => {
    const fixture = await createFixture(stateDir);
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    const storeTemplate = path.join(stateDir, "custom", "{agentId}", "sessions.json");
    const configuredStorePath = storeTemplate.replace("{agentId}", "main");
    const configuredTarget = resolveSqliteTargetFromSessionStorePath(configuredStorePath, {
      agentId: "main",
      env,
    });
    openOpenClawAgentDatabase({ agentId: "main", env, path: configuredTarget.path });
    closeOpenClawAgentDatabasesForTest();
    const discoveredDatabasePath = openOpenClawAgentDatabase({ agentId: "main", env }).path;
    closeOpenClawAgentDatabasesForTest();
    const { DatabaseSync } = requireNodeSqlite();
    const database = new DatabaseSync(discoveredDatabasePath);
    database.exec("DROP TABLE session_nodes;");
    database.close();
    getRuntimeConfigMock.mockReturnValue({ session: { store: storeTemplate } });
    loadSessionEntryMock.mockReturnValue({ storePath: configuredStorePath, entry: undefined });

    const result = await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, () =>
      cleanupManagedOutgoingImageRecords({ stateDir }),
    );

    expect(result).toEqual({ deletedRecordCount: 0, deletedFileCount: 0, retainedCount: 1 });
    expect(readManagedImageRecord(fixture.attachmentId, stateDir)).not.toBeNull();
    await expect(fs.access(fixture.originalPath)).resolves.toBeUndefined();
    expect(loadSessionEntryMock).not.toHaveBeenCalled();
    expect(readSessionMessagesMock).not.toHaveBeenCalled();
  });

  it("retains history when a healthy discovered store masks a missing configured store", async () => {
    const fixture = await createFixture(stateDir);
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    const storeTemplate = path.join(stateDir, "missing-custom", "{agentId}", "sessions.json");
    const discovered = openOpenClawAgentDatabase({ agentId: "main", env });
    discovered.db
      .prepare(
        "INSERT INTO session_nodes (session_key, current_session_id, entry_json, entry_valid, updated_at) VALUES (?, ?, ?, 1, ?)",
      )
      .run(
        "agent:main:main",
        "discovered-session",
        JSON.stringify({ sessionId: "discovered-session" }),
        Date.now(),
      );
    closeOpenClawAgentDatabasesForTest();
    getRuntimeConfigMock.mockReturnValue({ session: { store: storeTemplate } });
    loadSessionEntryMock.mockReturnValue({
      storePath: storeTemplate.replace("{agentId}", "main"),
      entry: undefined,
    });

    const result = await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, () =>
      cleanupManagedOutgoingImageRecords({ stateDir }),
    );

    expect(result).toEqual({ deletedRecordCount: 0, deletedFileCount: 0, retainedCount: 1 });
    expect(readManagedImageRecord(fixture.attachmentId, stateDir)).not.toBeNull();
    await expect(fs.access(fixture.originalPath)).resolves.toBeUndefined();
    expect(loadSessionEntryMock).not.toHaveBeenCalled();
    expect(readSessionMessagesMock).not.toHaveBeenCalled();
  });

  it("retains history records when a fixed store database is missing", async () => {
    const fixture = await createFixture(stateDir);
    const storePath = path.join(stateDir, "unmounted-sessions.json");
    getRuntimeConfigMock.mockReturnValue({ session: { store: storePath } });
    loadSessionEntryMock.mockReturnValue({ storePath, entry: undefined });

    const result = await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, () =>
      cleanupManagedOutgoingImageRecords({ stateDir }),
    );

    expect(result).toEqual({ deletedRecordCount: 0, deletedFileCount: 0, retainedCount: 1 });
    expect(readManagedImageRecord(fixture.attachmentId, stateDir)).not.toBeNull();
    await expect(fs.access(fixture.originalPath)).resolves.toBeUndefined();
    expect(loadSessionEntryMock).not.toHaveBeenCalled();
    expect(readSessionMessagesMock).not.toHaveBeenCalled();
  });

  it("does not assign the configured fixed store to a retired agent", async () => {
    const fixture = await createFixture(stateDir, {
      agentId: "retired",
      sessionKey: "agent:retired:main",
    });
    const storePath = path.join(stateDir, "current-sessions.json");
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    const target = resolveSqliteTargetFromSessionStorePath(storePath, { agentId: "main", env });
    const opened = openOpenClawAgentDatabase({ agentId: "main", env, path: target.path });
    opened.db
      .prepare(
        "INSERT INTO session_nodes (session_key, current_session_id, entry_json, entry_valid, updated_at) VALUES (?, ?, ?, 1, ?)",
      )
      .run("main", "current-session", JSON.stringify({ sessionId: "current-session" }), Date.now());
    closeOpenClawAgentDatabasesForTest();
    getRuntimeConfigMock.mockReturnValue({ session: { store: storePath } });
    loadSessionEntryMock.mockReturnValue({ storePath, entry: undefined });

    const result = await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, () =>
      cleanupManagedOutgoingImageRecords({ stateDir }),
    );

    expect(result).toEqual({ deletedRecordCount: 0, deletedFileCount: 0, retainedCount: 1 });
    expect(readManagedImageRecord(fixture.attachmentId, stateDir)).not.toBeNull();
    await expect(fs.access(fixture.originalPath)).resolves.toBeUndefined();
    expect(loadSessionEntryMock).not.toHaveBeenCalled();
    expect(readSessionMessagesMock).not.toHaveBeenCalled();
  });

  it("cleans retired fixed-store history after explicit ownership is readable", async () => {
    const fixture = await createFixture(stateDir, {
      agentId: "retired",
      sessionKey: "agent:retired:main",
    });
    const storePath = path.join(stateDir, "retired-readable-sessions.json");
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    await replaceTestSessionEntry(
      { agentId: "retired", env, storePath, sessionKey: "agent:retired:main" },
      { sessionId: "retired-session", updatedAt: Date.now() },
    );
    closeOpenClawAgentDatabasesForTest();
    const config = { session: { store: storePath } };
    getRuntimeConfigMock.mockReturnValue(config);
    expect(
      resolveExistingAgentSessionStoreTargetsReadOnlyResult(config, "retired", { env }),
    ).toEqual({ available: true, targets: [{ agentId: "retired", storePath }] });
    const { loadExactSessionEntryReadOnlyResult } =
      await import("../config/sessions/session-accessor.sqlite-entry-availability.js");
    expect(
      loadExactSessionEntryReadOnlyResult({
        agentId: "retired",
        sessionKey: "agent:retired:main",
        storePath,
      }),
    ).toMatchObject({ found: true, value: { sessionKey: "agent:retired:main" } });
    loadSessionEntryMock.mockReturnValue({
      storePath,
      entry: { sessionId: "retired-session", sessionFile: "/tmp/retired.jsonl" },
    });
    readSessionMessagesMock.mockReturnValue([]);

    const result = await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, () =>
      cleanupManagedOutgoingImageRecords({ stateDir }),
    );

    expect(result).toEqual({ deletedRecordCount: 1, deletedFileCount: 1, retainedCount: 0 });
    expect(readManagedImageRecord(fixture.attachmentId, stateDir)).toBeNull();
    await expectPathMissing(fixture.originalPath);
  });

  it("retains history records when a retired fixed store is unavailable", async () => {
    const fixture = await createFixture(stateDir, {
      agentId: "retired",
      sessionKey: "agent:retired:main",
    });
    const storePath = path.join(stateDir, "retired-sessions.json");
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    const target = resolveSqliteTargetFromSessionStorePath(storePath, {
      agentId: "retired",
      env,
    });
    openOpenClawAgentDatabase({ agentId: "retired", env, path: target.path });
    closeOpenClawAgentDatabasesForTest();
    const { DatabaseSync } = requireNodeSqlite();
    const database = new DatabaseSync(target.path);
    database.exec("DROP TABLE schema_meta;");
    database.close();
    const config = { session: { store: storePath } };
    getRuntimeConfigMock.mockReturnValue(config);
    loadSessionEntryMock.mockReturnValue({ storePath, entry: undefined });
    expect(
      resolveExistingAgentSessionStoreTargetsReadOnlyResult(config, "retired", { env }),
    ).toEqual({ available: false, reason: "schema-missing" });

    const result = await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, () =>
      cleanupManagedOutgoingImageRecords({ stateDir }),
    );

    expect(result).toEqual({ deletedRecordCount: 0, deletedFileCount: 0, retainedCount: 1 });
    expect(readManagedImageRecord(fixture.attachmentId, stateDir)).not.toBeNull();
    await expect(fs.access(fixture.originalPath)).resolves.toBeUndefined();
    expect(loadSessionEntryMock).not.toHaveBeenCalled();
    expect(readSessionMessagesMock).not.toHaveBeenCalled();
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
    expect(readSessionMessagesMock).toHaveBeenCalledTimes(1);
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
    getRuntimeConfigMock.mockReturnValue({
      agents: { list: [{ id: "main" }, { id: "work" }] },
      session: { store: path.join(stateDir, "sessions.sqlite") },
    });
    await replaceTestSessionEntry(
      {
        agentId: "main",
        env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
        sessionKey: "global",
        storePath: path.join(stateDir, "sessions.sqlite"),
      },
      { sessionId: "sess-main-global", updatedAt: Date.now() },
    );
    closeOpenClawAgentDatabasesForTest();
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

    expect(result.deletedRecordCount).toBe(1);
    expect(result.retainedCount).toBe(1);
    await expect(fs.access(retainedFixture.originalPath)).resolves.toBeUndefined();
    await expectPathMissing(deletedFixture.originalPath);
  });

  it.each([
    {
      label: "uses the recorded owner for unscoped session keys",
      sessionKey: "legacy-session",
      recordAgentId: "work",
    },
    {
      label: "uses an agent-scoped session key owner when the record omits agentId",
      sessionKey: "agent:work:main",
      recordAgentId: undefined,
    },
  ])("$label", async ({ sessionKey, recordAgentId }) => {
    const fixture = await createFixture(stateDir, {
      sessionKey,
      ...(recordAgentId ? { agentId: recordAgentId } : {}),
    });
    getRuntimeConfigMock.mockReturnValue({
      agents: { list: [{ id: "main" }, { id: "work" }] },
      session: { store: path.join(stateDir, "agents", "{agentId}", "sessions", "sessions.json") },
    });
    prepareAgentSessionStore(stateDir, "work");
    await replaceTestSessionEntry(
      {
        agentId: "work",
        env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
        sessionKey,
      },
      { sessionId: "sess-work", updatedAt: Date.now() },
    );
    closeOpenClawAgentDatabasesForTest();
    loadSessionEntryMock.mockReturnValue({
      storePath: path.join(stateDir, "agents", "work", "sessions", "sessions.json"),
      entry: { sessionId: "sess-work", sessionFile: "/tmp/work.jsonl" },
    });
    readSessionMessagesMock.mockReturnValue([
      {
        __openclaw: { id: "msg-1" },
        content: [
          {
            type: "image",
            url: `/api/chat/media/outgoing/${fixture.sessionKey}/${fixture.attachmentId}/full`,
          },
        ],
      },
    ]);

    const result = await cleanupManagedOutgoingImageRecords({ stateDir });

    expect(readSessionMessagesMock).toHaveBeenCalled();
    expect(result).toEqual({ deletedRecordCount: 0, deletedFileCount: 0, retainedCount: 1 });
    await expect(fs.access(fixture.originalPath)).resolves.toBeUndefined();
  });

  it("treats legacy unscoped global records as the configured default agent", async () => {
    const config = {
      agents: { list: [{ id: "main" }, { id: "work", default: true }] },
    };
    getRuntimeConfigMock.mockReturnValue(config);
    prepareAgentSessionStore(stateDir, "work");
    await replaceTestSessionEntry(
      {
        agentId: "work",
        env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
        sessionKey: "global",
      },
      { sessionId: "sess-work-global", updatedAt: Date.now() },
    );
    closeOpenClawAgentDatabasesForTest();
    expect(
      resolveExistingAgentSessionStoreTargetsReadOnlyResult(config, "work", {
        env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
      }),
    ).toMatchObject({ available: true });
    const { loadExactSessionEntryReadOnlyResult } =
      await import("../config/sessions/session-accessor.sqlite-entry-availability.js");
    expect(
      loadExactSessionEntryReadOnlyResult({
        agentId: "work",
        env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
        sessionKey: "global",
      }),
    ).toMatchObject({ found: true, value: { sessionKey: "global" } });
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

    expect(readSessionMessagesMock).toHaveBeenCalled();
    expect(result.deletedRecordCount).toBe(1);
    expect(result.retainedCount).toBe(1);
    await expectPathMissing(deletedFixture.originalPath);
    await expect(fs.access(retainedFixture.originalPath)).resolves.toBeUndefined();
  });

  it("retains ownerless global records when no compatibility owner exists", async () => {
    getRuntimeConfigMock.mockReturnValue({
      agents: { list: [{ id: "main" }, { id: "work" }] },
    });
    const fixture = await createFixture(stateDir, {
      sessionKey: "global",
      attachmentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    });

    const result = await cleanupManagedOutgoingImageRecords({
      stateDir,
      sessionKey: "global",
    });

    expect(result).toEqual({ deletedRecordCount: 0, deletedFileCount: 0, retainedCount: 1 });
    expect(readManagedImageRecord(fixture.attachmentId, stateDir)).not.toBeNull();
    await expect(fs.access(fixture.originalPath)).resolves.toBeUndefined();
    expect(loadSessionEntryMock).not.toHaveBeenCalled();
    expect(readSessionMessagesMock).not.toHaveBeenCalled();
  });

  it("does not retain selected-agent global records during full cleanup", async () => {
    await replaceTestSessionEntry(
      {
        agentId: "work",
        env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
        sessionKey: "global",
        storePath: path.join(stateDir, "sessions.sqlite"),
      },
      { sessionId: "sess-work-global", updatedAt: Date.now() },
    );
    closeOpenClawAgentDatabasesForTest();
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
