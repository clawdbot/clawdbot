// Resolves configured open inbound policies for security audit consumers.
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import type { ChannelDmAllowFromMode } from "../channels/plugins/dm-access.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { listChannelCatalogEntries } from "../plugins/channel-catalog-registry.js";

const CHANNEL_ORIGIN_RANK = { config: 0, workspace: 1, global: 2, bundled: 3 } as const;
const NON_POLICY_CHANNEL_ROOTS = new Set(["modelByChannel", "tools"]);

export type ConfiguredOpenInboundPolicyOptions = {
  dmAllowFromModes?: ReadonlyMap<string, ChannelDmAllowFromMode>;
};

/** Resolve channel-owned DM field precedence once for all audit consumers. */
export function resolveConfiguredChannelDmAllowFromModes(params: {
  env?: NodeJS.ProcessEnv;
  workspaceDir?: string;
}): ReadonlyMap<string, ChannelDmAllowFromMode> {
  const modes = new Map<string, { mode: ChannelDmAllowFromMode; rank: number }>();
  for (const entry of listChannelCatalogEntries(params)) {
    const mode = entry.channel.doctorCapabilities?.dmAllowFromMode;
    if (!mode) {
      continue;
    }
    const rank = CHANNEL_ORIGIN_RANK[entry.origin];
    for (const rawChannelId of [entry.channel.id, ...(entry.channel.aliases ?? [])]) {
      const channelId = rawChannelId?.trim();
      if (!channelId) {
        continue;
      }
      const current = modes.get(channelId);
      if (!current || rank <= current.rank) {
        modes.set(channelId, { mode, rank });
      }
    }
  }
  return new Map([...modes].map(([channelId, entry]) => [channelId, entry.mode]));
}

function resolveOpenDmPolicyPath(params: {
  record: Record<string, unknown>;
  scope: string;
  mode: ChannelDmAllowFromMode;
}): string | undefined {
  const nestedPolicy = asNullableRecord(params.record.dm)?.policy;
  const topPolicy = params.record.dmPolicy;
  const nestedFirst = params.mode === "nestedOnly";
  const policy = nestedFirst ? (nestedPolicy ?? topPolicy) : (topPolicy ?? nestedPolicy);
  if (policy !== "open") {
    return undefined;
  }
  const nestedWon = nestedFirst ? nestedPolicy != null : topPolicy == null;
  return `${params.scope}.${nestedWon ? "dm.policy" : "dmPolicy"}`;
}

/** List configured open group/DM policy paths across channel-owned nested scopes. */
export function listConfiguredOpenInboundPolicyPaths(
  cfg: OpenClawConfig,
  options: ConfiguredOpenInboundPolicyOptions = {},
): string[] {
  const channels = asNullableRecord(cfg.channels);
  if (!channels) {
    return [];
  }
  const dmAllowFromModes = options.dmAllowFromModes ?? new Map();
  const paths = new Set<string>();
  const seen = new WeakSet<object>();
  const visit = (value: unknown, scope: string, dmMode: ChannelDmAllowFromMode): void => {
    const record = asNullableRecord(value);
    if (!record || seen.has(record)) {
      return;
    }
    seen.add(record);
    if (record.groupPolicy === "open") {
      paths.add(`${scope}.groupPolicy`);
    }
    const dmPolicyPath = resolveOpenDmPolicyPath({ record, scope, mode: dmMode });
    if (dmPolicyPath) {
      paths.add(dmPolicyPath);
    }
    for (const [key, nested] of Object.entries(record)) {
      if (asNullableRecord(nested)) {
        visit(nested, `${scope}.${key}`, dmMode);
      }
    }
  };
  for (const [channelId, channel] of Object.entries(channels)) {
    if (NON_POLICY_CHANNEL_ROOTS.has(channelId)) {
      continue;
    }
    visit(channel, `channels.${channelId}`, dmAllowFromModes.get(channelId) ?? "topOnly");
  }
  return [...paths].toSorted();
}
