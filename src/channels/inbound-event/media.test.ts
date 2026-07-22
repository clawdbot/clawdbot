// Inbound event media tests cover channel media attachment normalization.
import { kindFromMime } from "@openclaw/media-core/mime";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { describe, expect, it } from "vitest";
import { normalizeAttachments } from "../../media-understanding/attachments.normalize.js";
import {
  hasStagedMediaProjection,
  normalizeMediaFacts,
  projectMediaFacts,
  resolveMediaFacts,
  type MediaFactInput,
  type MediaFactLegacyProjection,
} from "../../media/media-facts.js";
import { buildAgentMediaPayload } from "../../plugin-sdk/agent-media-payload.js";
import { buildMediaPayload } from "../plugins/media-payload.js";
import {
  buildChannelInboundMediaPayload,
  formatMediaPlaceholderText,
  formatInboundMediaUnavailableText,
  toHistoryMediaEntries,
  toInboundMediaFacts,
  type ChannelInboundMediaInput,
} from "./media.js";

type MergeMatrixSource = MediaFactLegacyProjection & {
  media?: readonly MediaFactInput[];
  MediaStaged?: boolean;
  MediaWorkspaceDir?: string;
};

const canonicalModes = ["none", "partial", "full"] as const;
const legacyModes = [
  "none",
  "aligned",
  "mismatched-cardinality",
  "staged-MediaStaged",
  "staged-MediaWorkspaceDir",
  "scalar-only",
] as const;
const typeModes = ["present", "absent", "conflicting"] as const;

function buildCanonicalMedia(
  mode: (typeof canonicalModes)[number],
  typeMode: (typeof typeModes)[number],
): MediaFactInput[] {
  if (mode === "none") {
    return [];
  }
  if (mode === "partial") {
    return [{ path: "/canonical/voice.ogg" }];
  }
  const typeFields =
    typeMode === "present"
      ? [{ contentType: "audio/ogg" }, { contentType: "image/jpeg" }]
      : typeMode === "conflicting"
        ? [
            { contentType: "audio/ogg", kind: "video" as const },
            { contentType: "image/jpeg", kind: "document" as const },
          ]
        : [{}, {}];
  return [
    {
      path: "/canonical/voice.ogg",
      url: "https://canonical.test/voice.ogg",
      workspaceDir: "/canonical/workspace-a",
      ...typeFields[0],
    },
    {
      path: "/canonical/photo.jpg",
      url: "https://canonical.test/photo.jpg",
      workspaceDir: "/canonical/workspace-b",
      ...typeFields[1],
    },
  ];
}

function buildLegacyMedia(
  mode: (typeof legacyModes)[number],
  typeMode: (typeof typeModes)[number],
): MergeMatrixSource {
  const base: MergeMatrixSource =
    mode === "none"
      ? {}
      : mode === "scalar-only"
        ? {
            MediaPath: "/legacy/scalar.ogg",
            MediaUrl: "/legacy/scalar.ogg",
          }
        : {
            MediaPaths:
              mode === "mismatched-cardinality" ? ["/legacy/voice.ogg"] : ["/legacy/voice.ogg", ""],
            MediaUrls: ["/legacy/voice.ogg", "https://legacy.test/photo.jpg"],
            ...(mode === "staged-MediaStaged" ? { MediaStaged: true } : {}),
            ...(mode === "staged-MediaWorkspaceDir"
              ? { MediaWorkspaceDir: "/tmp/staged-media" }
              : {}),
          };
  if (typeMode === "absent" || mode === "none") {
    return base;
  }
  if (mode === "scalar-only") {
    return { ...base, MediaType: typeMode === "present" ? "audio/ogg" : "image/png" };
  }
  return {
    ...base,
    MediaType: typeMode === "conflicting" ? "video/mp4" : "audio/ogg",
    MediaTypes:
      typeMode === "present"
        ? mode === "mismatched-cardinality"
          ? ["audio/ogg", "image/jpeg", "application/pdf"]
          : ["audio/ogg", "image/jpeg"]
        : mode === "mismatched-cardinality"
          ? ["image/png", "video/mp4", "application/pdf"]
          : ["image/png", "video/mp4"],
  };
}

