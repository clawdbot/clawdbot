// Tier-eval config compatibility migration and its scoped traversal helpers.
import { ensureRecord, getRecord } from "../../../config/legacy.shared.js";

function deleteRetiredPath(owner: unknown, path: readonly string[], index = 0): boolean {
  const record = getRecord(owner);
  if (!record) {
    return false;
  }
  const key = path[index];
  if (!key) {
    return false;
  }
  if (key === "*") {
    let changed = false;
    for (const value of Object.values(record)) {
      changed = deleteRetiredPath(value, path, index + 1) || changed;
    }
    return changed;
  }
  if (index === path.length - 1) {
    if (!Object.hasOwn(record, key)) {
      return false;
    }
    delete record[key];
    return true;
  }
  const child = getRecord(record[key]);
  if (!child || !deleteRetiredPath(child, path, index + 1)) {
    return false;
  }
  if (Object.keys(child).length === 0) {
    delete record[key];
  }
  return true;
}

function visitChannelEntries(
  raw: Record<string, unknown>,
  channelId: string,
  visitor: (entry: Record<string, unknown>, path: string) => void,
): void {
  const channel = getRecord(getRecord(raw.channels)?.[channelId]);
  if (!channel) {
    return;
  }
  visitor(channel, `channels.${channelId}`);
  const accounts = getRecord(channel.accounts);
  if (!accounts) {
    return;
  }
  for (const [accountId, value] of Object.entries(accounts)) {
    const account = getRecord(value);
    if (account) {
      visitor(account, `channels.${channelId}.accounts.${accountId}`);
    }
  }
}

function moveKey(
  owner: Record<string, unknown> | null | undefined,
  legacyKey: string,
  canonicalKey: string,
  path: string,
  changes: string[],
): void {
  if (!owner || !Object.hasOwn(owner, legacyKey)) {
    return;
  }
  if (owner[canonicalKey] === undefined) {
    owner[canonicalKey] = owner[legacyKey];
    changes.push(`Moved ${path}.${legacyKey} → ${path}.${canonicalKey}.`);
  } else {
    changes.push(`Removed ${path}.${legacyKey} (${path}.${canonicalKey} already set).`);
  }
  delete owner[legacyKey];
}

const TIER_EVAL_RETIRED_ROOT_PATHS = [
  ["cloudWorkers", "profiles", "*", "lifetime"],
  ["meta", "lastTouchedAt"],
  ["hooks", "internal", "installs"],
  ["cron", "store"],
  ["plugins", "bundledDiscovery"],
  ["tts", "prefsPath"],
  ["logging", "redactSensitive"],
  ["commands", "useAccessGroups"],
  ["gateway", "controlUi", "allowInsecureAuth"],
  ["gateway", "controlUi", "dangerouslyDisableDeviceAuth"],
  ["memory", "qmd", "mcporter"],
  ["memory", "qmd", "update"],
  ["memory", "search", "remote", "nonBatchConcurrency"],
  ["memory", "search", "remote", "batch", "wait"],
  ["memory", "search", "remote", "batch", "concurrency"],
  ["memory", "search", "remote", "batch", "pollIntervalMs"],
  ["memory", "search", "remote", "batch", "timeoutMinutes"],
  ["memory", "search", "local", "contextSize"],
  ["memory", "search", "local", "modelCacheDir"],
  ["memory", "search", "store", "driver"],
  ["memory", "search", "sync"],
  ["memory", "search", "query", "hybrid"],
] as const;

const TIER_EVAL_RETIRED_AGENT_PATHS = [
  ["groupChat", "visibleReplies"],
  ["memory", "search", "remote", "nonBatchConcurrency"],
  ["memory", "search", "remote", "batch", "wait"],
  ["memory", "search", "remote", "batch", "concurrency"],
  ["memory", "search", "remote", "batch", "pollIntervalMs"],
  ["memory", "search", "remote", "batch", "timeoutMinutes"],
  ["memory", "search", "local", "contextSize"],
  ["memory", "search", "local", "modelCacheDir"],
  ["memory", "search", "store", "driver"],
  ["memory", "search", "sync"],
  ["memory", "search", "query", "hybrid"],
  ["heartbeat", "ackMaxChars"],
  ["heartbeat", "includeReasoning"],
  ["heartbeat", "includeSystemPromptSection"],
  ["heartbeat", "skipWhenBusy"],
  ["heartbeat", "suppressToolErrorWarnings"],
] as const;

