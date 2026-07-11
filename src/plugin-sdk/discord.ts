/**
 * @deprecated Public SDK subpath has no bundled extension production imports.
 * Use generic channel SDK subpaths or plugin-local API barrels instead.
 */

import type {
  ChannelAccountSnapshot,
  ChannelGroupContext,
  ChannelStatusIssue,
} from "./channel-contract.js";
import type { ChannelPlugin } from "./channel-core.js";
import type { MessageReceipt } from "./channel-outbound.js";
import type { OpenClawConfig } from "./config-types.js";
import {
  createLazyFacadeObjectValue,
  loadBundledPluginPublicSurfaceModuleSync,
} from "./facade-loader.js";
import { getRuntimeConfig, getRuntimeConfigSnapshot } from "./runtime-config-snapshot.js";

/**
 * @deprecated Compatibility facade for the `openclaw/plugin-sdk/discord` subpath.
 * New channel plugins should use generic channel SDK subpaths.
 */
export type { ChannelMessageActionAdapter, ChannelMessageActionName } from "./channel-contract.js";
export type { ChannelPlugin } from "./channel-core.js";
export type { OpenClawConfig } from "./config-types.js";
export type { OpenClawPluginApi, PluginRuntime } from "./channel-plugin-common.js";

export {
  DEFAULT_ACCOUNT_ID,
  applyAccountNameToChannelSection,
  buildChannelConfigSchema,
  emptyPluginConfigSchema,
  getChatChannelMeta,
  migrateBaseNameToDefaultAccount,
  normalizeAccountId,
  PAIRING_APPROVED_MESSAGE,
} from "./channel-plugin-common.js";
export {
  buildComputedAccountStatusSnapshot,
  buildTokenChannelStatusSummary,
  projectCredentialSnapshotFields,
  resolveConfiguredFromCredentialStatuses,
} from "./channel-status.js";
export { DiscordConfigSchema } from "../config/zod-schema.providers-core.js";

/** Discord channel config shape for one account in OpenClaw config. */
export type DiscordAccountConfig = NonNullable<NonNullable<OpenClawConfig["channels"]>["discord"]>;

/** Component-message request accepted by the deprecated Discord SDK facade. */
export type DiscordComponentMessageSpec = {
  text?: string;
  reusable?: boolean;
  container?: {
    accentColor?: string | number;
    spoiler?: boolean;
  };
  blocks?: unknown[];
  modal?: unknown;
};

/** Built Discord component payload plus registration metadata. */
export type DiscordComponentBuildResult = {
  components: unknown[];
  entries: unknown[];
  modals: unknown[];
};

/** Send/edit options for Discord component messages. */
export type DiscordComponentSendOpts = {
  cfg: OpenClawConfig;
  accountId?: string;
  replyTo?: string;
  files?: unknown;
  mediaReadFile?: (filePath: string) => Promise<Buffer>;
  filename?: string;
  textLimit?: number;
  maxLinesPerMessage?: number;
  tableMode?: unknown;
  chunkMode?: unknown;
  [key: string]: unknown;
};

/** Normalized Discord message result returned by component send/edit helpers. */
export type DiscordComponentSendResult = {
  messageId: string;
  channelId: string;
  receipt: MessageReceipt;
};

/** Resolved Discord account with token source metadata for status and runtime checks. */
export type ResolvedDiscordAccount = {
  accountId: string;
  enabled: boolean;
  name?: string;
  token: string;
  tokenSource: "env" | "config" | "none";
  config: DiscordAccountConfig;
};

/** Normalized outbound target result for Discord channel ids and DM targets. */
export type DiscordOutboundTargetResolution =
  | { ok: true; to: string }
  | { ok: false; error: Error };

/** Supported thread binding owners for Discord session routing. */
export type ThreadBindingTargetKind = "subagent" | "acp";

/** Persisted Discord thread-to-session binding record. */
export type ThreadBindingRecord = {
  accountId: string;
  threadId: string;
  channelId?: string;
  targetKind: ThreadBindingTargetKind;
  targetSessionKey: string;
  [key: string]: unknown;
};

type DirectoryConfigParams = {
  cfg: OpenClawConfig;
  accountId?: string | null;
};

type BuildDiscordComponentMessage = (params: {
  spec: DiscordComponentMessageSpec;
  fallbackText?: string;
  sessionKey?: string;
  agentId?: string;
  accountId?: string;
}) => DiscordComponentBuildResult;

type EditDiscordComponentMessage = (
  to: string,
  messageId: string,
  spec: DiscordComponentMessageSpec,
  opts: DiscordComponentSendOpts,
) => Promise<DiscordComponentSendResult>;