const mediaMergeMatrix = canonicalModes.flatMap((canonicalMode) =>
  legacyModes.flatMap((legacyMode) =>
    typeModes.map((typeMode) => ({
      name: `canonical=${canonicalMode} legacy=${legacyMode} types=${typeMode}`,
      canonicalMode,
      legacyMode,
      typeMode,
    })),
  ),
);

describe("channel inbound media facts", () => {
  it("formats media placeholder text with kind precedence and normalized MIME fallback", () => {
    expect(
      formatMediaPlaceholderText([
        { kind: "document", contentType: "image/png", path: "/tmp/photo.jpg" },
      ]),
    ).toBe("<media:document>");
    expect(formatMediaPlaceholderText([{ contentType: " IMAGE/PNG; charset=binary " }])).toBe(
      "<media:image>",
    );
    expect(
      formatMediaPlaceholderText([{ url: "https://example.test/uploads/clip.MP4?download=1" }]),
    ).toBe("<media:video>");
  });

  it("counts homogeneous media and collapses mixed kinds deterministically", () => {
    expect(formatMediaPlaceholderText([{ kind: "image" }, { contentType: "image/jpeg" }])).toBe(
      "<media:image> (2 images)",
    );
    expect(formatMediaPlaceholderText([{ kind: "image" }, { path: "/tmp/voice-note.mp3" }])).toBe(
      "<media:document> (2 files)",
    );
    expect(formatMediaPlaceholderText([{ kind: "image" }, {}])).toBe(
      "<media:attachment> (2 attachments)",
    );
    expect(formatMediaPlaceholderText([{ kind: "sticker" }])).toBe("<media:sticker>");
    expect(formatMediaPlaceholderText([{ kind: "sticker" }, { kind: "sticker" }])).toBe(
      "<media:sticker> (2 stickers)",
    );
  });

  it("formats type-only attachment facts without filenames or a count side channel", () => {
    expect(formatMediaPlaceholderText([{}, {}, {}])).toBe("<media:attachment> (3 attachments)");
    expect(formatMediaPlaceholderText([])).toBe("");
  });

  it("returns unavailable notices alone or appended to real captions", () => {
    expect(
      formatInboundMediaUnavailableText({
        body: "",
        notice: "[test image attachment unavailable]",
      }),
    ).toBe("[test image attachment unavailable]");
    expect(
      formatInboundMediaUnavailableText({
        body: "please inspect this",
        notice: "[test image attachment unavailable]",
      }),
    ).toBe("please inspect this\n\n[test image attachment unavailable]");
  });

  it("normalizes provider media into inbound media facts", () => {
    const input = [
      { path: " /tmp/image.png ", contentType: " image/png ", messageId: " " },
      {
        url: "https://example.test/audio.mp3",
        contentType: "audio/mpeg",
        kind: "audio" as const,
      },
    ];
    const defaults = {
      kind: "image" as const,
      messageId: "msg-1",
      transcribed: (_media: ChannelInboundMediaInput, index: number): boolean => index === 1,
    };
    const expected = [
      {
        path: "/tmp/image.png",
        url: undefined,
        contentType: "image/png",
        kind: "image",
        transcribed: false,
        messageId: "msg-1",
      },
      {
        path: undefined,
        url: "https://example.test/audio.mp3",
        contentType: "audio/mpeg",
        kind: "audio",
        transcribed: true,
        messageId: "msg-1",
      },
    ];
    expect(normalizeMediaFacts(input, defaults)).toEqual(expected);
    expect(toInboundMediaFacts(input, defaults)).toEqual(expected);
    expect(
      normalizeMediaFacts([{ path: " image.png ", workspaceDir: " /tmp/workspace " }]),
    ).toEqual([
      {
        path: "image.png",
        url: undefined,
        contentType: undefined,
        kind: undefined,
        transcribed: false,
        messageId: undefined,
        workspaceDir: "/tmp/workspace",
      },
    ]);
  });

  it("normalizes retained facts and legacy projections without losing alignment", () => {
    expect(
      resolveMediaFacts({
        media: [{ path: " /tmp/voice.ogg ", kind: "audio" }],
        MediaTypes: [" audio/ogg "],
        MediaTranscribedIndexes: [0],
      }),
    ).toEqual([
      {
        path: "/tmp/voice.ogg",
        url: undefined,
        contentType: "audio/ogg",
        kind: "audio",
        transcribed: true,
        messageId: undefined,
      },
    ]);
    expect(
      resolveMediaFacts({
        MediaPaths: ["/tmp/local.bin", ""],
        MediaUrls: ["", "https://example.test/photo.jpg"],
        MediaTypes: ["", "image/jpeg"],
        MediaTranscribedIndexes: [1],
      }),
    ).toEqual([
      expect.objectContaining({ path: "/tmp/local.bin", transcribed: false }),
      expect.objectContaining({
        path: undefined,
        url: "https://example.test/photo.jpg",
        contentType: "image/jpeg",
        transcribed: true,
      }),
    ]);
    expect(
      resolveMediaFacts({
        MediaPaths: ["/tmp/voice.ogg"],
        MediaUrls: ["/tmp/voice.ogg", "https://example.test/photo.jpg"],
        MediaTypes: ["audio/ogg", "image/jpeg"],
      }),
    ).toEqual([
      expect.objectContaining({ path: "/tmp/voice.ogg", contentType: "audio/ogg" }),
      expect.objectContaining({
        path: undefined,
        url: "https://example.test/photo.jpg",
        contentType: "image/jpeg",
      }),
    ]);
  });

  it("normalizes blank workspace and MIME values before fallbacks apply", () => {
    expect(
      resolveMediaFacts({
        media: [{ path: "rel/staged.png", workspaceDir: "  " }],
        MediaWorkspaceDir: "/tmp/stage-root",
      }),
    ).toEqual([
      expect.objectContaining({ path: "rel/staged.png", workspaceDir: "/tmp/stage-root" }),
    ]);
    expect(resolveMediaFacts({ MediaPath: "/tmp/blob", MediaType: "   " })).toEqual([
      expect.objectContaining({ path: "/tmp/blob", contentType: undefined }),
    ]);
    expect(resolveMediaFacts({ MediaPath: "/tmp/a.png", MediaType: "  image/png  " })).toEqual([
      expect.objectContaining({ contentType: "image/png", kind: "image" }),
    ]);
  });

  it.each(mediaMergeMatrix)("merges $name", ({ canonicalMode, legacyMode, typeMode }) => {
    const canonical = buildCanonicalMedia(canonicalMode, typeMode);
    const legacy = buildLegacyMedia(legacyMode, typeMode);
    const source: MergeMatrixSource = {
      ...legacy,
      ...(canonical.length > 0 ? { media: canonical } : {}),
    };
    const facts = resolveMediaFacts(source);
    const paths = legacy.MediaPaths ?? [];
    const urls = legacy.MediaUrls ?? [];
    const types = legacy.MediaTypes ?? [];
    const expectedCount = Math.max(
      canonical.length,
      paths.length,
      urls.length,
      types.length,
      legacy.MediaPath || legacy.MediaUrl ? 1 : 0,
    );

    expect(hasStagedMediaProjection(source)).toBe(
      legacyMode === "staged-MediaStaged" || legacyMode === "staged-MediaWorkspaceDir",
    );
    expect(facts).toHaveLength(expectedCount);
    for (let index = 0; index < expectedCount; index += 1) {
      const canonicalFact = canonical[index];
      const expectedPath = normalizeOptionalString(
        canonicalFact?.path ?? paths[index] ?? (index === 0 ? legacy.MediaPath : undefined),
      );
      const expectedUrl = normalizeOptionalString(
        canonicalFact?.url ?? urls[index] ?? (index === 0 ? legacy.MediaUrl : undefined),
      );
      const expectedContentType = normalizeOptionalString(
        canonicalFact?.contentType ??
          types[index] ??
          (expectedCount === 1 ? legacy.MediaType : undefined),
      );
      const expectedKind = canonicalFact?.kind ?? kindFromMime(expectedContentType);
      const expectedWorkspaceDir = canonicalFact?.workspaceDir ?? legacy.MediaWorkspaceDir;
      expect(facts[index]).toMatchObject({
        path: expectedPath,
        url: expectedUrl,
        contentType: expectedContentType,
        kind: expectedKind,
        ...(expectedWorkspaceDir ? { workspaceDir: expectedWorkspaceDir } : {}),
      });
      if (!expectedWorkspaceDir) {
        expect(facts[index]).not.toHaveProperty("workspaceDir");
      }
    }
  });

  it("builds legacy media payload fields from inbound media facts", () => {
    const media = [
      { path: "/tmp/image.png", contentType: "image/png", kind: "image" as const },
      {
        url: "https://example.test/audio.mp3",
        contentType: "audio/mpeg",
        kind: "audio" as const,
        transcribed: true,
      },
    ];
    const expected = {
      MediaPath: "/tmp/image.png",
      MediaUrl: "/tmp/image.png",
      MediaType: "image/png",
      MediaPaths: ["/tmp/image.png", ""],
      MediaUrls: ["/tmp/image.png", "https://example.test/audio.mp3"],
      MediaTypes: ["image/png", "audio/mpeg"],
      MediaTranscribedIndexes: [1],
    };
    expect(projectMediaFacts(media)).toEqual(expected);
    expect(buildChannelInboundMediaPayload(media)).toEqual(expected);
  });

  it("keeps legacy media arrays index-aligned for mixed path and URL media", () => {
    const payload = buildChannelInboundMediaPayload([
      { path: "/tmp/image.png", contentType: "image/png", kind: "image" },
      { url: "https://example.test/remote.png", contentType: "image/png", kind: "image" },
    ]);

    expect(payload.MediaPaths).toEqual(["/tmp/image.png", ""]);
    expect(payload.MediaUrls).toEqual(["/tmp/image.png", "https://example.test/remote.png"]);
    expect(payload.MediaTypes).toEqual(["image/png", "image/png"]);
    expect(normalizeAttachments(payload)).toMatchObject([
      { path: "/tmp/image.png", url: "/tmp/image.png", mime: "image/png" },
      { path: undefined, url: "https://example.test/remote.png", mime: "image/png" },
    ]);
  });

  it("keeps compact and cardinality-preserving adapter projections byte-identical", () => {
    const media = [{ path: "/tmp/image.png", contentType: "image/png" }, { path: "/tmp/file.bin" }];
    const compact = {
      MediaPath: "/tmp/image.png",
      MediaUrl: "/tmp/image.png",
      MediaType: "image/png",
      MediaPaths: ["/tmp/image.png", "/tmp/file.bin"],
      MediaUrls: ["/tmp/image.png", "/tmp/file.bin"],
      MediaTypes: ["image/png"],
    };
    expect(projectMediaFacts(media, "compact")).toEqual(compact);
    expect(buildAgentMediaPayload(media)).toEqual(compact);
    expect(buildMediaPayload(media)).toEqual(compact);

    const aligned = { ...compact, MediaTypes: ["image/png", ""] };
    expect(projectMediaFacts(media, "aligned")).toEqual(aligned);
    expect(buildMediaPayload(media, { preserveMediaTypeCardinality: true })).toEqual(aligned);
  });

  it("keeps richer fact fields out of legacy outbound payloads", () => {
    const richerMedia = [
      {
        path: "/tmp/voice-note.ogg",
        url: "https://example.test/voice-note.ogg",
        kind: "audio" as const,
      },
    ];
    const compact = {
      MediaPath: "/tmp/voice-note.ogg",
      MediaUrl: "/tmp/voice-note.ogg",
      MediaType: undefined,
      MediaPaths: ["/tmp/voice-note.ogg"],
      MediaUrls: ["/tmp/voice-note.ogg"],
      MediaTypes: undefined,
    };
    expect(projectMediaFacts(richerMedia, "compact")).toEqual(compact);
    expect(buildAgentMediaPayload(richerMedia)).toEqual(compact);
    expect(buildMediaPayload(richerMedia)).toEqual(compact);
    expect(projectMediaFacts(richerMedia, "aligned")).toEqual({
      ...compact,
      MediaTypes: [""],
    });
    expect(buildMediaPayload(richerMedia, { preserveMediaTypeCardinality: true })).toEqual({
      ...compact,
      MediaTypes: [""],
    });
  });

  it("maps inbound media facts into history media entries", () => {
    expect(
      toHistoryMediaEntries([{ path: "/tmp/image.png", contentType: "image/png" }], {
        kind: "image",
        messageId: "msg-1",
      }),
    ).toEqual([
      {
        path: "/tmp/image.png",
        url: undefined,
        contentType: "image/png",
        kind: "image",
        messageId: "msg-1",
      },
    ]);
  });
});