function visitAgentConfigScopes(
  raw: Record<string, unknown>,
  visitor: (scope: Record<string, unknown>, path: string) => void,
): void {
  const agents = getRecord(raw.agents);
  const defaults = getRecord(agents?.defaults);
  if (defaults) {
    visitor(defaults, "agents.defaults");
  }
  const entries = getRecord(agents?.entries);
  if (entries) {
    for (const [agentId, value] of Object.entries(entries)) {
      const entry = getRecord(value);
      if (entry) {
        visitor(entry, `agents.entries.${agentId}`);
      }
    }
  }
  if (Array.isArray(agents?.list)) {
    agents.list.forEach((value, index) => {
      const entry = getRecord(value);
      if (entry) {
        visitor(entry, `agents.list[${index}]`);
      }
    });
  }
}

type LegacyExecPolicy = {
  security: "deny" | "allowlist" | "full";
  ask: "on-miss" | "always" | "off";
};

function resolveConfiguredExecPolicy(scope: Record<string, unknown>): LegacyExecPolicy | undefined {
  const exec = getRecord(getRecord(scope.tools)?.exec);
  if (!exec) {
    return undefined;
  }
  switch (exec.mode) {
    case "deny":
      return { security: "deny", ask: "off" };
    case "allowlist":
      return { security: "allowlist", ask: "off" };
    case "ask":
    case "auto":
      return { security: "allowlist", ask: "on-miss" };
    case "full":
      return { security: "full", ask: "off" };
  }
  const security =
    exec.security === "deny" || exec.security === "allowlist" || exec.security === "full"
      ? exec.security
      : undefined;
  const ask =
    exec.ask === "on-miss" || exec.ask === "always" || exec.ask === "off" ? exec.ask : undefined;
  return security && ask ? { security, ask } : undefined;
}

function migrateExecMode(
  scope: Record<string, unknown>,
  path: string,
  changes: string[],
  inheritedPolicy?: LegacyExecPolicy,
): void {
  const exec = getRecord(getRecord(scope.tools)?.exec);
  if (!exec || (!Object.hasOwn(exec, "security") && !Object.hasOwn(exec, "ask"))) {
    return;
  }
  if (exec.mode !== undefined) {
    changes.push(`Removed ${path}.tools.exec.security/ask (${path}.tools.exec.mode already set).`);
    delete exec.security;
    delete exec.ask;
    return;
  }
  const securityValid =
    exec.security === "deny" || exec.security === "allowlist" || exec.security === "full";
  const askValid = exec.ask === "on-miss" || exec.ask === "always" || exec.ask === "off";
  if (
    (Object.hasOwn(exec, "security") && !securityValid) ||
    (Object.hasOwn(exec, "ask") && !askValid)
  ) {
    return;
  }
  const security = securityValid ? exec.security : inheritedPolicy?.security;
  const ask = askValid ? exec.ask : inheritedPolicy?.ask;
  if (!security || !ask) {
    return;
  }
  if (ask === "always" || (security === "full" && ask === "on-miss")) {
    return;
  }
  exec.mode =
    security === "deny"
      ? "deny"
      : security === "allowlist" && ask === "off"
        ? "allowlist"
        : security === "full"
          ? "full"
          : "ask";
  changes.push(`Moved ${path}.tools.exec.security/ask → ${path}.tools.exec.mode.`);
  delete exec.security;
  delete exec.ask;
}

function migrateCliBackendSessionArgs(
  scope: Record<string, unknown>,
  path: string,
  changes: string[],
): void {
  const backends = getRecord(scope.cliBackends);
  if (!backends) {
    return;
  }
  for (const [backendId, value] of Object.entries(backends)) {
    const backend = getRecord(value);
    if (!backend || !Object.hasOwn(backend, "sessionArg")) {
      continue;
    }
    if (backend.sessionArgs === undefined && typeof backend.sessionArg === "string") {
      backend.sessionArgs = [backend.sessionArg, "{sessionId}"];
      changes.push(
        `Moved ${path}.cliBackends.${backendId}.sessionArg → ${path}.cliBackends.${backendId}.sessionArgs.`,
      );
    } else {
      changes.push(
        `Removed ${path}.cliBackends.${backendId}.sessionArg (sessionArgs already set).`,
      );
    }
    delete backend.sessionArg;
  }
}

