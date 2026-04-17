import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import type { MatrixQaProvisionedTopology } from "./topology.js";

export type MatrixQaReplyToMode = "off" | "first" | "all" | "batched";
export type MatrixQaThreadRepliesMode = "off" | "inbound" | "always";
export type MatrixQaDmPolicy = "allowlist" | "disabled" | "open" | "pairing";
export type MatrixQaGroupPolicy = "allowlist" | "disabled" | "open";
export type MatrixQaAutoJoinMode = "allowlist" | "always" | "off";
export type MatrixQaStreamingMode = "off" | "partial" | "quiet";
export type MatrixQaActorRole = "driver" | "observer" | "sut";

export type MatrixQaAgentDefaultsOverrides = {
  blockStreamingChunk?: {
    breakPreference?: "newline" | "paragraph" | "sentence";
    maxChars?: number;
    minChars?: number;
  };
  blockStreamingCoalesce?: {
    idleMs?: number;
    maxChars?: number;
    minChars?: number;
  };
};

export type MatrixQaToolConfigOverrides = {
  allow?: string[];
  deny?: string[];
};

export type MatrixQaGroupConfigOverrides = {
  enabled?: boolean;
  requireMention?: boolean;
  tools?: MatrixQaToolConfigOverrides;
};

export type MatrixQaDmConfigOverrides = {
  allowFrom?: string[];
  enabled?: boolean;
  policy?: MatrixQaDmPolicy;
  sessionScope?: "per-room" | "per-user";
  threadReplies?: MatrixQaThreadRepliesMode;
};

export type MatrixQaThreadBindingsConfigOverrides = {
  enabled?: boolean;
  idleHours?: number;
  maxAgeHours?: number;
  spawnAcpSessions?: boolean;
  spawnSubagentSessions?: boolean;
};

export type MatrixQaConfigOverrides = {
  agentDefaults?: MatrixQaAgentDefaultsOverrides;
  autoJoin?: MatrixQaAutoJoinMode;
  autoJoinAllowlist?: string[];
  blockStreaming?: boolean;
  dm?: MatrixQaDmConfigOverrides;
  encryption?: boolean;
  groupAllowFrom?: string[];
  groupAllowRoles?: MatrixQaActorRole[];
  groupPolicy?: MatrixQaGroupPolicy;
  groupsByKey?: Record<string, MatrixQaGroupConfigOverrides>;
  replyToMode?: MatrixQaReplyToMode;
  startupVerification?: "if-unverified" | "off";
  streaming?: "off" | "partial" | "quiet" | boolean;
  threadBindings?: MatrixQaThreadBindingsConfigOverrides;
  threadReplies?: MatrixQaThreadRepliesMode;
  toolProfile?: "coding" | "messaging" | "minimal";
};

export type MatrixQaConfigSnapshot = {
  autoJoin: MatrixQaAutoJoinMode;
  autoJoinAllowlist: string[];
  blockStreaming: boolean;
  dm: {
    allowFrom: string[];
    enabled: boolean;
    policy: MatrixQaDmPolicy;
    sessionScope: "per-room" | "per-user";
    threadReplies: MatrixQaThreadRepliesMode;
  };
  encryption: boolean;
  groupAllowFrom: string[];
  groupPolicy: MatrixQaGroupPolicy;
  groupsByKey: Record<string, MatrixQaGroupSnapshot>;
  replyToMode: MatrixQaReplyToMode;
  startupVerification?: "if-unverified" | "off";
  streaming: MatrixQaStreamingMode;
  threadBindings: MatrixQaThreadBindingsConfigOverrides;
  threadReplies: MatrixQaThreadRepliesMode;
};

type MatrixQaGroupSnapshot = {
  enabled: boolean;
  requireMention: boolean;
  roomId: string;
  tools?: MatrixQaToolConfigOverrides;
};

type MatrixQaGroupEntry = Omit<MatrixQaGroupSnapshot, "roomId">;
type MatrixQaChannelConfig = NonNullable<OpenClawConfig["channels"]>["matrix"];
type MatrixQaChannelAccountConfig = NonNullable<
  NonNullable<MatrixQaChannelConfig>["accounts"]
>[string];

