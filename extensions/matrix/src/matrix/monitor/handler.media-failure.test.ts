import { beforeEach, describe, expect, it, vi } from "vitest";
import { installMatrixMonitorTestRuntime } from "../../test-runtime.js";
import { MatrixMediaSizeLimitError } from "../media-errors.js";
import {
  createMatrixHandlerTestHarness,
  createMatrixRoomMessageEvent,
} from "./handler.test-helpers.js";

const { downloadMatrixMediaMock } = vi.hoisted(() => ({
  downloadMatrixMediaMock: vi.fn(),
}));

vi.mock("./media.js", async () => {
  const actual = await vi.importActual<typeof import("./media.js")>("./media.js");
  return {
    ...actual,
    downloadMatrixMedia: (...args: unknown[]) => downloadMatrixMediaMock(...args),
  };
});

function createMediaFailureHarness() {
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  const runtime = {
    error: vi.fn(),
  };
  const harness = createMatrixHandlerTestHarness({
    logger: logger as never,
    runtime: runtime as never,
    shouldHandleTextCommands: () => true,
    resolveMarkdownTableMode: () => "code",
    resolveAgentRoute: () => ({
      agentId: "main",
      accountId: "ops",
      sessionKey: "agent:main:matrix:channel:!room:example.org",
      mainSessionKey: "agent:main:main",
      channel: "matrix",
      matchedBy: "binding.account",
    }),
    resolveStorePath: () => "/tmp/openclaw-test-session.json",
    readSessionUpdatedAt: () => 123,
    getRoomInfo: async () => ({
      name: "Media Room",
      canonicalAlias: "#media:example.org",
      altAliases: [],
    }),
    getMemberDisplayName: async () => "Gum",
    startupMs: Date.now() - 120_000,
    startupGraceMs: 60_000,
    textLimit: 4000,
    mediaMaxBytes: 5 * 1024 * 1024,
    replyToMode: "first",
  });

  return {
    ...harness,
    logger,
    runtime,
  };
}

function createImageEvent(content: Record<string, unknown>) {
  return createMatrixRoomMessageEvent({
    eventId: "$event1",
    sender: "@gum:matrix.example.org",
    content: {
      ...content,
      "m.mentions": { user_ids: ["@bot:matrix.example.org"] },
    } as never,
  });
}

type MockWithCalls = {
  mock: { calls: unknown[][] };
};

function firstObjectArg(mock: MockWithCalls): Record<string, unknown> {
  const value = mock.mock.calls[0]?.[0];
  if (value === undefined || value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("expected first mock call object argument");
  }
  return value as Record<string, unknown>;
}

function objectArgAt(mock: MockWithCalls, index: number): Record<string, unknown> {
  const value = mock.mock.calls[0]?.[index];
  if (value === undefined || value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`expected first mock call argument ${index} to be an object`);
  }
  return value as Record<string, unknown>;
}

function firstInboundContext(recordInboundSession: unknown): Record<string, unknown> {
  const payload = firstObjectArg(recordInboundSession as MockWithCalls);
  const ctx = payload.ctx;
  if (ctx === undefined || ctx === null || typeof ctx !== "object" || Array.isArray(ctx)) {
    throw new Error("expected inbound session ctx");
  }
  return ctx as Record<string, unknown>;
}