function moveMcpWorkingDirectory(raw: Record<string, unknown>, changes: string[]): void {
  for (const [ownerPath, servers] of [
    ["mcp.servers", getRecord(getRecord(raw.mcp)?.servers)],
    ["nodeHost.mcp.servers", getRecord(getRecord(getRecord(raw.nodeHost)?.mcp)?.servers)],
  ] as const) {
    if (!servers) {
      continue;
    }
    for (const [serverId, value] of Object.entries(servers)) {
      moveKey(getRecord(value), "workingDirectory", "cwd", `${ownerPath}.${serverId}`, changes);
    }
  }
}

function migrateSignalEndpoint(
  entry: Record<string, unknown>,
  path: string,
  changes: string[],
  inherited?: { httpUrl?: unknown; httpHost?: unknown; httpPort?: unknown },
): void {
  if (!Object.hasOwn(entry, "httpHost") && !Object.hasOwn(entry, "httpPort")) {
    return;
  }
  if (entry.httpUrl === undefined && typeof inherited?.httpUrl === "string") {
    delete entry.httpHost;
    delete entry.httpPort;
    changes.push(`Removed ${path}.httpHost/httpPort (inherited httpUrl already set).`);
    return;
  }
  if (entry.httpUrl === undefined) {
    const rawHost =
      typeof (entry.httpHost ?? inherited?.httpHost) === "string" &&
      String(entry.httpHost ?? inherited?.httpHost).trim()
        ? String(entry.httpHost ?? inherited?.httpHost).trim()
        : "127.0.0.1";
    const host = rawHost.includes(":") && !rawHost.startsWith("[") ? `[${rawHost}]` : rawHost;
    const effectivePort = entry.httpPort ?? inherited?.httpPort;
    const port = typeof effectivePort === "number" ? effectivePort : 8080;
    entry.httpUrl = `http://${host}:${port}`;
    if (entry.autoStart === undefined) {
      // Legacy host/port described the locally owned daemon bind, unlike an
      // explicit httpUrl that points at an external service.
      entry.autoStart = true;
    }
    changes.push(`Moved ${path}.httpHost/httpPort → ${path}.httpUrl.`);
  } else {
    changes.push(`Removed ${path}.httpHost/httpPort (${path}.httpUrl already set).`);
  }
  delete entry.httpHost;
  delete entry.httpPort;
}

function migrateChannelAliases(raw: Record<string, unknown>, changes: string[]): void {
  const signal = getRecord(getRecord(raw.channels)?.signal);
  if (signal) {
    const inherited = {
      httpUrl: signal.httpUrl,
      httpHost: signal.httpHost,
      httpPort: signal.httpPort,
    };
    migrateSignalEndpoint(signal, "channels.signal", changes);
    const accounts = getRecord(signal.accounts);
    if (accounts) {
      for (const [accountId, value] of Object.entries(accounts)) {
        const account = getRecord(value);
        if (account) {
          migrateSignalEndpoint(
            account,
            `channels.signal.accounts.${accountId}`,
            changes,
            inherited,
          );
        }
      }
    }
  }
  visitChannelEntries(raw, "googlechat", (entry, path) => {
    if (!Object.hasOwn(entry, "serviceAccountRef")) {
      return;
    }
    if (entry.serviceAccount !== undefined) {
      changes.push(
        `Moved ${path}.serviceAccountRef → ${path}.serviceAccount (SecretRef precedence preserved).`,
      );
      entry.serviceAccount = entry.serviceAccountRef;
      delete entry.serviceAccountRef;
      return;
    }
    entry.serviceAccount = entry.serviceAccountRef;
    delete entry.serviceAccountRef;
    changes.push(`Moved ${path}.serviceAccountRef → ${path}.serviceAccount.`);
  });
}

const RESPONSE_PREFIX_CHANNELS = new Set([
  "discord",
  "feishu",
  "googlechat",
  "imessage",
  "irc",
  "matrix",
  "mattermost",
  "msteams",
  "nextcloud-talk",
  "signal",
  "slack",
  "telegram",
  "tlon",
  "twitch",
  "whatsapp",
  "zalo",
  "zalouser",
  "line",
]);

