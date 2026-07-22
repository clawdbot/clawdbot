import type { ConfigUiHints } from "../shared/config-ui-hints-types.js";
import { asSchemaObject } from "./schema.shared.js";

type JsonSchemaObject = Record<string, unknown> & {
  type?: string | string[];
  properties?: Record<string, JsonSchemaObject>;
  additionalProperties?: JsonSchemaObject | boolean;
  items?: JsonSchemaObject | JsonSchemaObject[];
  anyOf?: JsonSchemaObject[];
  oneOf?: JsonSchemaObject[];
  allOf?: JsonSchemaObject[];
};

const ROOT_TIER_PATHS = `
accessGroups acp agents approvals attachments auth bindings broadcast browser channels
cloudWorkers commands cron diagnostics discovery env gateway hooks logging mcp memory messages
meta models nodeHost plugins proxy secrets security session skills surfaces talk tools transcripts
tts ui update wizard
`
  .trim()
  .split(/\s+/);

// Curated from the common-settings seed. Broad containers stay listed only
// when their user-facing children are uniformly common; operational tuning
// beneath those containers is restored to advanced while tiers are resolved.
const COMMON_TIER_PATHS = `
bindings commands messages session
acp.allowedAgents
agents.defaults.elevatedDefault agents.defaults.embeddedAgent.projectSettingsPolicy
agents.defaults.fastModeDefault agents.defaults.heartbeat.accountId
agents.defaults.heartbeat.activeHours agents.defaults.heartbeat.directPolicy
agents.defaults.heartbeat.model agents.defaults.heartbeat.target agents.defaults.heartbeat.to
agents.defaults.compaction.memoryFlush.model agents.defaults.compaction.model
agents.defaults.imageModel.primary agents.defaults.model
agents.defaults.mediaModels agents.defaults.model.primary agents.defaults.modelPolicy.allow
agents.defaults.pdfModel.primary agents.defaults.sandbox.browser.enabled
agents.defaults.sandbox.docker.network agents.defaults.sandbox.mode
agents.defaults.sandbox.sessionToolsVisibility agents.defaults.sandbox.workspaceAccess
agents.defaults.skills agents.defaults.subagents.allowAgents agents.defaults.subagents.requireAgentId
agents.defaults.subagents.model agents.defaults.subagents.model.primary
agents.defaults.sandbox.ssh.workspaceRoot
agents.defaults.sandbox.workspaceRoot
agents.defaults.thinkingDefault agents.defaults.userTimezone agents.defaults.voiceModel.primary
agents.defaults.workspace agents.entries.*.default agents.entries.*.groupChat.mentionPatterns
agents.entries.*.groupChat.unmentionedInbound agents.entries.*.identity
agents.entries.*.memory.search.enabled agents.entries.*.memory.search.provider
agents.entries.*.memory.search.rememberAcrossConversations agents.entries.*.memory.search.model
agents.entries.*.memory.search.remote.apiKey agents.entries.*.heartbeat.model
agents.entries.*.model agents.entries.*.model.primary agents.entries.*.name
agents.entries.*.runtime.acp.agent agents.entries.*.runtime.type
agents.entries.*.sandbox.ssh.workspaceRoot agents.entries.*.sandbox.workspaceRoot
agents.entries.*.subagents.model agents.entries.*.subagents.model.primary agents.entries.*.workspace
agents.entries.*.tools.allow agents.entries.*.tools.alsoAllow agents.entries.*.tools.byProvider
agents.entries.*.tools.deny agents.entries.*.tools.elevated
agents.entries.*.tools.exec.applyPatch.workspaceOnly agents.entries.*.tools.exec.host
agents.entries.*.tools.exec.mode agents.entries.*.tools.exec.strictInlineEval
agents.entries.*.tools.exec.reviewer.model agents.entries.*.tools.exec.reviewer.model.primary
agents.entries.*.tools.fs.workspaceOnly agents.entries.*.tools.message
agents.entries.*.tools.profile agents.entries.*.tools.sandbox.tools
agents.entries.*.tools.toolsBySender agents.entries.*.tts.auto
agents.entries.*.tts.modelOverrides agents.entries.*.tts.persona
agents.entries.*.tts.personas.*.providers.*.apiKey agents.entries.*.tts.provider
agents.entries.*.tts.providers.*.apiKey
auth.profiles.*.mode auth.profiles.*.provider
browser.allowSystemProfileImport browser.defaultProfile browser.enabled browser.evaluateEnabled
browser.ssrfPolicy.allowedHostnames browser.ssrfPolicy.dangerouslyAllowPrivateNetwork
channels.*.allowFrom channels.*.contextVisibility channels.*.dmPolicy channels.*.enabled
channels.*.groupAllowFrom channels.*.groupPolicy channels.*.requireMention
channels.*.accessToken channels.*.apiKey channels.*.appPassword channels.*.appToken
channels.*.botToken channels.*.clientSecret channels.*.dmAllowlist channels.*.model
channels.*.password channels.*.port channels.*.refreshToken channels.*.secret
channels.*.token channels.*.webhookSecret channels.*.workspace
channels.*.accounts.*.allowFrom channels.*.accounts.*.dmPolicy channels.*.accounts.*.enabled
channels.*.accounts.*.groupAllowFrom channels.*.accounts.*.groupPolicy
channels.*.accounts.*.requireMention channels.*.accounts.*.accessToken
channels.*.accounts.*.apiKey channels.*.accounts.*.appPassword
channels.*.accounts.*.appToken channels.*.accounts.*.botToken
channels.*.accounts.*.clientSecret channels.*.accounts.*.dmAllowlist
channels.*.accounts.*.model channels.*.accounts.*.password channels.*.accounts.*.port
channels.*.accounts.*.refreshToken channels.*.accounts.*.secret channels.*.accounts.*.token
channels.*.accounts.*.webhookSecret channels.*.accounts.*.workspace
channels.defaults.contextVisibility
channels.clickclack.accounts.*.discussions.workspace channels.clickclack.discussions.workspace
channels.defaults.groupPolicy channels.discord.dm.enabled channels.discord.guilds.*.channels.*.enabled
channels.discord.guilds.*.channels.*.requireMention channels.discord.guilds.*.channels.*.roles
channels.discord.guilds.*.channels.*.users channels.discord.guilds.*.requireMention
channels.discord.guilds.*.roles channels.discord.guilds.*.users channels.discord.token
channels.discord.voice.allowedChannels channels.discord.voice.realtime.toolPolicy
channels.discord.activities.clientSecret channels.discord.pluralkit.token
channels.discord.voice.model channels.discord.voice.realtime.model
channels.discord.voice.tts.personas.*.providers.*.apiKey
channels.discord.voice.tts.providers.*.apiKey
channels.discord.accounts.*.activities.clientSecret channels.discord.accounts.*.pluralkit.token
channels.discord.accounts.*.voice.model channels.discord.accounts.*.voice.realtime.model
channels.discord.accounts.*.voice.tts.personas.*.providers.*.apiKey
channels.discord.accounts.*.voice.tts.providers.*.apiKey
channels.googlechat.audience channels.googlechat.audienceType channels.googlechat.dm.enabled
channels.googlechat.groups.*.enabled channels.googlechat.groups.*.users
channels.googlechat.requireMention channels.googlechat.serviceAccount
channels.googlechat.serviceAccountFile channels.googlechat.accounts.*.serviceAccount
channels.imessage.attachmentRoots channels.imessage.cliPath
channels.imessage.groups.*.requireMention channels.imessage.remoteAttachmentRoots
channels.imessage.service channels.irc.channels channels.irc.groups.*.allowFrom
channels.irc.groups.*.enabled channels.irc.groups.*.requireMention channels.irc.host
channels.irc.nick channels.irc.nickserv.password channels.irc.password channels.irc.port
channels.irc.tls channels.irc.accounts.*.nickserv.password channels.irc.accounts.*.port
channels.msteams.appId channels.msteams.appPassword channels.msteams.requireMention
channels.msteams.tenantId channels.msteams.webhook.port channels.qqbot.stt.apiKey
channels.qqbot.stt.model channels.signal.account channels.signal.cliPath
channels.signal.groups.*.requireMention channels.slack.appToken channels.slack.botToken
channels.slack.channels.*.enabled channels.slack.channels.*.requireMention
channels.slack.channels.*.users channels.slack.dm.enabled channels.slack.relay.authToken
channels.slack.requireMention channels.slack.signingSecret channels.slack.userTokenReadOnly
channels.slack.accounts.*.relay.authToken channels.slack.accounts.*.signingSecret
channels.sms.accounts.*.authToken channels.sms.authToken
channels.telegram.botToken channels.telegram.direct.*.allowFrom channels.telegram.direct.*.dmPolicy
channels.telegram.direct.*.enabled channels.telegram.groups.*.allowFrom
channels.telegram.groups.*.enabled channels.telegram.groups.*.groupPolicy
channels.telegram.groups.*.requireMention channels.telegram.groups.*.topics.*.allowFrom
channels.telegram.groups.*.topics.*.enabled channels.telegram.groups.*.topics.*.groupPolicy
channels.telegram.groups.*.topics.*.requireMention channels.telegram.webhookSecret
channels.telegram.accounts.*.direct.*.dmPolicy
channels.telegram.accounts.*.direct.*.topics.*.groupPolicy
channels.telegram.accounts.*.groups.*.groupPolicy
channels.telegram.accounts.*.groups.*.topics.*.groupPolicy
channels.telegram.direct.*.topics.*.groupPolicy
channels.whatsapp.groups.*.requireMention channels.whatsapp.selfChatMode
cron.enabled env.vars gateway.auth.mode gateway.auth.password gateway.auth.token
gateway.auth.trustedProxy.allowUsers gateway.auth.trustedProxy.userHeader gateway.bind
gateway.controlUi.allowedOrigins gateway.http.endpoints.chatCompletions.images.urlAllowlist
gateway.http.endpoints.responses.files.urlAllowlist
gateway.http.endpoints.responses.images.urlAllowlist gateway.mode gateway.nodes.allowSkills
gateway.nodes.pairing.autoApproveCidrs gateway.nodes.pluginTools.enabled gateway.port
gateway.remote.password gateway.remote.sshTarget gateway.remote.tlsFingerprint
gateway.remote.token gateway.remote.transport gateway.remote.url gateway.tailscale.mode
gateway.trustedProxies hooks.allowedAgentIds hooks.enabled hooks.gmail.account hooks.gmail.label
hooks.gmail.pushToken hooks.gmail.subscription hooks.gmail.topic
hooks.gmail.model hooks.gmail.serve.port hooks.internal.entries.*.enabled
hooks.mappings.*.agentId hooks.mappings.*.model hooks.token
mcp.apps.enabled mcp.servers.*.args mcp.servers.*.auth mcp.servers.*.command
mcp.servers.*.cwd mcp.servers.*.enabled mcp.servers.*.env mcp.servers.*.headers
mcp.servers.*.oauth.authProfileId mcp.servers.*.transport mcp.servers.*.url
memory.qmd.scope.default memory.qmd.scope.rules.*.action memory.search.enabled
memory.search.model memory.search.provider memory.search.rememberAcrossConversations
memory.search.remote.apiKey
memory.search.sources models.providers.*.api models.providers.*.apiKey
models.providers.*.auth models.providers.*.baseUrl models.providers.*.models.*.id
models.providers.*.request.auth.token
nodeHost.browserProxy.allowProfiles nodeHost.mcp.servers.*.args
nodeHost.mcp.servers.*.command nodeHost.mcp.servers.*.env
nodeHost.mcp.servers.*.headers nodeHost.mcp.servers.*.transport
nodeHost.mcp.servers.*.url plugins.allow plugins.entries.*.apiKey
plugins.entries.*.config plugins.entries.*.enabled plugins.entries.*.env
plugins.slots.contextEngine plugins.slots.memory secrets.providers.*.command
secrets.providers.*.path secrets.providers.*.source skills.allowBundled
skills.entries.*.apiKey skills.entries.*.config skills.entries.*.enabled
skills.entries.*.env skills.install.allowUploadedArchives skills.install.nodeManager
skills.load.allowSymlinkTargets skills.load.extraDirs skills.workshop.approvalPolicy
skills.workshop.autonomous.enabled talk.provider talk.providers.*.apiKey
talk.realtime.brain talk.realtime.mode talk.realtime.provider
talk.realtime.model talk.realtime.providers.*.apiKey talk.realtime.speakerVoice talk.speechLocale
tools.agentToAgent tools.allow tools.alsoAllow tools.deny tools.elevated tools.exec
tools.fs tools.media.audio tools.media.image tools.media.video tools.message
tools.exec.reviewer.model.primary tools.media.models.*.model
tools.media.models.*.request.auth.token tools.profile tools.sessions
tools.toolsBySender tools.web transcripts.enabled
tts.auto tts.persona tts.personas.*.providers.*.apiKey tts.provider
tts.providers.* tts.providers.*.apiKey
ui.assistant.avatar ui.assistant.name ui.prefs.chatFollowUpMode
ui.prefs.chatPersistCommentary ui.prefs.chatSendShortcut ui.prefs.chatShowThinking
ui.prefs.chatShowToolCalls ui.prefs.locale ui.prefs.showAdvancedSettings
ui.prefs.textScale ui.prefs.theme ui.prefs.themeMode update.auto.enabled update.channel
wizard.accessMode wizard.appRecommendations
`
  .trim()
  .split(/\s+/);