type MatrixQaAccountDmConfig =
  | { enabled: false }
  | {
      allowFrom: string[];
      enabled: true;
      policy: MatrixQaDmPolicy;
      sessionScope?: "per-room" | "per-user";
      threadReplies?: MatrixQaThreadRepliesMode;
    };

function normalizeMatrixQaAllowlist(entries?: string[]) {
  return [...new Set((entries ?? []).map((entry) => entry.trim()).filter(Boolean))];
}

function resolveMatrixQaGroupSnapshots(params: {
  overrides?: MatrixQaConfigOverrides;
  topology: MatrixQaProvisionedTopology;
}) {
  const groupRooms = params.topology.rooms.filter((room) => room.kind === "group");
  const groupsByKey = params.overrides?.groupsByKey ?? {};
  const knownGroupKeys = new Set(groupRooms.map((room) => room.key));

  for (const key of Object.keys(groupsByKey)) {
    if (!knownGroupKeys.has(key)) {
      throw new Error(`Matrix QA group override references unknown room key "${key}"`);
    }
  }

  return Object.fromEntries(
    groupRooms.map((room) => {
      const override = groupsByKey[room.key];
      return [
        room.key,
        {
          roomId: room.roomId,
          enabled: override?.enabled ?? true,
          requireMention: override?.requireMention ?? room.requireMention,
          ...(override?.tools ? { tools: override.tools } : {}),
        },
      ];
    }),
  );
}

function buildMatrixQaGroupEntries(
  groupsByKey: MatrixQaConfigSnapshot["groupsByKey"],
): Record<string, MatrixQaGroupEntry> {
  return Object.fromEntries(
    Object.values(groupsByKey).map((group) => [
      group.roomId,
      {
        enabled: group.enabled,
        requireMention: group.requireMention,
        ...(group.tools ? { tools: group.tools } : {}),
      },
    ]),
  );
}

function resolveMatrixQaDmAllowFrom(params: {
  driverUserId: string;
  overrides?: MatrixQaConfigOverrides;
  sutUserId: string;
  topology: MatrixQaProvisionedTopology;
}) {
  if (params.overrides?.dm?.allowFrom) {
    return normalizeMatrixQaAllowlist(params.overrides.dm.allowFrom);
  }
  const dmParticipantUserIds = params.topology.rooms
    .filter((room) => room.kind === "dm")
    .flatMap((room) => room.memberUserIds.filter((userId) => userId !== params.sutUserId));
  const dmAllowFrom = [...new Set(dmParticipantUserIds)];
  return dmAllowFrom.length > 0 ? dmAllowFrom : [params.driverUserId];
}

function resolveMatrixQaDmConfigSnapshot(params: {
  driverUserId: string;
  overrides?: MatrixQaConfigOverrides;
  sutUserId: string;
  topology: MatrixQaProvisionedTopology;
}) {
  const hasDmRooms = params.topology.rooms.some((room) => room.kind === "dm");
  const dmOverrides = params.overrides?.dm;
  const enabled = hasDmRooms || dmOverrides?.enabled === true;
  return {
    allowFrom: enabled ? resolveMatrixQaDmAllowFrom(params) : [],
    enabled,
    policy: dmOverrides?.policy ?? "allowlist",
    sessionScope: dmOverrides?.sessionScope ?? "per-user",
    threadReplies: dmOverrides?.threadReplies ?? params.overrides?.threadReplies ?? "inbound",
  };
}

function resolveMatrixQaStreamingMode(
  value: MatrixQaConfigOverrides["streaming"],
): MatrixQaStreamingMode {
  if (value === true || value === "partial") {
    return "partial";
  }
  if (value === "quiet") {
    return "quiet";
  }
  return "off";
}

function resolveMatrixQaAutoJoinAllowlist(params: { overrides?: MatrixQaConfigOverrides }) {
  if (params.overrides?.autoJoin !== "allowlist") {
    return [];
  }
  return normalizeMatrixQaAllowlist(params.overrides.autoJoinAllowlist);
}

function resolveMatrixQaRoleAllowlist(params: {
  roles?: MatrixQaActorRole[];
  driverUserId: string;
  observerUserId: string;
  sutUserId: string;
}) {
  const roleToUserId = {
    driver: params.driverUserId,
    observer: params.observerUserId,
    sut: params.sutUserId,
  } satisfies Record<MatrixQaActorRole, string>;
  return (params.roles ?? []).map((role) => roleToUserId[role]);
}