function migrateMessagesResponsePrefix(raw: Record<string, unknown>, changes: string[]): void {
  const messages = getRecord(raw.messages);
  if (!messages || !Object.hasOwn(messages, "responsePrefix")) {
    return;
  }
  const channels = getRecord(raw.channels);
  const configuredChannels = channels
    ? Object.entries(channels).filter(
        (entry): entry is [string, Record<string, unknown>] =>
          entry[0] !== "defaults" && Boolean(getRecord(entry[1])),
      )
    : [];
  const supported = configuredChannels.filter(([channelId]) =>
    RESPONSE_PREFIX_CHANNELS.has(channelId),
  );
  const unsupported = configuredChannels
    .map(([channelId]) => channelId)
    .filter((channelId) => !RESPONSE_PREFIX_CHANNELS.has(channelId));
  let copied = false;
  for (const [, channel] of supported) {
    if (channel.responsePrefix === undefined) {
      channel.responsePrefix = messages.responsePrefix;
      copied = true;
    }
  }
  if (copied) {
    changes.push(
      `Copied messages.responsePrefix to supported channel blocks while retaining the implicit/custom fallback${unsupported.length > 0 ? ` for: ${unsupported.join(", ")}` : ""}.`,
    );
  }
}

function migratePresenceEnabled(raw: Record<string, unknown>, changes: string[]): boolean {
  let changed = false;
  const wideArea = getRecord(getRecord(raw.discovery)?.wideArea);
  if (wideArea && Object.hasOwn(wideArea, "enabled")) {
    if (
      wideArea.enabled === false &&
      typeof wideArea.domain === "string" &&
      wideArea.domain.trim()
    ) {
      delete wideArea.enabled;
      delete wideArea.domain;
      changes.push(
        "Removed disabled discovery.wideArea activation fields; domain presence now enables wide-area discovery.",
      );
      changed = true;
    } else {
      delete wideArea.enabled;
      changed = true;
    }
  }
  return changed;
}

function migrateWebEnabled(raw: Record<string, unknown>, changes: string[]): boolean {
  const web = getRecord(raw.web);
  if (!web) {
    return false;
  }
  if (Object.hasOwn(web, "enabled")) {
    const whatsapp = ensureRecord(ensureRecord(raw, "channels"), "whatsapp");
    if (web.enabled === false && whatsapp.enabled === true) {
      changes.push("Removed web.enabled=false (channels.whatsapp.enabled already set).");
    }
    if (whatsapp.enabled === undefined) {
      whatsapp.enabled = web.enabled;
      changes.push("Moved web.enabled → channels.whatsapp.enabled.");
    }
  }
  delete raw.web;
  return true;
}

function stripPromptsFromTtsConfig(ttsValue: unknown, path: string, changes: string[]): void {
  const tts = getRecord(ttsValue);
  const personas = getRecord(tts?.personas);
  if (personas) {
    for (const [personaId, personaValue] of Object.entries(personas)) {
      const persona = getRecord(personaValue);
      if (persona && Object.hasOwn(persona, "prompt")) {
        delete persona.prompt;
        changes.push(
          `Removed ${path}.personas.${personaId}.prompt; move custom shaping into a speech provider prepareSynthesis implementation.`,
        );
      }
    }
  }
}

function stripTtsPersonaPrompts(raw: Record<string, unknown>, changes: string[]): void {
  stripPromptsFromTtsConfig(raw.tts, "tts", changes);
  visitAgentConfigScopes(raw, (scope, path) => {
    stripPromptsFromTtsConfig(scope.tts, `${path}.tts`, changes);
  });
  const channels = getRecord(raw.channels);
  if (!channels) {
    return;
  }
  for (const [channelId, channelValue] of Object.entries(channels)) {
    const channel = getRecord(channelValue);
    if (!channel) {
      continue;
    }
    const stripEntry = (entry: Record<string, unknown>, path: string) => {
      stripPromptsFromTtsConfig(entry.tts, `${path}.tts`, changes);
      stripPromptsFromTtsConfig(getRecord(entry.voice)?.tts, `${path}.voice.tts`, changes);
    };
    stripEntry(channel, `channels.${channelId}`);
    const accounts = getRecord(channel.accounts);
    if (accounts) {
      for (const [accountId, accountValue] of Object.entries(accounts)) {
        const account = getRecord(accountValue);
        if (account) {
          stripEntry(account, `channels.${channelId}.accounts.${accountId}`);
        }
      }
    }
  }
}