const NUMERIC_COMMON_EXCEPTIONS = new Set(["ui.prefs.textScale"]);
const ADVANCED_TUNING_PATHS = new Set(["agents.defaults.heartbeat.every"]);
const CHANNEL_KERNEL_TIER_PREFIXES = ["channels.defaults", "channels.modelByChannel"] as const;

function isPluginOwnedChannelTierPath(path: string): boolean {
  if (!path.startsWith("channels.") || path === "channels") {
    return false;
  }
  return !CHANNEL_KERNEL_TIER_PREFIXES.some(
    (prefix) => path === prefix || path.startsWith(`${prefix}.`),
  );
}

function splitPath(path: string): string[] {
  return path
    .replace(/\[(\*|\d*)\]/g, (_match, segment: string) => `.${segment || "*"}`)
    .replace(/^\.+|\.+$/g, "")
    .split(".")
    .filter(Boolean);
}

function createTierMatcher(hints: ConfigUiHints): (path: string) => boolean | undefined {
  const exact = new Map<string, boolean>();
  const wildcardByLength = new Map<
    number,
    Array<{ parts: string[]; advanced: boolean; wildcardCount: number }>
  >();
  for (const [hintPath, hint] of Object.entries(hints)) {
    if (typeof hint.advanced !== "boolean") {
      continue;
    }
    const parts = splitPath(hintPath);
    const wildcardCount = parts.filter((part) => part === "*").length;
    if (wildcardCount === 0) {
      exact.set(parts.join("."), hint.advanced);
      continue;
    }
    const bucket = wildcardByLength.get(parts.length) ?? [];
    bucket.push({ parts, advanced: hint.advanced, wildcardCount });
    wildcardByLength.set(parts.length, bucket);
  }
  for (const bucket of wildcardByLength.values()) {
    bucket.sort((left, right) => left.wildcardCount - right.wildcardCount);
  }
  return (path) => {
    const parts = splitPath(path);
    const direct = exact.get(parts.join("."));
    if (direct !== undefined) {
      return direct;
    }
    for (const candidate of wildcardByLength.get(parts.length) ?? []) {
      if (candidate.parts.every((part, index) => part === "*" || part === parts[index])) {
        return candidate.advanced;
      }
    }
    return undefined;
  };
}

