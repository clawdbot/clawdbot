import { getChannelPlugin } from "../../channels/plugins/index.js";
import type {
  ChannelResolveKind,
  ChannelResolveResult,
} from "../../channels/plugins/types.adapters.js";
import { resolveCommandConfigWithSecrets } from "../../cli/command-config-resolution.js";
import { getChannelsCommandSecretTargetIds } from "../../cli/command-secret-targets.js";
import { commitConfigWithPendingPluginInstalls } from "../../cli/plugins-install-record-commit.js";
import { refreshPluginRegistryAfterConfigMutation } from "../../cli/plugins-registry-refresh.js";
import { loadConfig, readConfigFileSnapshot, replaceConfigFile } from "../../config/config.js";
import { danger } from "../../globals.js";
import { resolveMessageChannelSelection } from "../../infra/outbound/channel-selection.js";
import { type RuntimeEnv, writeRuntimeJson } from "../../runtime.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
} from "../../shared/string-coerce.js";
import { resolveInstallableChannelPlugin } from "../channel-setup/channel-plugin-resolution.js";

export type ChannelsResolveOptions = {
  channel?: string;
  account?: string;
  kind?: "auto" | "user" | "group" | "channel";
  json?: boolean;
  entries?: string[];
};

type ResolveResult = {
  input: string;
  resolved: boolean;
  id?: string;
  name?: string;
  error?: string;
  note?: string;
};

function resolvePreferredKind(
  kind?: ChannelsResolveOptions["kind"],
): ChannelResolveKind | undefined {
  if (!kind || kind === "auto") {
    return undefined;
  }
  if (kind === "user") {
    return "user";
  }
  return "group";
}

function detectAutoKind(input: string): ChannelResolveKind {
  const trimmed = input.trim();
  if (!trimmed) {
    return "group";
  }
  if (trimmed.startsWith("@")) {
    return "user";
  }
  if (/^<@!?/.test(trimmed)) {
    return "user";
  }
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
    return "user";
  }
  if (/^user:/i.test(trimmed)) {
    return "user";
  }
  return "group";
}

function detectAutoKindForPlugin(
  input: string,
  plugin?: {
    id: string;
    meta?: {
      aliases?: readonly string[];
    };
  },
): ChannelResolveKind {
  const generic = detectAutoKind(input);
  if (generic === "user" || !plugin) {
    return generic;
  }
  const trimmed = input.trim();
  const lowered = normalizeLowercaseStringOrEmpty(trimmed);
  const prefixes = [plugin.id, ...(plugin.meta?.aliases ?? [])]
    .map((entry) => normalizeOptionalLowercaseString(entry))
    .filter((entry): entry is string => Boolean(entry));
  for (const prefix of prefixes) {
    if (!lowered.startsWith(`${prefix}:`)) {
      continue;
    }
    const remainder = lowered.slice(prefix.length + 1);
    if (
      remainder.startsWith("group:") ||
      remainder.startsWith("channel:") ||
      remainder.startsWith("room:") ||
      remainder.startsWith("conversation:") ||
      remainder.startsWith("spaces/") ||
      remainder.startsWith("channels/")
    ) {
      return "group";
    }
    return "user";
  }
  return generic;
}

function formatResolveResult(result: ResolveResult): string {
  if (!result.resolved || !result.id) {
    return `${result.input} -> unresolved`;
  }
  const name = result.name ? ` (${result.name})` : "";
  const note = result.note ? ` [${result.note}]` : "";
  return `${result.input} -> ${result.id}${name}${note}`;
}

