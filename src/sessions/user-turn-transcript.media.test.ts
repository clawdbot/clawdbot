// User-turn media persistence tests cover fact normalization and legacy row projection.
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readPersistedMediaFacts } from "../media/media-facts.js";
import {
  buildPersistedUserTurnMediaInputsFromFields,
  buildPersistedUserTurnMessage,
} from "./user-turn-transcript.js";
import { shouldPersistStructuredMediaEntries } from "./user-turn-transcript.media-normalize.js";

describe("buildPersistedUserTurnMediaInputsFromFields", () => {
  it("builds media facts from persisted parallel fields", () => {
    expect(
      buildPersistedUserTurnMediaInputsFromFields({
        MediaPath: "/tmp/a.png",
        MediaPaths: ["/tmp/a.png", "/tmp/b.jpg"],
        MediaType: "image/png",
        MediaTypes: ["image/png", "image/jpeg"],
      }),
    ).toEqual([
      { path: "/tmp/a.png", contentType: "image/png" },
      { path: "/tmp/b.jpg", contentType: "image/jpeg" },
    ]);
  });

  it("uses url-backed media fields when no local path is present", () => {
    expect(
      buildPersistedUserTurnMediaInputsFromFields({
        MediaUrl: "media://inbound/a.png",
        MediaType: "image/png",
      }),
    ).toEqual([{ url: "media://inbound/a.png", contentType: "image/png" }]);
  });

  it("infers transcript media type from media path when explicit type is absent", () => {
    expect(
      buildPersistedUserTurnMediaInputsFromFields({
        MediaPaths: ["/tmp/a.png", "https://example.test/report.pdf"],
      }),
    ).toEqual([
      { path: "/tmp/a.png", contentType: "image/png" },
      { path: "https://example.test/report.pdf", contentType: "application/pdf" },
    ]);
  });

  it("does not reuse singular media type for later media paths", () => {
    expect(
      buildPersistedUserTurnMediaInputsFromFields({
        MediaPath: "/tmp/a.png",
        MediaPaths: ["/tmp/a.png", "/tmp/report.pdf"],
        MediaType: "image/png",
      }),
    ).toEqual([
      { path: "/tmp/a.png", contentType: "image/png" },
      { path: "/tmp/report.pdf", contentType: "application/pdf" },
    ]);
  });

  it("resolves staged legacy paths against the media workspace", () => {
    const workspaceDir = "/tmp/openclaw-user-turn-workspace";
    expect(
      buildPersistedUserTurnMediaInputsFromFields({
        MediaPaths: ["media/inbound/a.png", "media/inbound/b.jpg"],
        MediaTypes: ["image/png", "image/jpeg"],
        MediaWorkspaceDir: workspaceDir,
      }),
    ).toEqual([
      { path: path.join(workspaceDir, "media/inbound/a.png"), contentType: "image/png" },
      { path: path.join(workspaceDir, "media/inbound/b.jpg"), contentType: "image/jpeg" },
    ]);
  });

  it("does not rewrite absolute or URL-like media paths", () => {
    const workspaceDir = "/tmp/openclaw-user-turn-workspace";
    const absolutePath = path.join(workspaceDir, "media/inbound/a.png");
    expect(
      buildPersistedUserTurnMediaInputsFromFields({
        MediaPaths: [absolutePath, "media://inbound/b.jpg", "https://example.test/c.png"],
        MediaTypes: ["image/png", "image/jpeg", "image/png"],
        MediaWorkspaceDir: workspaceDir,
      }),
    ).toEqual([
      { path: absolutePath, contentType: "image/png" },
      { path: "media://inbound/b.jpg", contentType: "image/jpeg" },
      { path: "https://example.test/c.png", contentType: "image/png" },
    ]);
  });

  it("does not infer media from absent structured fields", () => {
    expect(buildPersistedUserTurnMediaInputsFromFields(undefined)).toEqual([]);
    expect(buildPersistedUserTurnMediaInputsFromFields({})).toEqual([]);
    expect(buildPersistedUserTurnMediaInputsFromFields({ MediaTypes: ["image/png"] })).toEqual([]);
  });

  it("preserves aligned content-type holes while normalizing the row", () => {
    const result = buildPersistedUserTurnMediaInputsFromFields({
      MediaPaths: ["/media/a.bin", "/media/b.png"],
      MediaTypes: ["", "image/png"],
    });
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ path: "/media/a.bin" });
    expect(result[0]?.contentType).not.toBe("image/png");
    expect(result[1]).toEqual({ path: "/media/b.png", contentType: "image/png" });
  });

  it("preserves aligned path and URL holes while normalizing the row", () => {
    expect(
      buildPersistedUserTurnMediaInputsFromFields({
        MediaPaths: ["/media/local.bin", ""],
        MediaUrls: ["", "https://example.test/remote.png"],
        MediaTypes: ["application/octet-stream", "image/png"],
      }),
    ).toEqual([
      { path: "/media/local.bin", contentType: "application/octet-stream" },
      { url: "https://example.test/remote.png", contentType: "image/png" },
    ]);
  });

  it("keeps empty attachment slots aligned for a later writer", () => {
    expect(
      buildPersistedUserTurnMediaInputsFromFields({
        MediaPaths: ["", "/media/b.png"],
        MediaTypes: ["", "image/png"],
      }),
    ).toEqual([{}, { path: "/media/b.png", contentType: "image/png" }]);
  });
});