function isNumericSchema(schema: JsonSchemaObject): boolean {
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  return types.includes("number") || types.includes("integer");
}

function isNumericCommonException(path: string): boolean {
  return NUMERIC_COMMON_EXCEPTIONS.has(path) || splitPath(path).at(-1) === "port";
}

function resolveTier(params: { inheritedTier: boolean; ownTier: boolean | undefined }): boolean {
  if (params.ownTier !== undefined) {
    return params.ownTier;
  }
  return params.inheritedTier;
}

function mergeTierHint(hints: ConfigUiHints, path: string, advanced: boolean): void {
  const current = hints[path];
  hints[path] = current ? { ...current, advanced } : { advanced };
}

/** Add authored common/advanced tier boundaries to the base hint map. */
export function applyConfigTierHints(
  hints: ConfigUiHints,
  options?: { includePluginOwnedChannels?: boolean },
): ConfigUiHints {
  const next = { ...hints };
  for (const path of ROOT_TIER_PATHS) {
    mergeTierHint(next, path, true);
  }
  for (const path of COMMON_TIER_PATHS) {
    if (!options?.includePluginOwnedChannels && isPluginOwnedChannelTierPath(path)) {
      continue;
    }
    mergeTierHint(next, path, false);
  }
  for (const path of ADVANCED_TUNING_PATHS) {
    mergeTierHint(next, path, true);
  }
  return next;
}