export async function channelsResolveCommand(opts: ChannelsResolveOptions, runtime: RuntimeEnv) {
  const sourceSnapshotPromise = readConfigFileSnapshot().catch(() => null);
  const loadedRaw = loadConfig();
  let { effectiveConfig: cfg } = await resolveCommandConfigWithSecrets({
    config: loadedRaw,
    commandName: "channels resolve",
    targetIds: getChannelsCommandSecretTargetIds(),
    mode: "read_only_operational",
    runtime,
    autoEnable: true,
  });
  const entries = (opts.entries ?? []).map((entry) => entry.trim()).filter(Boolean);
  if (entries.length === 0) {
    throw new Error("At least one entry is required.");
  }

  const explicitChannel = opts.channel?.trim();
  const resolvedExplicit = explicitChannel
    ? await resolveInstallableChannelPlugin({
        cfg,
        runtime,
        rawChannel: explicitChannel,
        allowInstall: true,
        supports: (plugin) => Boolean(plugin.resolver?.resolveTargets),
      })
    : null;
  if (resolvedExplicit?.configChanged) {
    cfg = resolvedExplicit.cfg;
    const shouldMovePluginInstalls = Boolean(
      cfg.plugins?.installs && Object.keys(cfg.plugins.installs).length > 0,
    );
    if (shouldMovePluginInstalls) {
      const committed = await commitConfigWithPendingPluginInstalls({
        nextConfig: cfg,
        baseHash: (await sourceSnapshotPromise)?.hash,
      });
      cfg = committed.config;
      await refreshPluginRegistryAfterConfigMutation({
        config: cfg,
        reason: "source-changed",
        installRecords: committed.installRecords,
        logger: { warn: (message) => runtime.log(message) },
      });
    } else {
      await replaceConfigFile({
        nextConfig: cfg,
        baseHash: (await sourceSnapshotPromise)?.hash,
      });
      if (resolvedExplicit.pluginInstalled) {
        await refreshPluginRegistryAfterConfigMutation({
          config: cfg,
          reason: "source-changed",
          logger: { warn: (message) => runtime.log(message) },
        });
      }
    }
  }

  const selection = explicitChannel
    ? {
        channel: resolvedExplicit?.channelId,
      }
    : await resolveMessageChannelSelection({
        cfg,
        channel: opts.channel ?? null,
      });
  const plugin =
    (explicitChannel ? resolvedExplicit?.plugin : undefined) ??
    (selection.channel ? getChannelPlugin(selection.channel) : undefined);
  if (!plugin?.resolver?.resolveTargets) {
    const channelText = selection.channel ?? explicitChannel ?? "";
    throw new Error(`Channel ${channelText} does not support resolve.`);
  }
  const preferredKind = resolvePreferredKind(opts.kind);

  let results: ResolveResult[] = [];
  if (preferredKind) {
    const resolved = await plugin.resolver.resolveTargets({
      cfg,
      accountId: opts.account ?? null,
      inputs: entries,
      kind: preferredKind,
      runtime,
    });
    results = resolved.map((entry) => ({
      input: entry.input,
      resolved: entry.resolved,
      id: entry.id,
      name: entry.name,
      note: entry.note,
    }));
  } else {
    const byKind = new Map<ChannelResolveKind, string[]>();
    for (const entry of entries) {
      const kind = detectAutoKindForPlugin(entry, plugin);
      byKind.set(kind, [...(byKind.get(kind) ?? []), entry]);
    }
    const resolved: ChannelResolveResult[] = [];
    for (const [kind, inputs] of byKind.entries()) {
      const batch = await plugin.resolver.resolveTargets({
        cfg,
        accountId: opts.account ?? null,
        inputs,
        kind,
        runtime,
      });
      resolved.push(...batch);
    }
    const byInput = new Map(resolved.map((entry) => [entry.input, entry]));
    results = entries.map((input) => {
      const entry = byInput.get(input);
      return {
        input,
        resolved: entry?.resolved ?? false,
        id: entry?.id,
        name: entry?.name,
        note: entry?.note,
      };
    });
  }

  if (opts.json) {
    writeRuntimeJson(runtime, results);
    return;
  }

  for (const result of results) {
    if (result.resolved && result.id) {
      runtime.log(formatResolveResult(result));
    } else {
      runtime.error(
        danger(
          `${result.input} -> unresolved${result.error ? ` (${result.error})` : result.note ? ` (${result.note})` : ""}`,
        ),
      );
    }
  }
}
