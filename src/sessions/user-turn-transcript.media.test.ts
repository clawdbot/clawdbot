// User-turn media persistence tests cover canonical fact normalization.
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readPersistedMediaFacts } from "../media/media-facts.js";
import {
  buildLateMediaAttachedProjection,
  buildPersistedUserTurnMediaInputsFromFields,
  buildPersistedUserTurnMessage,
} from "./user-turn-transcript.js";

describe("buildPersistedUserTurnMediaInputsFromFields", () => {
  it("builds media inputs from canonical persisted facts", () => {
    expect(
      buildPersistedUserTurnMediaInputsFromFields({
        __openclaw: {
          media: [
            { path: "/tmp/a.png", contentType: "image/png" },
            { url: "https://example.test/b.jpg", contentType: "image/jpeg" },
          ],
        },
      } as never),
    ).toEqual([
      { path: "/tmp/a.png", contentType: "image/png" },
      { url: "https://example.test/b.jpg", contentType: "image/jpeg" },
    ]);
  });

  it("resolves relative canonical paths against each fact workspace", () => {
    const workspaceDir = "/tmp/openclaw-user-turn-workspace";
    expect(
      buildPersistedUserTurnMediaInputsFromFields({
        __openclaw: {
          media: [{ path: "media/inbound/a.png", contentType: "image/png", workspaceDir }],
        },
      } as never),
    ).toEqual([{ path: path.join(workspaceDir, "media/inbound/a.png"), contentType: "image/png" }]);
  });

  it("does not consult legacy top-level fields after the versioned cutover", () => {
    expect(buildPersistedUserTurnMediaInputsFromFields(undefined)).toEqual([]);
    expect(buildPersistedUserTurnMediaInputsFromFields({} as never)).toEqual([]);
  });
});

describe("buildLateMediaAttachedProjection canonical persistence", () => {
  it.each([
    {
      name: "legacy-only",
      message: { MediaPath: "/media/legacy.png", MediaType: "image/png" },
      expectedPath: undefined,
    },
    {
      name: "facts-only",
      message: { __openclaw: { media: [{ path: "/media/fact.png" }] } },
      expectedPath: "/media/fact.png",
    },
    {
      name: "both-equal",
      message: {
        MediaPath: "/media/equal.png",
        __openclaw: { media: [{ path: "/media/equal.png" }] },
      },
      expectedPath: "/media/equal.png",
    },
    {
      name: "both-conflict",
      message: {
        MediaPath: "/media/legacy-conflict.png",
        __openclaw: { media: [{ path: "/media/canonical.png" }] },
      },
      expectedPath: "/media/canonical.png",
    },
    {
      name: "sparse",
      message: { __openclaw: { media: [{}, { path: "/media/sparse.png" }] } },
      expectedPath: "/media/sparse.png",
      expectedIndex: 1,
    },
    {
      name: "type-only",
      message: { __openclaw: { media: [{ contentType: "image/png" }] } },
      expectedPath: undefined,
    },
    {
      name: "media-only",
      message: { content: "", __openclaw: { media: [{ path: "/media/media-only.png" }] } },
      expectedPath: "/media/media-only.png",
    },
  ])("reconstructs $name rows from canonical facts first", (testCase) => {
    const metadata = (testCase.message as { __openclaw?: Record<string, unknown> })["__openclaw"];
    const projection = buildLateMediaAttachedProjection({
      role: "user",
      content: "",
      ...testCase.message,
      __openclaw: { ...metadata, lateMedia: true },
    } as never);
    const expectedIndex = "expectedIndex" in testCase ? (testCase.expectedIndex ?? 0) : 0;

    expect(projection.media[expectedIndex]?.path).toBe(testCase.expectedPath);
    expect(projection.text).toBe(
      testCase.expectedPath ? `[media attached: ${testCase.expectedPath}]` : undefined,
    );
  });
});

describe("buildPersistedUserTurnMessage media projection", () => {
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
  ])("persists $name as canonical facts without legacy fields", ({ media, expectedMedia }) => {
    const message = buildPersistedUserTurnMessage({ text: "inspect", timestamp: 123, media });
    expect(message).toMatchObject({ role: "user", content: "inspect", timestamp: 123 });
    expect(message).not.toHaveProperty("MediaPath");
    expect(message).not.toHaveProperty("MediaPaths");
    expect(message).not.toHaveProperty("MediaType");
    expect(message).not.toHaveProperty("MediaTypes");
    expect(
      (message as unknown as { __openclaw?: { media?: unknown } })["__openclaw"]?.media,
    ).toEqual(expectedMedia);
  });

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