function applyNumericTuningTierHints(
  schema: Record<string, unknown>,
  hints: ConfigUiHints,
): ConfigUiHints {
  const next = { ...hints };
  const authoredTier = createTierMatcher(hints);
  const visited = new WeakMap<object, Set<string>>();
  const visit = (value: unknown, path: string): void => {
    const node = asSchemaObject(value) as JsonSchemaObject | null;
    if (!node) {
      return;
    }
    const prior = visited.get(node);
    if (prior?.has(path)) {
      return;
    }
    if (prior) {
      prior.add(path);
    } else {
      visited.set(node, new Set([path]));
    }
    if (
      path &&
      isNumericSchema(node) &&
      !isNumericCommonException(path) &&
      authoredTier(path) === undefined
    ) {
      mergeTierHint(next, path, true);
    }
    for (const [key, child] of Object.entries(node.properties ?? {})) {
      visit(child, path ? `${path}.${key}` : key);
    }
    if (node.additionalProperties && typeof node.additionalProperties === "object") {
      visit(node.additionalProperties, path ? `${path}.*` : "*");
    }
    const items = Array.isArray(node.items) ? node.items : node.items ? [node.items] : [];
    for (const item of items) {
      visit(item, path ? `${path}.*` : "*");
    }
    for (const branches of [node.anyOf, node.oneOf, node.allOf]) {
      for (const branch of branches ?? []) {
        visit(branch, path);
      }
    }
  };
  visit(schema, "");
  return next;
}

