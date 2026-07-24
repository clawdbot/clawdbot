import type { PluginCompatRecord } from "./types.js";

/** Named compatibility contract for the shipped parallel media projection. */
export const MEDIA_LEGACY_PROJECTION_COMPAT_RECORD = {
  code: "media-legacy-projection",
  status: "deprecated",
  owner: "sdk",
  introduced: "2026-07-24",
  deprecated: "2026-07-24",
  warningStarts: "2026-07-24",
  // Operator-approved window: two release trains / >=60 days after the
  // replacement APIs ship. Deletion additionally gates on a clean
  // published-plugin artifact sweep at removal time.
  removeAfter: "2026-10-01",
  replacement:
    "ordered `MsgContext.media` / `InboundMediaFacts[]`; typed hook `media` and `originalMedia`; `Attachment*` template variables; and `openclaw/plugin-sdk/media-local-roots`",
  docsPath: "/plugins/sdk-migration#media-legacy-projection",
  surfaces: [
    "MsgContext MediaPath/MediaUrl/MediaType and plural/staging fields",
    "openclaw/plugin-sdk/agent-media-payload",
    "ChannelInboundMediaPayload and buildChannelInboundMediaPayload",
    "MediaPayload and buildMediaPayload",
    "message hook mediaPath/mediaUrl/mediaType and plural/original metadata aliases",
    "MediaPath/MediaUrl/MediaType/MediaDir template variables",
  ],
  diagnostics: [
    "TypeScript @deprecated annotations naming the facts-first replacement",
    "plugin boundary report compatibility inventory with the approved removeAfter date",
    "SDK, hook, and media template migration documentation",
  ],
  tests: [
    "src/sessions/user-turn-transcript.media.test.ts",
    "src/hooks/message-hook-mappers.test.ts",
    "src/media-understanding/runner.cli-audio.test.ts",
    "src/plugins/compat/registry.test.ts",
    "src/plugins/contracts/plugin-sdk-subpaths.test.ts",
  ],
  releaseNote:
    "Legacy parallel media projections remain available as deprecated compatibility while plugins move to ordered facts, typed hook media, Attachment templates, and the focused media-local-roots SDK.",
} as const satisfies PluginCompatRecord;
