// Qa Matrix helper module supports config behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { normalizeStringEntries, uniqueStrings } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { MatrixQaProvisionedTopology } from "./topology.js";

type MatrixQaReplyToMode = "off" | "first" | "all" | "batched";
type MatrixQaThreadRepliesMode = "off" | "inbound" | "always";
type MatrixQaDmPolicy = "allowlist" | "disabled" | "open" | "pairing";
type MatrixQaGroupPolicy = "allowlist" | "disabled" | "open";
type MatrixQaAutoJoinMode = "allowlist" | "always" | "off";
type MatrixQaStreamingMode = "off" | "partial" | "quiet";
type MatrixQaActorRole = "driver" | "observer" | "sut";
type MatrixQaChunkMode = "length" | "newline";
type MatrixQaExecApprovalTarget = "both" | "channel" | "dm";
type MatrixQaExecApprovalsEnabled = boolean | "auto";
type MatrixQaAllowBotsMode = boolean | "mentions";

type MatrixQaStreamingConfig = {
  mode?: MatrixQaStreamingMode;
  preview?: {
    toolProgress?: boolean;
  };
};

type MatrixQaAgentDefaultsOverrides = {
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

type MatrixQaToolConfigOverrides = {
  allow?: string[];
  deny?: string[];
};

type MatrixQaAudioConfigOverrides = NonNullable<
  NonNullable<NonNullable<OpenClawConfig["tools"]>["media"]>["audio"]
>;

type MatrixQaGroupConfigOverrides = {
  allowBots?: MatrixQaAllowBotsMode;
  enabled?: boolean;
  requireMention?: boolean;
  tools?: MatrixQaToolConfigOverrides;
};

type MatrixQaDmConfigOverrides = {
  allowFrom?: string[];
  enabled?: boolean;
  policy?: MatrixQaDmPolicy;
  sessionScope?: "per-room" | "per-user";
  threadReplies?: MatrixQaThreadRepliesMode;
};

type MatrixQaThreadBindingsConfigOverrides = {
  enabled?: boolean;
  idleHours?: number;
  maxAgeHours?: number;
  spawnSessions?: boolean;
  defaultSpawnContext?: "isolated" | "fork";
  /** @deprecated Use spawnSessions instead. */
  spawnAcpSessions?: boolean;
  /** @deprecated Use spawnSessions instead. */
  spawnSubagentSessions?: boolean;
};

type MatrixQaExecApprovalsConfigOverrides = {
  agentFilter?: string[];
  approvers?: string[];
  enabled?: MatrixQaExecApprovalsEnabled;
  sessionFilter?: string[];
  target?: MatrixQaExecApprovalTarget;
};

export type MatrixQaConfigOverrides = {
  approvalForwarding?: {
    exec?: boolean;
    plugin?: boolean;
  };
  agentDefaults?: MatrixQaAgentDefaultsOverrides;
  allowBots?: MatrixQaAllowBotsMode;
  autoJoin?: MatrixQaAutoJoinMode;
  autoJoinAllowlist?: string[];
  blockStreaming?: boolean;
  chunkMode?: MatrixQaChunkMode;
  dm?: MatrixQaDmConfigOverrides;
  encryption?: boolean;
  execApprovals?: MatrixQaExecApprovalsConfigOverrides;
  groupAllowFrom?: string[];
  groupAllowRoles?: MatrixQaActorRole[];
  groupMentionPatterns?: string[];
  groupPolicy?: MatrixQaGroupPolicy;
  configuredBotRoles?: MatrixQaActorRole[];
  groupsByKey?: Record<string, MatrixQaGroupConfigOverrides>;
  replyToMode?: MatrixQaReplyToMode;
  startupVerification?: "if-unverified" | "off";
  streaming?: MatrixQaStreamingMode | MatrixQaStreamingConfig | boolean;
  textChunkLimit?: number;
  threadBindings?: MatrixQaThreadBindingsConfigOverrides;
  threadReplies?: MatrixQaThreadRepliesMode;
  audio?: MatrixQaAudioConfigOverrides;
  toolProfile?: "coding" | "messaging" | "minimal";
};

export type MatrixQaConfigSnapshot = {
  approvalForwarding: {
    exec: boolean;
    plugin: boolean;
  };
  autoJoin: MatrixQaAutoJoinMode;
  autoJoinAllowlist: string[];
  allowBots?: MatrixQaAllowBotsMode;
  blockStreaming: boolean;
  chunkMode?: MatrixQaChunkMode;
  dm: {
    allowFrom: string[];
    enabled: boolean;
    policy: MatrixQaDmPolicy;
    sessionScope: "per-room" | "per-user";
    threadReplies: MatrixQaThreadRepliesMode;
  };
  encryption: boolean;
  execApprovals?: MatrixQaExecApprovalsConfigOverrides;
  configuredBotRoles: MatrixQaActorRole[];
  groupAllowFrom: string[];
  groupMentionPatterns: string[];
  groupPolicy: MatrixQaGroupPolicy;
  groupsByKey: Record<string, MatrixQaGroupSnapshot>;
  replyToMode: MatrixQaReplyToMode;
  startupVerification?: "if-unverified" | "off";
  streaming: MatrixQaStreamingMode;
  streamingPreviewToolProgress: boolean;
  textChunkLimit?: number;
  threadBindings: MatrixQaThreadBindingsConfigOverrides;
  threadReplies: MatrixQaThreadRepliesMode;
};

type MatrixQaGroupSnapshot = {
  allowBots?: MatrixQaAllowBotsMode;
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

type MatrixQaAccountExecApprovalsConfig = {
  agentFilter?: string[];
  approvers?: string[];
  enabled?: MatrixQaExecApprovalsEnabled;
  sessionFilter?: string[];
  target?: MatrixQaExecApprovalTarget;
};

function normalizeMatrixQaAllowlist(entries?: string[]) {
  return uniqueStrings(normalizeStringEntries(entries ?? []));
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
          ...(override && Object.hasOwn(override, "allowBots")
            ? { allowBots: override.allowBots }
            : {}),
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
        ...(group.allowBots !== undefined ? { allowBots: group.allowBots } : {}),
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
  const dmAllowFrom = uniqueStrings(dmParticipantUserIds);
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
  if (isMatrixQaStreamingConfig(value)) {
    if (value.mode === "partial" || value.mode === "quiet") {
      return value.mode;
    }
  }
  return "off";
}

function isMatrixQaStreamingConfig(
  value: MatrixQaConfigOverrides["streaming"],
): value is MatrixQaStreamingConfig {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function resolveMatrixQaStreamingPreviewToolProgress(
  value: MatrixQaConfigOverrides["streaming"],
): boolean {
  if (!isMatrixQaStreamingConfig(value)) {
    return true;
  }
  return value.preview?.toolProgress ?? true;
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

function buildMatrixQaAccountExecApprovalsConfig(
  overrides?: MatrixQaExecApprovalsConfigOverrides,
): MatrixQaAccountExecApprovalsConfig | undefined {
  if (!overrides) {
    return undefined;
  }
  return {
    ...(overrides.agentFilter ? { agentFilter: overrides.agentFilter } : {}),
    ...(overrides.approvers ? { approvers: normalizeMatrixQaAllowlist(overrides.approvers) } : {}),
    ...(overrides.enabled !== undefined ? { enabled: overrides.enabled } : {}),
    ...(overrides.sessionFilter ? { sessionFilter: overrides.sessionFilter } : {}),
    ...(overrides.target ? { target: overrides.target } : {}),
  };
}

function buildMatrixQaConfiguredBotAccounts(params: {
  driverAccessToken: string | undefined;
  driverUserId: string;
  homeserver: string;
  observerAccessToken: string | undefined;
  observerUserId: string;
  roles: MatrixQaActorRole[];
}): Record<string, MatrixQaChannelAccountConfig> {
  const selectedRoles = new Set(params.roles);
  if (selectedRoles.has("sut")) {
    throw new Error('Matrix QA configured bot role "sut" would match the SUT account itself');
  }

  const botSources: Record<
    Exclude<MatrixQaActorRole, "sut">,
    {
      accessToken: string | undefined;
      accountId: string;
      userId: string;
    }
  > = {
    driver: {
      accessToken: params.driverAccessToken,
      accountId: "qa-driver-bot-source",
      userId: params.driverUserId,
    },
    observer: {
      accessToken: params.observerAccessToken,
      accountId: "qa-observer-bot-source",
      userId: params.observerUserId,
    },
  };

  const accounts: Record<string, MatrixQaChannelAccountConfig> = {};
  for (const role of selectedRoles) {
    if (role !== "driver" && role !== "observer") {
      continue;
    }
    const source = botSources[role];
    if (!source.accessToken) {
      throw new Error(`Matrix QA configured bot role "${role}" requires an access token`);
    }
    accounts[source.accountId] = {
      accessToken: source.accessToken,
      enabled: false,
      homeserver: params.homeserver,
      userId: source.userId,
    };
  }

  return accounts;
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
  const execApprovalsConfig = buildMatrixQaAccountExecApprovalsConfig(
    params.snapshot.execApprovals,
  );
  // Matrix accepts only the nested streaming shape; harness overrides keep
  // their scalar/boolean vocabulary and normalize here before config write.
  const streamingSlots = {
    ...(params.overrides?.streaming !== undefined
      ? { mode: resolveMatrixQaStreamingMode(params.overrides.streaming) }
      : {}),
    ...(isMatrixQaStreamingConfig(params.overrides?.streaming) &&
    params.overrides.streaming.preview?.toolProgress !== undefined
      ? { preview: { toolProgress: params.overrides.streaming.preview.toolProgress } }
      : {}),
    ...(params.snapshot.chunkMode !== undefined ? { chunkMode: params.snapshot.chunkMode } : {}),
    ...(params.overrides?.blockStreaming !== undefined
      ? { block: { enabled: params.snapshot.blockStreaming } }
      : {}),
  };
  const streamingConfig =
    Object.keys(streamingSlots).length > 0 ? { streaming: streamingSlots } : {};
  const startupVerificationConfig =
    params.snapshot.startupVerification !== undefined
      ? { startupVerification: params.snapshot.startupVerification }
      : {};
  const threadBindingsConfig =
    params.overrides?.threadBindings !== undefined
      ? { threadBindings: params.snapshot.threadBindings }
      : {};
  const textChunkLimitConfig =
    params.snapshot.textChunkLimit !== undefined
      ? { textChunkLimit: params.snapshot.textChunkLimit }
      : {};

  return {
    accessToken: params.sutAccessToken,
    ...(params.sutDeviceId ? { deviceId: params.sutDeviceId } : {}),
    dm: buildMatrixQaAccountDmConfig({
      dmOverrides: params.overrides?.dm,
      snapshot: params.snapshot,
    }),
    ...(params.snapshot.allowBots !== undefined ? { allowBots: params.snapshot.allowBots } : {}),
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
    ...(execApprovalsConfig ? { execApprovals: execApprovalsConfig } : {}),
    ...streamingConfig,
    ...textChunkLimitConfig,
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
    allowBots: params.overrides?.allowBots,
    autoJoin: params.overrides?.autoJoin ?? "off",
    autoJoinAllowlist: resolveMatrixQaAutoJoinAllowlist(params),
    blockStreaming: params.overrides?.blockStreaming ?? false,
    chunkMode: params.overrides?.chunkMode,
    dm: resolveMatrixQaDmConfigSnapshot(params),
    encryption: params.overrides?.encryption ?? false,
    execApprovals: params.overrides?.execApprovals,
    configuredBotRoles: [...(params.overrides?.configuredBotRoles ?? [])],
    groupAllowFrom: resolveMatrixQaGroupAllowFrom(params),
    groupMentionPatterns: normalizeMatrixQaAllowlist(params.overrides?.groupMentionPatterns),
    groupPolicy: params.overrides?.groupPolicy ?? "allowlist",
    groupsByKey: resolveMatrixQaGroupSnapshots({
      overrides: params.overrides,
      topology: params.topology,
    }),
    replyToMode: params.overrides?.replyToMode ?? "off",
    startupVerification: params.overrides?.startupVerification,
    streaming: resolveMatrixQaStreamingMode(params.overrides?.streaming),
    streamingPreviewToolProgress: resolveMatrixQaStreamingPreviewToolProgress(
      params.overrides?.streaming,
    ),
    threadBindings: { ...params.overrides?.threadBindings },
    textChunkLimit: params.overrides?.textChunkLimit,
    threadReplies: params.overrides?.threadReplies ?? "inbound",
    approvalForwarding: {
      exec:
        params.overrides?.approvalForwarding?.exec ?? params.overrides?.execApprovals !== undefined,
      plugin: params.overrides?.approvalForwarding?.plugin ?? false,
    },
  };
}

export function summarizeMatrixQaConfigSnapshot(snapshot: MatrixQaConfigSnapshot) {
  return [
    `allowBots=${snapshot.allowBots ?? "<default>"}`,
    `configuredBotRoles=${snapshot.configuredBotRoles.length > 0 ? snapshot.configuredBotRoles.join("|") : "<none>"}`,
    `replyToMode=${snapshot.replyToMode}`,
    `threadReplies=${snapshot.threadReplies}`,
    `dm.enabled=${formatMatrixQaBoolean(snapshot.dm.enabled)}`,
    `dm.policy=${snapshot.dm.policy}`,
    `dm.sessionScope=${snapshot.dm.sessionScope}`,
    `dm.threadReplies=${snapshot.dm.threadReplies}`,
    `groupMentionPatterns=${snapshot.groupMentionPatterns.length > 0 ? snapshot.groupMentionPatterns.join("|") : "<default>"}`,
    `streaming=${snapshot.streaming}`,
    `streaming.preview.toolProgress=${formatMatrixQaBoolean(snapshot.streamingPreviewToolProgress)}`,
    `textChunkLimit=${snapshot.textChunkLimit ?? "<default>"}`,
    `chunkMode=${snapshot.chunkMode ?? "<default>"}`,
    `execApprovals.enabled=${snapshot.execApprovals?.enabled ?? "<default>"}`,
    `execApprovals.target=${snapshot.execApprovals?.target ?? "<default>"}`,
    `blockStreaming=${formatMatrixQaBoolean(snapshot.blockStreaming)}`,
    `autoJoin=${snapshot.autoJoin}`,
    `encryption=${formatMatrixQaBoolean(snapshot.encryption)}`,
    `startupVerification=${snapshot.startupVerification ?? "<default>"}`,
    `threadBindings.enabled=${snapshot.threadBindings.enabled ?? "<default>"}`,
    `threadBindings.spawnSessions=${snapshot.threadBindings.spawnSessions ?? "<default>"}`,
    `approvals.exec.enabled=${formatMatrixQaBoolean(snapshot.approvalForwarding.exec)}`,
    `approvals.plugin.enabled=${formatMatrixQaBoolean(snapshot.approvalForwarding.plugin)}`,
  ].join(", ");
}

export function buildMatrixQaConfig(
  baseCfg: OpenClawConfig,
  params: {
    driverAccessToken?: string;
    driverUserId: string;
    homeserver: string;
    observerAccessToken?: string;
    observerUserId: string;
    overrides?: MatrixQaConfigOverrides;
    sutAccessToken: string;
    sutAccountId: string;
    sutDeviceId?: string;
    sutUserId: string;
    topology: MatrixQaProvisionedTopology;
  },
): OpenClawConfig {
  const pluginAllow = uniqueStrings([...(baseCfg.plugins?.allow ?? []), "matrix"]);
  const snapshot = buildMatrixQaConfigSnapshot({
    driverUserId: params.driverUserId,
    observerUserId: params.observerUserId,
    overrides: params.overrides,
    sutUserId: params.sutUserId,
    topology: params.topology,
  });
  const groups = buildMatrixQaGroupEntries(snapshot.groupsByKey);
  const configuredBotAccounts = buildMatrixQaConfiguredBotAccounts({
    driverAccessToken: params.driverAccessToken,
    driverUserId: params.driverUserId,
    homeserver: params.homeserver,
    observerAccessToken: params.observerAccessToken,
    observerUserId: params.observerUserId,
    roles: snapshot.configuredBotRoles,
  });
  const approvalForwardingConfig =
    snapshot.approvalForwarding.exec || snapshot.approvalForwarding.plugin
      ? {
          approvals: {
            ...baseCfg.approvals,
            ...(snapshot.approvalForwarding.exec
              ? {
                  exec: {
                    ...baseCfg.approvals?.exec,
                    enabled: true,
                    mode: "session" as const,
                  },
                }
              : {}),
            ...(snapshot.approvalForwarding.plugin
              ? {
                  plugin: {
                    ...baseCfg.approvals?.plugin,
                    enabled: true,
                    mode: "session" as const,
                  },
                }
              : {}),
          },
        }
      : {};

  const toolsConfig =
    params.overrides?.toolProfile || params.overrides?.audio
      ? {
          ...baseCfg.tools,
          ...(params.overrides?.toolProfile
            ? {
                profile: params.overrides.toolProfile,
              }
            : {}),
          ...(params.overrides?.audio
            ? {
                media: {
                  ...baseCfg.tools?.media,
                  audio: {
                    ...baseCfg.tools?.media?.audio,
                    ...params.overrides.audio,
                  },
                },
              }
            : {}),
        }
      : undefined;

  return {
    ...baseCfg,
    ...approvalForwardingConfig,
    ...(toolsConfig
      ? {
          tools: toolsConfig,
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
    messages: {
      ...baseCfg.messages,
      groupChat: {
        ...baseCfg.messages?.groupChat,
        ...(snapshot.groupMentionPatterns.length > 0
          ? { mentionPatterns: snapshot.groupMentionPatterns }
          : {}),
        visibleReplies: "automatic",
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
          ...configuredBotAccounts,
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