function resolveMatrixQaGroupAllowFrom(params: {
  driverUserId: string;
  observerUserId: string;
  overrides?: MatrixQaConfigOverrides;
  sutUserId: string;
}) {
  const explicitAllowFrom = params.overrides?.groupAllowFrom;
  const roleAllowFrom = resolveMatrixQaRoleAllowlist({
    roles: params.overrides?.groupAllowRoles,
    driverUserId: params.driverUserId,
    observerUserId: params.observerUserId,
    sutUserId: params.sutUserId,
  });
  if (explicitAllowFrom !== undefined || params.overrides?.groupAllowRoles !== undefined) {
    return normalizeMatrixQaAllowlist([...(explicitAllowFrom ?? []), ...roleAllowFrom]);
  }
  return [params.driverUserId];
}

function formatMatrixQaBoolean(value: boolean) {
  return value ? "true" : "false";
}

function buildMatrixQaAccountDmConfig(params: {
  dmOverrides?: MatrixQaConfigOverrides["dm"];
  snapshot: MatrixQaConfigSnapshot;
}): MatrixQaAccountDmConfig {
  if (!params.snapshot.dm.enabled) {
    return { enabled: false };
  }

  return {
    allowFrom: params.snapshot.dm.allowFrom,
    enabled: true,
    policy: params.snapshot.dm.policy,
    ...(params.dmOverrides?.sessionScope ? { sessionScope: params.snapshot.dm.sessionScope } : {}),
    ...(params.dmOverrides?.threadReplies
      ? { threadReplies: params.snapshot.dm.threadReplies }
      : {}),
  };
}

function buildMatrixQaChannelAccountConfig(params: {
  groups: Record<string, MatrixQaGroupEntry>;
  homeserver: string;
  overrides?: MatrixQaConfigOverrides;
  snapshot: MatrixQaConfigSnapshot;
  sutAccessToken: string;
  sutDeviceId?: string;
  sutUserId: string;
}): MatrixQaChannelAccountConfig {
  const groupsConfig = Object.keys(params.groups).length > 0 ? { groups: params.groups } : {};
  const autoJoinConfig =
    params.snapshot.autoJoin !== "off" ? { autoJoin: params.snapshot.autoJoin } : {};
  const autoJoinAllowlistConfig =
    params.snapshot.autoJoin === "allowlist" && params.snapshot.autoJoinAllowlist.length > 0
      ? { autoJoinAllowlist: params.snapshot.autoJoinAllowlist }
      : {};
  const blockStreamingConfig =
    params.overrides?.blockStreaming !== undefined
      ? { blockStreaming: params.snapshot.blockStreaming }
      : {};
  const streamingConfig =
    params.overrides?.streaming !== undefined ? { streaming: params.overrides.streaming } : {};
  const startupVerificationConfig =
    params.snapshot.startupVerification !== undefined
      ? { startupVerification: params.snapshot.startupVerification }
      : {};
  const threadBindingsConfig =
    params.overrides?.threadBindings !== undefined
      ? { threadBindings: params.snapshot.threadBindings }
      : {};

  return {
    accessToken: params.sutAccessToken,
    ...(params.sutDeviceId ? { deviceId: params.sutDeviceId } : {}),
    dm: buildMatrixQaAccountDmConfig({
      dmOverrides: params.overrides?.dm,
      snapshot: params.snapshot,
    }),
    enabled: true,
    encryption: params.snapshot.encryption,
    groupAllowFrom: params.snapshot.groupAllowFrom,
    groupPolicy: params.snapshot.groupPolicy,
    ...groupsConfig,
    homeserver: params.homeserver,
    network: {
      dangerouslyAllowPrivateNetwork: true,
    },
    replyToMode: params.snapshot.replyToMode,
    ...startupVerificationConfig,
    ...threadBindingsConfig,
    threadReplies: params.snapshot.threadReplies,
    userId: params.sutUserId,
    ...autoJoinConfig,
    ...autoJoinAllowlistConfig,
    ...blockStreamingConfig,
    ...streamingConfig,
  };
}

