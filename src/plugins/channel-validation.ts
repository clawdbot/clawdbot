// Validates channel plugin metadata from manifests and config.
import {
  normalizeOptionalString,
  normalizeStringifiedOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { normalizeTrimmedStringList } from "@openclaw/normalization-core/string-normalization";
import { listChatChannels } from "../channels/chat-meta.js";
import { normalizeChannelMeta } from "../channels/plugins/meta-normalization.js";
import type { ChannelPlugin } from "../channels/plugins/types.plugin.js";
import type { ChannelMeta } from "../channels/plugins/types.public.js";
import { GENERATED_BUNDLED_CHANNEL_CONFIG_METADATA } from "../config/bundled-channel-config-metadata.generated.js";
import type { PluginDiagnostic } from "./manifest-types.js";
import { pushPluginValidationDiagnostic } from "./validation-diagnostics.js";

function resolveBundledChannelMeta(id: string): ChannelMeta | undefined {
  return (
    listChatChannels().find((meta) => meta?.id === id) ?? resolveGeneratedBundledChannelMeta(id)
  );
}

function resolveGeneratedBundledChannelMeta(id: string): ChannelMeta | undefined {
  const channel = GENERATED_BUNDLED_CHANNEL_CONFIG_METADATA.find(
    (entry) => entry.channelId === id && entry.configurable !== false,
  );
  const label = normalizeOptionalString(channel?.label);
  if (!channel || !label) {
    return undefined;
  }
  return {
    id,
    label,
    selectionLabel: label,
    docsPath: `/channels/${id}`,
    blurb: normalizeOptionalString(channel.description) ?? "",
  };
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

function isOwnedChannelConfigPath(path: string, channelId: string): boolean {
  return path.startsWith(`channels.${channelId}.`);
}

function normalizeRegisteredChannelReload(params: {
  pluginId: string;
  source: string;
  channelId: string;
  reload: ChannelPlugin["reload"] | undefined;
  pushDiagnostic: (diag: PluginDiagnostic) => void;
}): ChannelPlugin["reload"] | undefined {
  if (!params.reload) {
    return undefined;
  }
  const { accountIndexReloadPaths: _accountIndexReloadPaths, ...reload } = params.reload;
  const accountIndexReloadPaths = normalizeTrimmedStringList(_accountIndexReloadPaths).filter(
    (path) => {
      if (isOwnedChannelConfigPath(path, params.channelId)) {
        return true;
      }
      pushPluginValidationDiagnostic({
        level: "warn",
        pluginId: params.pluginId,
        source: params.source,
        message: `channel "${params.channelId}" account-index reload path ignored outside owning config: ${path}`,
        pushDiagnostic: params.pushDiagnostic,
      });
      return false;
    },
  );
  return {
    ...reload,
    ...(accountIndexReloadPaths.length > 0 ? { accountIndexReloadPaths } : {}),
  };
}

/** Validates and normalizes a channel plugin registration before runtime catalog insertion. */
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
    pushPluginValidationDiagnostic({
      level: "error",
      pluginId: params.pluginId,
      source: params.source,
      message: "channel registration missing id",
      pushDiagnostic: params.pushDiagnostic,
    });
    return null;
  }
  if (
    typeof params.plugin.config?.listAccountIds !== "function" ||
    typeof params.plugin.config?.resolveAccount !== "function"
  ) {
    pushPluginValidationDiagnostic({
      level: "error",
      pluginId: params.pluginId,
      source: params.source,
      message: `channel "${id}" registration missing required config helpers`,
      pushDiagnostic: params.pushDiagnostic,
    });
    return null;
  }

  const rawMeta = params.plugin.meta as Partial<ChannelMeta> | undefined;
  const rawMetaId = normalizeOptionalString(rawMeta?.id);
  if (rawMetaId && rawMetaId !== id) {
    pushPluginValidationDiagnostic({
      level: "warn",
      pluginId: params.pluginId,
      source: params.source,
      message: `channel "${id}" meta.id mismatch ("${rawMetaId}"); using registered channel id`,
      pushDiagnostic: params.pushDiagnostic,
    });
  }

  const missingFields = collectMissingChannelMetaFields(rawMeta);
  if (missingFields.length > 0) {
    pushPluginValidationDiagnostic({
      level: "warn",
      pluginId: params.pluginId,
      source: params.source,
      message: `channel "${id}" registered incomplete metadata; filled missing ${missingFields.join(", ")}`,
      pushDiagnostic: params.pushDiagnostic,
    });
  }

  const reload = normalizeRegisteredChannelReload({
    pluginId: params.pluginId,
    source: params.source,
    channelId: id,
    reload: params.plugin.reload,
    pushDiagnostic: params.pushDiagnostic,
  });

  return {
    ...params.plugin,
    id,
    meta: normalizeChannelMeta({
      id,
      meta: rawMeta,
      existing: resolveBundledChannelMeta(id),
    }),
    ...(reload ? { reload } : {}),
  };
}