describe("buildPersistedUserTurnMessage media projection", () => {
  const legacyProjection = (message: Record<string, unknown>) => ({
    ...(message.MediaPath === undefined ? {} : { MediaPath: message.MediaPath }),
    ...(message.MediaPaths === undefined ? {} : { MediaPaths: message.MediaPaths }),
    ...(message.MediaType === undefined ? {} : { MediaType: message.MediaType }),
    ...(message.MediaTypes === undefined ? {} : { MediaTypes: message.MediaTypes }),
  });

  it.each([
    {
      name: "zero attachments",
      media: undefined,
      expectedLegacy: {},
      expectedMedia: undefined,
    },
    {
      name: "one attachment",
      media: [{ path: "/tmp/a.png", contentType: "image/png" }],
      expectedLegacy: {
        MediaPath: "/tmp/a.png",
        MediaPaths: ["/tmp/a.png"],
        MediaType: "image/png",
        MediaTypes: ["image/png"],
      },
      expectedMedia: [{ path: "/tmp/a.png", contentType: "image/png" }],
    },
    {
      name: "many attachments",
      media: [
        { path: " /tmp/a.png ", contentType: " image/png " },
        { url: " https://example.test/report.pdf ", contentType: " application/pdf " },
      ],
      expectedLegacy: {
        MediaPath: "/tmp/a.png",
        MediaPaths: ["/tmp/a.png", "https://example.test/report.pdf"],
        MediaType: "image/png",
        MediaTypes: ["image/png", "application/pdf"],
      },
      expectedMedia: [
        { path: "/tmp/a.png", contentType: "image/png" },
        { url: "https://example.test/report.pdf", contentType: "application/pdf" },
      ],
    },
    {
      name: "sparse aligned attachments",
      media: [{}, { path: "/tmp/b.png", contentType: "image/png" }],
      expectedLegacy: {
        MediaPaths: ["", "/tmp/b.png"],
        MediaTypes: ["", "image/png"],
      },
      expectedMedia: [{}, { path: "/tmp/b.png", contentType: "image/png" }],
    },
    {
      name: "path-only attachment",
      media: [{ path: "/tmp/inferred.png" }],
      expectedLegacy: {
        MediaPath: "/tmp/inferred.png",
        MediaPaths: ["/tmp/inferred.png"],
        MediaType: "image/png",
        MediaTypes: ["image/png"],
      },
      expectedMedia: [{ path: "/tmp/inferred.png", contentType: "image/png" }],
    },
    {
      name: "URL-only attachment",
      media: [{ url: "https://example.test/remote.jpg", contentType: "image/jpeg" }],
      expectedLegacy: {
        MediaPath: "https://example.test/remote.jpg",
        MediaPaths: ["https://example.test/remote.jpg"],
        MediaType: "image/jpeg",
        MediaTypes: ["image/jpeg"],
      },
      expectedMedia: [{ url: "https://example.test/remote.jpg", contentType: "image/jpeg" }],
    },
    {
      name: "path plus distinct URL",
      media: [
        {
          path: "/tmp/local.jpg",
          url: "https://example.test/original.jpg",
          contentType: "image/jpeg",
        },
      ],
      expectedLegacy: {
        MediaPath: "/tmp/local.jpg",
        MediaPaths: ["/tmp/local.jpg"],
        MediaType: "image/jpeg",
        MediaTypes: ["image/jpeg"],
      },
      expectedMedia: [
        {
          path: "/tmp/local.jpg",
          url: "https://example.test/original.jpg",
          contentType: "image/jpeg",
        },
      ],
    },
    {
      name: "explicit MIME",
      media: [{ path: "/tmp/blob.bin", contentType: "application/x-openclaw" }],
      expectedLegacy: {
        MediaPath: "/tmp/blob.bin",
        MediaPaths: ["/tmp/blob.bin"],
        MediaType: "application/x-openclaw",
        MediaTypes: ["application/x-openclaw"],
      },
      expectedMedia: [{ path: "/tmp/blob.bin", contentType: "application/x-openclaw" }],
    },
    {
      name: "bare kind",
      media: [{ kind: "image" }],
      expectedLegacy: {},
      expectedMedia: [{ kind: "image" }],
    },
    {
      name: "provider MIME-like kind",
      media: [{ path: "/tmp/provider.bin", kind: "provider/custom-media" }],
      expectedLegacy: {
        MediaPath: "/tmp/provider.bin",
        MediaPaths: ["/tmp/provider.bin"],
        MediaType: "provider/custom-media",
        MediaTypes: ["provider/custom-media"],
      },
      expectedMedia: [{ path: "/tmp/provider.bin", contentType: "provider/custom-media" }],
    },
    {
      name: "unknown non-MIME kind",
      media: [{ path: "/tmp/photo.jpg", kind: "thumbnail" }],
      expectedLegacy: {
        MediaPath: "/tmp/photo.jpg",
        MediaPaths: ["/tmp/photo.jpg"],
        MediaType: "thumbnail",
        MediaTypes: ["thumbnail"],
      },
      expectedMedia: [{ path: "/tmp/photo.jpg", contentType: "image/jpeg" }],
    },
    {
      name: "transcribed attachment",
      media: [{ path: "/tmp/voice.ogg", contentType: "audio/ogg", transcribed: true }],
      expectedLegacy: {
        MediaPath: "/tmp/voice.ogg",
        MediaPaths: ["/tmp/voice.ogg"],
        MediaType: "audio/ogg",
        MediaTypes: ["audio/ogg"],
      },
      expectedMedia: [{ path: "/tmp/voice.ogg", contentType: "audio/ogg", transcribed: true }],
    },
    {
      name: "workspace-relative attachment",
      media: [
        {
          path: "media/inbound/a.png",
          contentType: "image/png",
          workspaceDir: "/tmp/workspace",
        },
      ],
      expectedLegacy: {
        MediaPath: path.join("/tmp/workspace", "media/inbound/a.png"),
        MediaPaths: [path.join("/tmp/workspace", "media/inbound/a.png")],
        MediaType: "image/png",
        MediaTypes: ["image/png"],
      },
      expectedMedia: [
        {
          path: "media/inbound/a.png",
          contentType: "image/png",
          workspaceDir: "/tmp/workspace",
        },
      ],
    },
    {
      name: "hydration-suppressed attachment",
      media: [
        {
          path: "/tmp/described.png",
          contentType: "image/png",
          hydrationSuppressed: true,
        },
      ],
      expectedLegacy: {
        MediaPath: "/tmp/described.png",
        MediaPaths: ["/tmp/described.png"],
        MediaType: "image/png",
        MediaTypes: ["image/png"],
      },
      expectedMedia: [
        {
          path: "/tmp/described.png",
          contentType: "image/png",
          hydrationSuppressed: true,
        },
      ],
    },
  ])(
    "keeps $name legacy bytes stable while persisting canonical facts",
    ({ media, expectedLegacy, expectedMedia }) => {
      const message = buildPersistedUserTurnMessage({ text: "inspect", timestamp: 123, media });
      expect(message).toMatchObject({ role: "user", content: "inspect", timestamp: 123 });
      expect(legacyProjection(message as unknown as Record<string, unknown>)).toEqual(
        expectedLegacy,
      );
      expect(JSON.stringify(legacyProjection(message as unknown as Record<string, unknown>))).toBe(
        JSON.stringify(expectedLegacy),
      );
      expect(
        (message as unknown as { __openclaw?: { media?: unknown } })["__openclaw"]?.media,
      ).toEqual(expectedMedia);
      expect(shouldPersistStructuredMediaEntries(media)).toBe(Boolean(media?.length));
    },
  );

  it("reads canonical persisted facts without merging disagreeing legacy fields", () => {
    const message = {
      MediaPath: "/legacy.png",
      MediaType: "image/png",
      __openclaw: {
        media: [
          {
            path: "/canonical.ogg",
            contentType: "audio/ogg",
            transcribed: true,
            messageId: "media-1",
          },
        ],
      },
    };

    expect(readPersistedMediaFacts(message)).toEqual([
      expect.objectContaining({
        path: "/canonical.ogg",
        contentType: "audio/ogg",
        kind: "audio",
        transcribed: true,
        messageId: "media-1",
      }),
    ]);
  });
});