function stripCompactionInstructionConfig(
  scope: Record<string, unknown>,
  path: string,
  changes: string[],
): void {
  const compaction = getRecord(scope.compaction);
  if (!compaction) {
    return;
  }
  let stripped = false;
  for (const key of ["customInstructions", "identifierInstructions"]) {
    if (Object.hasOwn(compaction, key)) {
      delete compaction[key];
      stripped = true;
    }
  }
  const memoryFlush = getRecord(compaction.memoryFlush);
  if (memoryFlush) {
    for (const key of ["prompt", "systemPrompt"]) {
      if (Object.hasOwn(memoryFlush, key)) {
        delete memoryFlush[key];
        stripped = true;
      }
    }
  }
  if (compaction.identifierPolicy === "custom") {
    compaction.identifierPolicy = "strict";
    stripped = true;
  }
  if (stripped) {
    changes.push(
      `Removed ${path}.compaction custom prompt instructions; use a compaction provider summarize() implementation and before_prompt_build hooks.`,
    );
  }
}

export function migrateTierEvalTranche(raw: Record<string, unknown>, changes: string[]): void {
  const initialChangeCount = changes.length;
  let stripped = false;
  stripTtsPersonaPrompts(raw, changes);
  stripped = migratePresenceEnabled(raw, changes) || stripped;
  moveMcpWorkingDirectory(raw, changes);
  migrateChannelAliases(raw, changes);
  const session = getRecord(raw.session);
  if (session && Object.hasOwn(session, "idleMinutes")) {
    const existingReset = getRecord(session.reset);
    const reset = existingReset ?? { mode: "idle" };
    if (reset.idleMinutes === undefined) {
      reset.idleMinutes = session.idleMinutes;
      session.reset = reset;
      changes.push("Moved session.idleMinutes → session.reset.idleMinutes.");
    }
    delete session.idleMinutes;
    stripped = true;
  }
  const inheritedExecPolicy = resolveConfiguredExecPolicy(raw);
  migrateExecMode(raw, "root", changes);
  visitAgentConfigScopes(raw, (scope, path) => {
    stripCompactionInstructionConfig(scope, path, changes);
    // Agent entries inherit exec policy directly from root tools.exec. The
    // agents.defaults schema has no tools.exec policy surface.
    if (path !== "agents.defaults") {
      migrateExecMode(scope, path, changes, inheritedExecPolicy);
    }
    migrateCliBackendSessionArgs(scope, path, changes);
    for (const retiredPath of TIER_EVAL_RETIRED_AGENT_PATHS) {
      stripped = deleteRetiredPath(scope, retiredPath) || stripped;
    }
  });
  stripped = migrateWebEnabled(raw, changes) || stripped;
  migrateMessagesResponsePrefix(raw, changes);
  for (const retiredPath of TIER_EVAL_RETIRED_ROOT_PATHS) {
    stripped = deleteRetiredPath(raw, retiredPath) || stripped;
  }
  const secrets = getRecord(raw.secrets);
  const providers = getRecord(secrets?.providers);
  if (providers) {
    for (const provider of Object.values(providers)) {
      const entry = getRecord(provider);
      if (entry) {
        stripped =
          Object.hasOwn(entry, "allowInsecurePath") ||
          Object.hasOwn(entry, "allowSymlinkCommand") ||
          stripped;
        delete entry.allowInsecurePath;
        delete entry.allowSymlinkCommand;
      }
    }
  }
  const installExec = getRecord(getRecord(getRecord(raw.security)?.installPolicy)?.exec);
  if (installExec) {
    stripped =
      Object.hasOwn(installExec, "allowInsecurePath") ||
      Object.hasOwn(installExec, "allowSymlinkCommand") ||
      stripped;
    delete installExec.allowInsecurePath;
    delete installExec.allowSymlinkCommand;
  }
  if (stripped || changes.length > initialChangeCount) {
    changes.push(
      "Applied tier-eval tranche retirements; canonical settings and built-in defaults now apply.",
    );
  }
}