describe("createMatrixRoomMessageHandler media failures", () => {
  beforeEach(() => {
    downloadMatrixMediaMock.mockReset();
    installMatrixMonitorTestRuntime();
  });

  it("forwards the Matrix event body as originalFilename for media downloads", async () => {
    downloadMatrixMediaMock.mockResolvedValue({
      path: "/tmp/inbound/Screenshot-2026-03-27---uuid.png",
      contentType: "image/png",
      placeholder: "[matrix media]",
    });
    const { handler } = createMediaFailureHarness();

    await handler(
      "!room:example.org",
      createImageEvent({
        msgtype: "m.image",
        body: " Screenshot 2026-03-27.png ",
        url: "mxc://example/image",
      }),
    );

    const downloadOptions = firstObjectArg(downloadMatrixMediaMock);
    expect(downloadOptions.mxcUrl).toBe("mxc://example/image");
    expect(downloadOptions.maxBytes).toBe(5 * 1024 * 1024);
    expect(downloadOptions.originalFilename).toBe("Screenshot 2026-03-27.png");
  });

  it("prefers content.filename over body text when deriving originalFilename", async () => {
    downloadMatrixMediaMock.mockResolvedValue({
      path: "/tmp/inbound/Screenshot-2026-03-27---uuid.png",
      contentType: "image/png",
      placeholder: "[matrix media]",
    });
    const { handler } = createMediaFailureHarness();

    await handler(
      "!room:example.org",
      createImageEvent({
        msgtype: "m.image",
        body: "can you review this screenshot?",
        filename: "Screenshot 2026-03-27.png",
        url: "mxc://example/image",
      }),
    );

    expect(firstObjectArg(downloadMatrixMediaMock).originalFilename).toBe(
      "Screenshot 2026-03-27.png",
    );
  });

  it("replaces bare image filenames with an unavailable marker when unencrypted download fails", async () => {
    downloadMatrixMediaMock.mockRejectedValue(new Error("download failed"));
    const { handler, recordInboundSession, logger, runtime } = createMediaFailureHarness();

    await handler(
      "!room:example.org",
      createImageEvent({
        msgtype: "m.image",
        body: "image.png",
        url: "mxc://example/image",
      }),
    );

    const ctx = firstInboundContext(recordInboundSession);
    expect(ctx.RawBody).toBe("[matrix image attachment unavailable]");
    expect(ctx.CommandBody).toBe("[matrix image attachment unavailable]");
    expect(ctx.MediaPath).toBeUndefined();
    expect(logger.warn.mock.calls[0]?.[0]).toBe("matrix media download failed");
    const warningMetadata = objectArgAt(logger.warn, 1);
    expect(warningMetadata.eventId).toBe("$event1");
    expect(warningMetadata.msgtype).toBe("m.image");
    expect(warningMetadata.encrypted).toBe(false);
    expect(runtime.error).not.toHaveBeenCalled();
  });

  it("replaces bare image filenames with an unavailable marker when encrypted download fails", async () => {
    downloadMatrixMediaMock.mockRejectedValue(new Error("decrypt failed"));
    const { handler, recordInboundSession } = createMediaFailureHarness();

    await handler(
      "!room:example.org",
      createImageEvent({
        msgtype: "m.image",
        body: "photo.jpg",
        file: {
          url: "mxc://example/encrypted",
          key: { kty: "oct", key_ops: ["encrypt"], alg: "A256CTR", k: "secret", ext: true },
          iv: "iv",
          hashes: { sha256: "hash" },
          v: "v2",
        },
      }),
    );

    const ctx = firstInboundContext(recordInboundSession);
    expect(ctx.RawBody).toBe("[matrix image attachment unavailable]");
    expect(ctx.CommandBody).toBe("[matrix image attachment unavailable]");
    expect(ctx.MediaPath).toBeUndefined();
  });

  it("preserves a real caption while marking the attachment unavailable", async () => {
    downloadMatrixMediaMock.mockRejectedValue(new Error("download failed"));
    const { handler, recordInboundSession } = createMediaFailureHarness();

    await handler(
      "!room:example.org",
      createImageEvent({
        msgtype: "m.image",
        body: "can you see this image?",
        filename: "image.png",
        url: "mxc://example/image",
      }),
    );

    const ctx = firstInboundContext(recordInboundSession);
    expect(ctx.RawBody).toBe("can you see this image?\n\n[matrix image attachment unavailable]");
    expect(ctx.CommandBody).toBe(
      "can you see this image?\n\n[matrix image attachment unavailable]",
    );
  });

  it("shows a too-large marker when the download is rejected due to size limit", async () => {
    downloadMatrixMediaMock.mockRejectedValue(new MatrixMediaSizeLimitError());
    const { handler, recordInboundSession } = createMediaFailureHarness();

    await handler(
      "!room:example.org",
      createImageEvent({
        msgtype: "m.image",
        body: "big-photo.jpg",
        url: "mxc://example/big-image",
      }),
    );

    const ctx = firstInboundContext(recordInboundSession);
    expect(ctx.RawBody).toBe("[matrix image attachment too large]");
    expect(ctx.CommandBody).toBe("[matrix image attachment too large]");
    expect(ctx.MediaPath).toBeUndefined();
  });

  it("preserves a real caption while marking the attachment too large on size limit error", async () => {
    downloadMatrixMediaMock.mockRejectedValue(new MatrixMediaSizeLimitError());
    const { handler, recordInboundSession } = createMediaFailureHarness();

    await handler(
      "!room:example.org",
      createImageEvent({
        msgtype: "m.image",
        body: "check this out",
        filename: "large-photo.jpg",
        url: "mxc://example/big-image",
      }),
    );

    const ctx = firstInboundContext(recordInboundSession);
    expect(ctx.RawBody).toBe("check this out\n\n[matrix image attachment too large]");
    expect(ctx.CommandBody).toBe("check this out\n\n[matrix image attachment too large]");
  });
});
