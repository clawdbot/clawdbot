import { listChatChannels } from "../channels/chat-meta.js";
import { normalizeChannelMeta } from "../channels/plugins/meta-normalization.js";
import type { ChannelPlugin } from "../channels/plugins/types.plugin.js";
import type { ChannelMeta } from "../channels/plugins/types.public.js";
import {
  normalizeOptionalString,
  normalizeStringifiedOptionalString,
} from "../shared/string-coerce.js";
import type { PluginDiagnostic } from "./manifest-types.js";

function pushChannelDiagnostic(params: {
  level: PluginDiagnostic["level"];
  pluginId: string;
  source: string;
  message: string;
  pushDiagnostic: (diag: PluginDiagnostic) => void;
}) {
  params.pushDiagnostic({
    level: params.level,
    pluginId: params.pluginId,
    source: params.source,
    message: params.message,
  });
}

function resolveBundledChannelMeta(id: string): ChannelMeta | undefined {
  return listChatChannels().find((meta) => meta.id === id);
}

function collectMissingChannelMetaFields(meta?: Partial<ChannelMeta> | null): string[] {
  const missing: string[] = [];
  if (!normalizeOptionalString(meta?.label)) {
    missing.push("label");
  }
  if (!normalizeOptionalString(meta?.selectionLabel)) {
    missing.push("selectionLabel");
  }
  if (!normalizeOptionalString(meta?.docsPath)) {
    missing.push("docsPath");
  }
  if (typeof meta?.blurb !== "string") {
    missing.push("blurb");
  }
  return missing;
}

export function normalizeRegisteredChannelPlugin(params: {
  pluginId: string;
  source: string;
  plugin: ChannelPlugin;
  pushDiagnostic: (diag: PluginDiagnostic) => void;
}): ChannelPlugin | null {
  const id =
    normalizeOptionalString(params.plugin?.id) ??
    normalizeStringifiedOptionalString(params.plugin?.id) ??
    "";
  if (!id) {
    pushChannelDiagnostic({
      level: "error",
      pluginId: params.pluginId,
      source: params.source,
      message: "channel registration missing id",
      pushDiagnostic: params.pushDiagnostic,
    });
    return null;
  }

  const rawMeta = params.plugin.meta as Partial<ChannelMeta> | undefined;
  const rawMetaId = normalizeOptionalString(rawMeta?.id);
  if (rawMetaId && rawMetaId !== id) {
    pushChannelDiagnostic({
      level: "warn",
      pluginId: params.pluginId,
      source: params.source,
      message: `channel "${id}" meta.id mismatch ("${rawMetaId}"); using registered channel id`,
      pushDiagnostic: params.pushDiagnostic,
    });
  }

  const missingFields = collectMissingChannelMetaFields(rawMeta);
  if (missingFields.length > 0) {
    pushChannelDiagnostic({
      level: "warn",
      pluginId: params.pluginId,
      source: params.source,
      message: `channel "${id}" registered incomplete metadata; filled missing ${missingFields.join(", ")}`,
      pushDiagnostic: params.pushDiagnostic,
    });
  }

  return {
    ...params.plugin,
    id,
    meta: normalizeChannelMeta({
      id,
      meta: rawMeta,
      existing: resolveBundledChannelMeta(id),
    }),
  };
}