type RegisterBuiltDiscordComponentMessage = (params: {
  buildResult: DiscordComponentBuildResult;
  messageId: string;
}) => void;

type DiscordApiFacadeModule = {
  collectDiscordStatusIssues: (accounts: ChannelAccountSnapshot[]) => ChannelStatusIssue[];
  buildDiscordComponentMessage: BuildDiscordComponentMessage;
  discordOnboardingAdapter?: NonNullable<ChannelPlugin<ResolvedDiscordAccount>["setup"]>;
  inspectDiscordAccount: (params: { cfg: OpenClawConfig; accountId?: string | null }) => unknown;
  listDiscordAccountIds: (cfg: OpenClawConfig) => string[];
  listDiscordDirectoryGroupsFromConfig: (
    params: DirectoryConfigParams,
  ) => unknown[] | Promise<unknown[]>;
  listDiscordDirectoryPeersFromConfig: (
    params: DirectoryConfigParams,
  ) => unknown[] | Promise<unknown[]>;
  looksLikeDiscordTargetId: (raw: string) => boolean;
  normalizeDiscordMessagingTarget: (raw: string) => string | undefined;
  normalizeDiscordOutboundTarget: (to?: string) => DiscordOutboundTargetResolution;
  resolveDefaultDiscordAccountId: (cfg: OpenClawConfig) => string;
  resolveDiscordAccount: (params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
  }) => ResolvedDiscordAccount;
  resolveDiscordGroupRequireMention: (params: ChannelGroupContext) => boolean | undefined;
  resolveDiscordGroupToolPolicy: (params: ChannelGroupContext) => unknown;
};

type DiscordRuntimeFacadeModule = {
  editDiscordComponentMessage: EditDiscordComponentMessage;
  registerBuiltDiscordComponentMessage: RegisterBuiltDiscordComponentMessage;
  autoBindSpawnedDiscordSubagent: (params: {
    cfg: OpenClawConfig;
    accountId?: string;
    channel?: string;
    to?: string;
    threadId?: string | number;
    childSessionKey: string;
    agentId: string;
    label?: string;
    boundBy?: string;
  }) => Promise<ThreadBindingRecord | null>;
  collectDiscordAuditChannelIds: (params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
  }) => unknown;
  listThreadBindingsBySessionKey: (params: {
    targetSessionKey: string;
    accountId?: string;
    targetKind?: ThreadBindingTargetKind;
  }) => ThreadBindingRecord[];
  unbindThreadBindingsBySessionKey: (params: {
    targetSessionKey: string;
    accountId?: string;
    targetKind?: ThreadBindingTargetKind;
    reason?: string;
    sendFarewell?: boolean;
    farewellText?: string;
  }) => ThreadBindingRecord[];
};

function loadDiscordApiFacadeModule(): DiscordApiFacadeModule {
  return loadBundledPluginPublicSurfaceModuleSync<DiscordApiFacadeModule>({
    dirName: "discord",
    artifactBasename: "api.js",
  });
}

function loadDiscordRuntimeFacadeModule(): DiscordRuntimeFacadeModule {
  return loadBundledPluginPublicSurfaceModuleSync<DiscordRuntimeFacadeModule>({
    dirName: "discord",
    artifactBasename: "runtime-api.js",
  });
}

function resolveCompatRuntimeConfig(params: { cfg?: OpenClawConfig }): OpenClawConfig {
  return params.cfg ?? getRuntimeConfigSnapshot() ?? getRuntimeConfig();
}

/** Lazy Discord setup adapter retained for deprecated subpath compatibility. */
export const discordOnboardingAdapter = createLazyFacadeObjectValue(
  () => loadDiscordApiFacadeModule().discordOnboardingAdapter ?? {},
);

/** Collect Discord account status issues from account snapshots. */
export function collectDiscordStatusIssues(
  accounts: ChannelAccountSnapshot[],
): ChannelStatusIssue[] {
  return loadDiscordApiFacadeModule().collectDiscordStatusIssues(accounts);
}

/** Build Discord component payloads without sending them. */
export const buildDiscordComponentMessage: DiscordApiFacadeModule["buildDiscordComponentMessage"] =
  ((...args) =>
    loadDiscordApiFacadeModule().buildDiscordComponentMessage(
      ...args,
    )) as DiscordApiFacadeModule["buildDiscordComponentMessage"];

/** Inspect one configured Discord account for setup/status output. */
export function inspectDiscordAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): unknown {
  return loadDiscordApiFacadeModule().inspectDiscordAccount(params);
}

/** List configured Discord account ids from OpenClaw config. */
export function listDiscordAccountIds(cfg: OpenClawConfig): string[] {
  return loadDiscordApiFacadeModule().listDiscordAccountIds(cfg);
}