/** Materialize the resolved tier on every schema path for RPC/UI consumers. */
export function applyResolvedConfigTierHints(
  schema: Record<string, unknown>,
  hints: ConfigUiHints,
): ConfigUiHints {
  const tierHints = applyNumericTuningTierHints(schema, hints);
  const next = { ...tierHints };
  const matchTier = createTierMatcher(tierHints);
  const visited = new WeakMap<object, Set<string>>();

  const visit = (value: unknown, path: string, inheritedTier: boolean): void => {
    const node = asSchemaObject(value) as JsonSchemaObject | null;
    if (!node) {
      return;
    }
    const previousPaths = visited.get(node);
    if (previousPaths?.has(path)) {
      return;
    }
    if (previousPaths) {
      previousPaths.add(path);
    } else {
      visited.set(node, new Set([path]));
    }
    const advanced = path
      ? resolveTier({
          inheritedTier,
          ownTier: matchTier(path),
        })
      : inheritedTier;
    if (path) {
      mergeTierHint(next, path, advanced);
    }
    for (const [key, child] of Object.entries(node.properties ?? {})) {
      visit(child, path ? `${path}.${key}` : key, advanced);
    }
    if (node.additionalProperties && typeof node.additionalProperties === "object") {
      visit(node.additionalProperties, path ? `${path}.*` : "*", advanced);
    }
    const items = Array.isArray(node.items) ? node.items : node.items ? [node.items] : [];
    for (const item of items) {
      visit(item, path ? `${path}.*` : "*", advanced);
    }
    for (const branches of [node.anyOf, node.oneOf, node.allOf]) {
      for (const branch of branches ?? []) {
        visit(branch, path, advanced);
      }
    }
  };

  visit(schema, "", true);
  return next;
}