export function buildMatrixQaConfigSnapshot(params: {
  driverUserId: string;
  observerUserId: string;
  overrides?: MatrixQaConfigOverrides;
  sutUserId: string;
  topology: MatrixQaProvisionedTopology;
}): MatrixQaConfigSnapshot {
  return {
    autoJoin: params.overrides?.autoJoin ?? "off",
    autoJoinAllowlist: resolveMatrixQaAutoJoinAllowlist(params),
    blockStreaming: params.overrides?.blockStreaming ?? false,
    dm: resolveMatrixQaDmConfigSnapshot(params),
    encryption: params.overrides?.encryption ?? false,
    groupAllowFrom: resolveMatrixQaGroupAllowFrom(params),
    groupPolicy: params.overrides?.groupPolicy ?? "allowlist",
    groupsByKey: resolveMatrixQaGroupSnapshots({
      overrides: params.overrides,
      topology: params.topology,
    }),
    replyToMode: params.overrides?.replyToMode ?? "off",
    startupVerification: params.overrides?.startupVerification,
    streaming: resolveMatrixQaStreamingMode(params.overrides?.streaming),
    threadBindings: { ...params.overrides?.threadBindings },
    threadReplies: params.overrides?.threadReplies ?? "inbound",
  };
}

export function summarizeMatrixQaConfigSnapshot(snapshot: MatrixQaConfigSnapshot) {
  return [
    `replyToMode=${snapshot.replyToMode}`,
    `threadReplies=${snapshot.threadReplies}`,
    `dm.enabled=${formatMatrixQaBoolean(snapshot.dm.enabled)}`,
    `dm.policy=${snapshot.dm.policy}`,
    `dm.sessionScope=${snapshot.dm.sessionScope}`,
    `dm.threadReplies=${snapshot.dm.threadReplies}`,
    `streaming=${snapshot.streaming}`,
    `blockStreaming=${formatMatrixQaBoolean(snapshot.blockStreaming)}`,
    `autoJoin=${snapshot.autoJoin}`,
    `encryption=${formatMatrixQaBoolean(snapshot.encryption)}`,
    `startupVerification=${snapshot.startupVerification ?? "<default>"}`,
    `threadBindings.enabled=${snapshot.threadBindings.enabled ?? "<default>"}`,
    `threadBindings.spawnSubagentSessions=${snapshot.threadBindings.spawnSubagentSessions ?? "<default>"}`,
  ].join(", ");
}

export function buildMatrixQaConfig(
  baseCfg: OpenClawConfig,
  params: {
    driverUserId: string;
    homeserver: string;
    observerUserId: string;
    overrides?: MatrixQaConfigOverrides;
    sutAccessToken: string;
    sutAccountId: string;
    sutDeviceId?: string;
    sutUserId: string;
    topology: MatrixQaProvisionedTopology;
  },
): OpenClawConfig {
  const pluginAllow = [...new Set([...(baseCfg.plugins?.allow ?? []), "matrix"])];
  const snapshot = buildMatrixQaConfigSnapshot({
    driverUserId: params.driverUserId,
    observerUserId: params.observerUserId,
    overrides: params.overrides,
    sutUserId: params.sutUserId,
    topology: params.topology,
  });
  const groups = buildMatrixQaGroupEntries(snapshot.groupsByKey);

  return {
    ...baseCfg,
    ...(params.overrides?.toolProfile
      ? {
          tools: {
            ...baseCfg.tools,
            profile: params.overrides.toolProfile,
          },
        }
      : {}),
    ...(params.overrides?.agentDefaults
      ? {
          agents: {
            ...baseCfg.agents,
            defaults: {
              ...baseCfg.agents?.defaults,
              ...params.overrides.agentDefaults,
            },
          },
        }
      : {}),
    plugins: {
      ...baseCfg.plugins,
      allow: pluginAllow,
      entries: {
        ...baseCfg.plugins?.entries,
        matrix: { enabled: true },
      },
    },
    channels: {
      ...baseCfg.channels,
      matrix: {
        ...baseCfg.channels?.matrix,
        enabled: true,
        defaultAccount: params.sutAccountId,
        accounts: {
          ...baseCfg.channels?.matrix?.accounts,
          [params.sutAccountId]: buildMatrixQaChannelAccountConfig({
            groups,
            homeserver: params.homeserver,
            overrides: params.overrides,
            snapshot,
            sutAccessToken: params.sutAccessToken,
            sutDeviceId: params.sutDeviceId,
            sutUserId: params.sutUserId,
          }),
        },
      },
    },
  };
}