/** List Discord directory group records from static config. */
export function listDiscordDirectoryGroupsFromConfig(
  params: DirectoryConfigParams,
): unknown[] | Promise<unknown[]> {
  return loadDiscordApiFacadeModule().listDiscordDirectoryGroupsFromConfig(params);
}

/** List Discord directory peer records from static config. */
export function listDiscordDirectoryPeersFromConfig(
  params: DirectoryConfigParams,
): unknown[] | Promise<unknown[]> {
  return loadDiscordApiFacadeModule().listDiscordDirectoryPeersFromConfig(params);
}

/** Check whether a raw value has Discord target-id shape. */
export function looksLikeDiscordTargetId(raw: string): boolean {
  return loadDiscordApiFacadeModule().looksLikeDiscordTargetId(raw);
}

/** Normalize a Discord messaging target for send helpers. */
export function normalizeDiscordMessagingTarget(raw: string): string | undefined {
  return loadDiscordApiFacadeModule().normalizeDiscordMessagingTarget(raw);
}

/** Normalize a Discord outbound target and return a typed error on failure. */
export function normalizeDiscordOutboundTarget(to?: string): DiscordOutboundTargetResolution {
  return loadDiscordApiFacadeModule().normalizeDiscordOutboundTarget(to);
}

/** Resolve the default Discord account id from config. */
export function resolveDefaultDiscordAccountId(cfg: OpenClawConfig): string {
  return loadDiscordApiFacadeModule().resolveDefaultDiscordAccountId(cfg);
}

/** Resolve a Discord account config plus token source for runtime use. */
export function resolveDiscordAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ResolvedDiscordAccount {
  return loadDiscordApiFacadeModule().resolveDiscordAccount(params);
}

/** Resolve group mention policy for a Discord channel context. */
export function resolveDiscordGroupRequireMention(
  params: ChannelGroupContext,
): boolean | undefined {
  return loadDiscordApiFacadeModule().resolveDiscordGroupRequireMention(params);
}

/** Resolve group tool policy for a Discord channel context. */
export function resolveDiscordGroupToolPolicy(params: ChannelGroupContext): unknown {
  return loadDiscordApiFacadeModule().resolveDiscordGroupToolPolicy(params);
}

/** Collect configured Discord audit channel ids for runtime status checks. */
export function collectDiscordAuditChannelIds(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): unknown {
  return loadDiscordRuntimeFacadeModule().collectDiscordAuditChannelIds(params);
}

/** Edit an already-sent Discord component message. */
export const editDiscordComponentMessage: DiscordRuntimeFacadeModule["editDiscordComponentMessage"] =
  ((...args) =>
    loadDiscordRuntimeFacadeModule().editDiscordComponentMessage(
      ...args,
    )) as DiscordRuntimeFacadeModule["editDiscordComponentMessage"];

/** Register a built component message after Discord assigns its message id. */
export const registerBuiltDiscordComponentMessage: DiscordRuntimeFacadeModule["registerBuiltDiscordComponentMessage"] =
  ((...args) =>
    loadDiscordRuntimeFacadeModule().registerBuiltDiscordComponentMessage(
      ...args,
    )) as DiscordRuntimeFacadeModule["registerBuiltDiscordComponentMessage"];

/** Bind a spawned subagent session to the current Discord thread when possible. */
export async function autoBindSpawnedDiscordSubagent(params: {
  cfg?: OpenClawConfig;
  accountId?: string;
  channel?: string;
  to?: string;
  threadId?: string | number;
  childSessionKey: string;
  agentId: string;
  label?: string;
  boundBy?: string;
}): Promise<ThreadBindingRecord | null> {
  return await loadDiscordRuntimeFacadeModule().autoBindSpawnedDiscordSubagent({
    ...params,
    cfg: resolveCompatRuntimeConfig(params),
  });
}

/** List Discord thread bindings for a target session key. */
export function listThreadBindingsBySessionKey(params: {
  targetSessionKey: string;
  accountId?: string;
  targetKind?: ThreadBindingTargetKind;
}): ThreadBindingRecord[] {
  return loadDiscordRuntimeFacadeModule().listThreadBindingsBySessionKey(params);
}

/** Remove Discord thread bindings for a target session key. */
export function unbindThreadBindingsBySessionKey(params: {
  targetSessionKey: string;
  accountId?: string;
  targetKind?: ThreadBindingTargetKind;
  reason?: string;
  sendFarewell?: boolean;
  farewellText?: string;
}): ThreadBindingRecord[] {
  return loadDiscordRuntimeFacadeModule().unbindThreadBindingsBySessionKey(params);
}
