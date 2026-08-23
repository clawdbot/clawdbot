// Qa Lab Matrix helper module supports config behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  isRecord,
  normalizeStringEntries,
  uniqueStrings,
} from "openclaw/plugin-sdk/string-coerce-runtime";
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
type MatrixQaMediaModelsOverrides = NonNullable<
  NonNullable<NonNullable<OpenClawConfig["tools"]>["media"]>["models"]
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
  mediaModels?: MatrixQaMediaModelsOverrides;
  toolProfile?: "coding" | "messaging" | "minimal";
};

type MatrixQaConfigSnapshot = {
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
type MatrixQaChannelAccountConfig = Record<string, unknown> & {
  groups?: Record<string, MatrixQaGroupEntry & Record<string, unknown>>;
  network?: Record<string, unknown>;
  streaming?: Record<string, unknown>;
};

function restoreOwnedFields(
  current: unknown,
  baseline: unknown,
  fields: readonly string[],
): Record<string, unknown> {
  const result = isRecord(current) ? structuredClone(current) : {};
  const baselineRecord = isRecord(baseline) ? baseline : {};
  for (const field of fields) {
    if (Object.hasOwn(baselineRecord, field)) {
      result[field] = structuredClone(baselineRecord[field]);
    } else {
      delete result[field];
    }
  }
  return result;
}

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
  currentGroups: MatrixQaChannelAccountConfig["groups"],
  baselineGroups: MatrixQaChannelAccountConfig["groups"],
): Record<string, MatrixQaGroupEntry> {
  const result = structuredClone(currentGroups ?? {}) as Record<string, MatrixQaGroupEntry>;
  for (const group of Object.values(groupsByKey)) {
    const current = currentGroups?.[group.roomId];
    const baseline = baselineGroups?.[group.roomId];
    const entry = restoreOwnedFields(current, baseline, ["allowBots", "enabled", "requireMention"]);
    const tools = restoreOwnedFields(current?.tools, baseline?.tools, ["allow", "deny"]);
    Object.assign(entry, { enabled: group.enabled, requireMention: group.requireMention });
    if (group.allowBots !== undefined) {
      entry.allowBots = group.allowBots;
    }
    if (group.tools) {
      Object.assign(tools, group.tools);
    }
    delete entry.tools;
    if (Object.keys(tools).length > 0) {
      entry.tools = tools;
    }
    result[group.roomId] = entry as MatrixQaGroupEntry;
  }
  return result;
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
  const enabled = dmOverrides?.enabled ?? hasDmRooms;
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

const MATRIX_QA_BOT_SOURCE_ACCOUNT_IDS = {
  driver: "qa-driver-bot-source",
  observer: "qa-observer-bot-source",
} as const;

function buildMatrixQaConfiguredBotAccounts(params: {
  driverAccessToken: string | undefined;
  driverUserId: string;
  homeserver: string;
  observerAccessToken: string | undefined;
  observerUserId: string;
  roles: MatrixQaActorRole[];
}): Record<string, MatrixQaChannelAccountConfig> {
  if (params.roles.includes("sut")) {
    throw new Error('Matrix QA configured bot role "sut" would match the SUT account itself');
  }
  const botSources = {
    driver: {
      accessToken: params.driverAccessToken,
      accountId: MATRIX_QA_BOT_SOURCE_ACCOUNT_IDS.driver,
      userId: params.driverUserId,
    },
    observer: {
      accessToken: params.observerAccessToken,
      accountId: MATRIX_QA_BOT_SOURCE_ACCOUNT_IDS.observer,
      userId: params.observerUserId,
    },
  } as const;
  const accounts: Record<string, MatrixQaChannelAccountConfig> = {};
  const roles = params.roles as Array<keyof typeof botSources>;
  for (const role of roles) {
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
  baselineAccount: MatrixQaChannelAccountConfig | undefined;
  currentAccount: MatrixQaChannelAccountConfig | undefined;
  groups: Record<string, MatrixQaGroupEntry>;
  homeserver: string;
  overrides?: MatrixQaConfigOverrides;
  snapshot: MatrixQaConfigSnapshot;
  sutAccessToken: string;
  sutDeviceId?: string;
  sutUserId: string;
}): MatrixQaChannelAccountConfig {
  const { currentAccount: current, baselineAccount: baseline } = params;
  const account = restoreOwnedFields(
    current,
    baseline,
    "allowBots autoJoin autoJoinAllowlist startupVerification".split(" "),
  );
  for (const field of ["execApprovals", "groups", "threadBindings"]) {
    delete account[field];
  }
  const dm = restoreOwnedFields(
    current?.dm,
    params.snapshot.dm.enabled ? baseline?.dm : undefined,
    "allowFrom enabled policy sessionScope threadReplies".split(" "),
  );
  if (!params.snapshot.dm.enabled) {
    dm.enabled = false;
  } else {
    Object.assign(dm, {
      allowFrom: params.snapshot.dm.allowFrom,
      enabled: true,
      policy: params.snapshot.dm.policy,
      ...(params.overrides?.dm?.sessionScope !== undefined
        ? { sessionScope: params.snapshot.dm.sessionScope }
        : {}),
      ...(params.overrides?.dm?.threadReplies !== undefined
        ? { threadReplies: params.snapshot.dm.threadReplies }
        : {}),
    });
  }
  const execApprovals = restoreOwnedFields(
    current?.execApprovals,
    baseline?.execApprovals,
    "agentFilter approvers enabled sessionFilter target".split(" "),
  );
  const execOverrides = params.snapshot.execApprovals;
  Object.assign(execApprovals, {
    ...(execOverrides?.agentFilter ? { agentFilter: execOverrides.agentFilter } : {}),
    ...(execOverrides?.approvers
      ? { approvers: normalizeMatrixQaAllowlist(execOverrides.approvers) }
      : {}),
    ...(execOverrides?.enabled !== undefined ? { enabled: execOverrides.enabled } : {}),
    ...(execOverrides?.sessionFilter ? { sessionFilter: execOverrides.sessionFilter } : {}),
    ...(execOverrides?.target ? { target: execOverrides.target } : {}),
  });
  const streaming = restoreOwnedFields(current?.streaming, baseline?.streaming, [
    "chunkMode",
    "mode",
  ]);
  const block = restoreOwnedFields(current?.streaming?.block, baseline?.streaming?.block, [
    "enabled",
  ]);
  const preview = restoreOwnedFields(current?.streaming?.preview, baseline?.streaming?.preview, [
    "toolProgress",
  ]);
  Object.assign(streaming, {
    block: { ...block, enabled: params.snapshot.blockStreaming },
    chunkMode: params.snapshot.chunkMode ?? "length",
    mode: params.snapshot.streaming,
    preview: { ...preview, toolProgress: params.snapshot.streamingPreviewToolProgress },
  });
  const threadBindings = restoreOwnedFields(
    current?.threadBindings,
    baseline?.threadBindings,
    "enabled idleHours maxAgeHours spawnSessions defaultSpawnContext".split(" "),
  );
  Object.assign(threadBindings, params.overrides?.threadBindings);
  Object.assign(account, {
    accessToken: params.sutAccessToken,
    ...(params.sutDeviceId ? { deviceId: params.sutDeviceId } : {}),
    dm,
    enabled: true,
    encryption: params.snapshot.encryption,
    groupAllowFrom: params.snapshot.groupAllowFrom,
    groupPolicy: params.snapshot.groupPolicy,
    ...(Object.keys(params.groups).length > 0 ? { groups: params.groups } : {}),
    homeserver: params.homeserver,
    network: {
      ...current?.network,
      dangerouslyAllowPrivateNetwork: true,
    },
    replyToMode: params.snapshot.replyToMode,
    ...(Object.keys(execApprovals).length > 0 ? { execApprovals } : {}),
    ...(params.overrides?.startupVerification !== undefined
      ? { startupVerification: params.snapshot.startupVerification }
      : {}),
    streaming,
    ...(Object.keys(threadBindings).length > 0 ? { threadBindings } : {}),
    threadReplies: params.snapshot.threadReplies,
    userId: params.sutUserId,
    textChunkLimit: params.snapshot.textChunkLimit ?? 4000,
  });
  if (params.overrides?.allowBots !== undefined) {
    account.allowBots = params.snapshot.allowBots;
  }
  if (params.overrides?.autoJoin !== undefined) {
    if (params.snapshot.autoJoin === "off") {
      delete account.autoJoin;
      delete account.autoJoinAllowlist;
    } else {
      account.autoJoin = params.snapshot.autoJoin;
      if (params.snapshot.autoJoin === "allowlist") {
        account.autoJoinAllowlist = params.snapshot.autoJoinAllowlist;
      } else {
        delete account.autoJoinAllowlist;
      }
    }
  }
  return account as MatrixQaChannelAccountConfig;
}

function buildMatrixQaConfigSnapshot(params: {
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

export function buildMatrixQaConfig(
  baselineCfg: OpenClawConfig,
  params: {
    currentConfig?: OpenClawConfig;
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
  const currentCfg = params.currentConfig ?? baselineCfg;
  const pluginAllow = uniqueStrings([...(currentCfg.plugins?.allow ?? []), "matrix"]);
  const snapshot = buildMatrixQaConfigSnapshot({
    driverUserId: params.driverUserId,
    observerUserId: params.observerUserId,
    overrides: params.overrides,
    sutUserId: params.sutUserId,
    topology: params.topology,
  });
  const currentAccount = currentCfg.channels?.matrix?.accounts?.[params.sutAccountId];
  const baselineAccount = baselineCfg.channels?.matrix?.accounts?.[params.sutAccountId];
  const groups = buildMatrixQaGroupEntries(
    snapshot.groupsByKey,
    currentAccount?.groups,
    baselineAccount?.groups,
  );
  const configuredBotAccounts = buildMatrixQaConfiguredBotAccounts({
    driverAccessToken: params.driverAccessToken,
    driverUserId: params.driverUserId,
    homeserver: params.homeserver,
    observerAccessToken: params.observerAccessToken,
    observerUserId: params.observerUserId,
    roles: snapshot.configuredBotRoles,
  });
  const matrixAccounts = { ...currentCfg.channels?.matrix?.accounts };
  for (const accountId of Object.values(MATRIX_QA_BOT_SOURCE_ACCOUNT_IDS)) {
    delete matrixAccounts[accountId];
  }
  const approvals = { ...currentCfg.approvals };
  for (const kind of ["exec", "plugin"] as const) {
    const approval = restoreOwnedFields(
      currentCfg.approvals?.[kind],
      baselineCfg.approvals?.[kind],
      ["enabled", "mode"],
    );
    if (snapshot.approvalForwarding[kind]) {
      Object.assign(approval, { enabled: true, mode: "session" });
    }
    if (Object.keys(approval).length > 0) {
      approvals[kind] = approval;
    } else {
      delete approvals[kind];
    }
  }
  const agentDefaults = restoreOwnedFields(
    currentCfg.agents?.defaults,
    baselineCfg.agents?.defaults,
    ["blockStreamingChunk", "blockStreamingCoalesce"],
  );
  Object.assign(agentDefaults, params.overrides?.agentDefaults);
  const tools = restoreOwnedFields(currentCfg.tools, baselineCfg.tools, ["profile"]);
  const media = restoreOwnedFields(currentCfg.tools?.media, baselineCfg.tools?.media, ["models"]);
  const audio = restoreOwnedFields(
    currentCfg.tools?.media?.audio,
    baselineCfg.tools?.media?.audio,
    "providerOptions baseUrl headers request enabled preferredModel maxBytes maxChars prompt timeoutSeconds language attachments echoTranscript echoFormat".split(
      " ",
    ),
  );
  const audioScope = restoreOwnedFields(
    currentCfg.tools?.media?.audio?.scope,
    baselineCfg.tools?.media?.audio?.scope,
    ["default", "rules"],
  );
  if (params.overrides?.toolProfile) {
    tools.profile = params.overrides.toolProfile;
  }
  if (params.overrides?.audio) {
    Object.assign(audio, params.overrides.audio);
  }
  if (params.overrides?.audio?.scope) {
    Object.assign(audioScope, params.overrides.audio.scope);
  }
  if (Object.keys(audioScope).length > 0) {
    audio.scope = audioScope;
  } else {
    delete audio.scope;
  }
  if (params.overrides?.mediaModels) {
    media.models = params.overrides.mediaModels;
  }
  if (
    currentCfg.tools?.media?.audio ||
    baselineCfg.tools?.media?.audio ||
    params.overrides?.audio
  ) {
    media.audio = audio;
  }
  if (
    currentCfg.tools?.media ||
    baselineCfg.tools?.media ||
    params.overrides?.audio ||
    params.overrides?.mediaModels
  ) {
    tools.media = media;
  }
  const groupChat = restoreOwnedFields(
    currentCfg.messages?.groupChat,
    baselineCfg.messages?.groupChat,
    ["mentionPatterns", "visibleReplies"],
  );
  if (params.overrides?.groupMentionPatterns !== undefined) {
    groupChat.mentionPatterns = snapshot.groupMentionPatterns;
  }
  groupChat.visibleReplies = "automatic";
  matrixAccounts[params.sutAccountId] = buildMatrixQaChannelAccountConfig({
    baselineAccount,
    currentAccount,
    groups,
    homeserver: params.homeserver,
    overrides: params.overrides,
    snapshot,
    sutAccessToken: params.sutAccessToken,
    sutDeviceId: params.sutDeviceId,
    sutUserId: params.sutUserId,
  });
  Object.assign(matrixAccounts, configuredBotAccounts);

  const config = structuredClone(currentCfg);
  config.approvals = approvals as OpenClawConfig["approvals"];
  config.agents = {
    ...currentCfg.agents,
    defaults: agentDefaults as NonNullable<OpenClawConfig["agents"]>["defaults"],
  };
  config.tools = tools as OpenClawConfig["tools"];
  config.plugins = {
    ...currentCfg.plugins,
    allow: pluginAllow,
    entries: {
      ...currentCfg.plugins?.entries,
      matrix: { ...currentCfg.plugins?.entries?.matrix, enabled: true },
    },
  };
  config.messages = {
    ...currentCfg.messages,
    groupChat: groupChat as NonNullable<OpenClawConfig["messages"]>["groupChat"],
  };
  config.channels = {
    ...currentCfg.channels,
    matrix: {
      ...currentCfg.channels?.matrix,
      accounts: matrixAccounts,
      defaultAccount: params.sutAccountId,
      enabled: true,
    },
  };
  return config;
}
