/**
 * Channel manifest metadata builder.
 *
 * Normalizes plugin manifest channel declarations into runtime/UI channel metadata.
 */
import type { PluginPackageChannel } from "../../plugins/manifest.js";
import { resolveChannelExposure } from "./exposure.js";
import type { ChannelMeta } from "./types.core.js";

type ArrayFieldMode = "defined" | "non-empty";

/**
 * Builds normalized channel metadata from a plugin manifest channel declaration.
 */
export function buildManifestChannelMeta(params: {
  id: string;
  channel: PluginPackageChannel;
  label: string;
  selectionLabel: string;
  docsPath: string;
  docsLabel?: string;
  blurb: string;
  detailLabel?: string;
  systemImage?: string;
  arrayFieldMode: ArrayFieldMode;
}): ChannelMeta {
  const hasArrayField = (value: readonly string[] | undefined) =>
    params.arrayFieldMode === "defined" ? value !== undefined : Boolean(value?.length);

  return {
    id: params.id,
    label: params.label,
    selectionLabel: params.selectionLabel,
    docsPath: params.docsPath,
    docsLabel: params.docsLabel,
    blurb: params.blurb,
    ...(hasArrayField(params.channel.aliases) ? { aliases: params.channel.aliases } : {}),
    ...(params.channel.order !== undefined ? { order: params.channel.order } : {}),
    ...(typeof params.channel.selectionDocsPrefix === "string"
      ? { selectionDocsPrefix: params.channel.selectionDocsPrefix }
      : {}),
    ...(params.channel.selectionDocsOmitLabel !== undefined
      ? { selectionDocsOmitLabel: params.channel.selectionDocsOmitLabel }
      : {}),
    ...(hasArrayField(params.channel.selectionExtras)
      ? { selectionExtras: params.channel.selectionExtras }
      : {}),
    ...(params.detailLabel ? { detailLabel: params.detailLabel } : {}),
    ...(params.systemImage ? { systemImage: params.systemImage } : {}),
    ...(params.channel.markdownCapable !== undefined
      ? { markdownCapable: params.channel.markdownCapable }
      : {}),
    // Exposure defaults and validation live in the shared exposure helper so setup and catalog
    // metadata stay aligned across bundled and external channels.
    exposure: resolveChannelExposure(params.channel),
    ...(params.channel.quickstartAllowFrom !== undefined
      ? { quickstartAllowFrom: params.channel.quickstartAllowFrom }
      : {}),
    ...(params.channel.forceAccountBinding !== undefined
      ? { forceAccountBinding: params.channel.forceAccountBinding }
      : {}),
    ...(params.channel.preferSessionLookupForAnnounceTarget !== undefined
      ? {
          preferSessionLookupForAnnounceTarget: params.channel.preferSessionLookupForAnnounceTarget,
        }
      : {}),
    ...(hasArrayField(params.channel.preferOver) ? { preferOver: params.channel.preferOver } : {}),
  };
}
