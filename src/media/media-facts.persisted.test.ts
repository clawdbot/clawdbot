import { describe, expect, it } from "vitest";
import {
  canonicalizePersistedUserMessageMedia,
  PERSISTED_LEGACY_MEDIA_KEYS,
  readPersistedMediaFacts,
} from "./media-facts.js";

const canonicalFact = { path: "/media/canonical.png", contentType: "image/png" };

describe("canonical persisted media", () => {
  it.each([
    {
      name: "legacy-only",
      message: { MediaPath: "/media/legacy.png", MediaType: "image/png" },
      expected: [{ path: "/media/legacy.png", contentType: "image/png", kind: "image" }],
    },
    {
      name: "facts-only",
      message: { __openclaw: { media: [canonicalFact] } },
      expected: [{ ...canonicalFact, kind: "image" }],
    },
    {
      name: "top-level-media-only",
      message: { media: [canonicalFact] },
      expected: [{ ...canonicalFact, kind: "image" }],
    },
    {
      name: "both-equal",
      message: {
        MediaPath: canonicalFact.path,
        MediaType: canonicalFact.contentType,
        __openclaw: { media: [canonicalFact] },
      },
      expected: [{ ...canonicalFact, kind: "image" }],
    },
    {
      name: "both-conflict",
      message: {
        MediaPath: "/media/legacy-conflict.jpg",
        MediaType: "image/jpeg",
        __openclaw: { media: [canonicalFact] },
      },
      expected: [{ ...canonicalFact, kind: "image" }],
    },
    {
      name: "sparse",
      message: {
        MediaPaths: ["", "/media/second.png"],
        MediaTypes: ["", "image/png"],
        __openclaw: { media: [{ url: "https://example.test/first" }] },
      },
      expected: [
        { url: "https://example.test/first" },
        { path: "/media/second.png", contentType: "image/png", kind: "image" },
      ],
    },
    {
      name: "type-only",
      message: { MediaType: "image" },
      expected: [{ kind: "image" }],
    },
    {
      name: "media-only",
      message: { role: "user", content: "", __openclaw: { media: [canonicalFact] } },
      expected: [{ ...canonicalFact, kind: "image" }],
    },
  ])("canonicalizes $name rows", ({ message, expected }) => {
    const result = canonicalizePersistedUserMessageMedia(message);
    for (const key of PERSISTED_LEGACY_MEDIA_KEYS) {
      expect(result.message).not.toHaveProperty(key);
    }
    expect(readPersistedMediaFacts(result.message)).toEqual(
      expected.map((fact) => expect.objectContaining(fact)),
    );
  });

  it("copies transcription and workspace metadata while preserving adjacent metadata", () => {
    const result = canonicalizePersistedUserMessageMedia({
      MediaPaths: ["/media/a.ogg", "/media/b.png"],
      MediaTypes: ["audio", "image/png"],
      MediaTranscribedIndexes: [0],
      MediaStaged: true,
      MediaWorkspaceDir: "/media/workspace",
      __openclaw: { traceId: "trace-1", media: [{ messageId: "m1" }] },
    });

    expect(result.message).toEqual({
      __openclaw: {
        traceId: "trace-1",
        media: [
          expect.objectContaining({
            path: "/media/a.ogg",
            kind: "audio",
            transcribed: true,
            staged: true,
            workspaceDir: "/media/workspace",
            messageId: "m1",
          }),
          expect.objectContaining({
            path: "/media/b.png",
            contentType: "image/png",
            staged: true,
            workspaceDir: "/media/workspace",
          }),
        ],
      },
    });
  });

  it("round-trips duration and dimensions in canonical persisted facts", () => {
    const result = canonicalizePersistedUserMessageMedia({
      __openclaw: {
        media: [
          {
            path: "/media/clip.mp4",
            contentType: "video/mp4",
            durationMs: 12_346,
            width: 1280,
            height: 720,
          },
        ],
      },
    });

    expect(readPersistedMediaFacts(result.message)).toEqual([
      expect.objectContaining({
        path: "/media/clip.mp4",
        contentType: "video/mp4",
        kind: "video",
        durationMs: 12_346,
        width: 1280,
        height: 720,
      }),
    ]);
  });

  it("rejects compact types after a sparse positional gap", () => {
    expect(() =>
      canonicalizePersistedUserMessageMedia({
        MediaPaths: ["", "/media/b.png"],
        MediaTypes: ["image/png"],
      }),
    ).toThrow("ambiguous sparse positional alignment");
  });

  it("rejects under-cardinal compact types after dense attachment paths", () => {
    expect(() =>
      canonicalizePersistedUserMessageMedia({
        MediaPaths: ["/media/a.bin", "/media/b.pdf"],
        MediaTypes: ["application/pdf"],
      }),
    ).toThrow("ambiguous sparse positional alignment");
  });

  it("accepts compact legacy types when complete canonical facts cover every slot", () => {
    const result = canonicalizePersistedUserMessageMedia({
      MediaPaths: ["/media/a.bin", "/media/b.pdf"],
      MediaTypes: ["application/pdf"],
      __openclaw: {
        media: [
          { path: "/media/a.bin", contentType: "application/octet-stream" },
          { path: "/media/b.pdf", contentType: "application/pdf" },
        ],
      },
    });

    expect(readPersistedMediaFacts(result.message)).toEqual([
      expect.objectContaining({
        path: "/media/a.bin",
        contentType: "application/octet-stream",
      }),
      expect.objectContaining({ path: "/media/b.pdf", contentType: "application/pdf" }),
    ]);
  });

  it("does not materialize a compact legacy type into an empty canonical slot", () => {
    const result = canonicalizePersistedUserMessageMedia({
      MediaPaths: ["", "/media/b.png"],
      MediaType: "image",
      MediaTypes: ["image/png"],
      __openclaw: {
        media: [{}, { path: "/media/b.png", contentType: "image/png" }],
      },
    });

    expect((result.message["__openclaw"] as { media: unknown[] }).media).toEqual([
      {},
      expect.objectContaining({ path: "/media/b.png", contentType: "image/png" }),
    ]);
  });

  it("removes a conflicting top-level media copy", () => {
    const result = canonicalizePersistedUserMessageMedia({
      media: [{ path: "/media/runtime.png", contentType: "image/png" }],
      __openclaw: { media: [canonicalFact] },
    });

    expect(result.message).not.toHaveProperty("media");
    expect(readPersistedMediaFacts(result.message)?.[0]).toMatchObject(canonicalFact);
  });
});
