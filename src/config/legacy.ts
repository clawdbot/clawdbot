import type { LegacyConfigIssue } from "./types.js";

type LegacyConfigRule = {
  path: string[];
  message: string;
  match?: (value: unknown, root: Record<string, unknown>) => boolean;
};

type LegacyConfigMigration = {
  id: string;
  describe: string;
  apply: (raw: Record<string, unknown>, changes: string[]) => void;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

const getRecord = (value: unknown): Record<string, unknown> | null =>
  isRecord(value) ? value : null;

const ensureRecord = (
  root: Record<string, unknown>,
  key: string,
): Record<string, unknown> => {
  const existing = root[key];
  if (isRecord(existing)) return existing;
  const next: Record<string, unknown> = {};
  root[key] = next;
  return next;
};

const mergeMissing = (
  target: Record<string, unknown>,
  source: Record<string, unknown>,
) => {
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    const existing = target[key];
    if (existing === undefined) {
      target[key] = value;
      continue;
    }
    if (isRecord(existing) && isRecord(value)) {
      mergeMissing(existing, value);
    }
  }
};

const AUDIO_TRANSCRIPTION_CLI_ALLOWLIST = new Set(["whisper"]);

const mapLegacyAudioTranscription = (
  value: unknown,
): Record<string, unknown> | null => {
  const transcriber = getRecord(value);
  const command = Array.isArray(transcriber?.command)
    ? transcriber?.command
    : null;
  if (!command || command.length === 0) return null;
  const rawExecutable = String(command[0] ?? "").trim();
  if (!rawExecutable) return null;
  const executableName = rawExecutable.split(/[\\/]/).pop() ?? rawExecutable;
  if (!AUDIO_TRANSCRIPTION_CLI_ALLOWLIST.has(executableName)) return null;

  const args = command.slice(1).map((part) => String(part));
  const timeoutSeconds =
    typeof transcriber?.timeoutSeconds === "number"
      ? transcriber?.timeoutSeconds
      : undefined;

  const result: Record<string, unknown> = {};
  if (args.length > 0) result.args = args;
  if (timeoutSeconds !== undefined) result.timeoutSeconds = timeoutSeconds;
  return result;
};

const getAgentsList = (agents: Record<string, unknown> | null) => {
  const list = agents?.list;
  return Array.isArray(list) ? list : [];
};

const resolveDefaultAgentIdFromRaw = (raw: Record<string, unknown>) => {
  const agents = getRecord(raw.agents);
  const list = getAgentsList(agents);
  const defaultEntry = list.find(
    (entry): entry is { id: string } =>
      isRecord(entry) &&
      entry.default === true &&
      typeof entry.id === "string" &&
      entry.id.trim() !== "",
  );
  if (defaultEntry) return defaultEntry.id.trim();
  const routing = getRecord(raw.routing);
  const routingDefault =
    typeof routing?.defaultAgentId === "string"
      ? routing.defaultAgentId.trim()
      : "";
  if (routingDefault) return routingDefault;
  const firstEntry = list.find(
    (entry): entry is { id: string } =>
      isRecord(entry) && typeof entry.id === "string" && entry.id.trim() !== "",
  );
  if (firstEntry) return firstEntry.id.trim();
  return "main";
};

const ensureAgentEntry = (
  list: unknown[],
  id: string,
): Record<string, unknown> => {
  const normalized = id.trim();
  const existing = list.find(
    (entry): entry is Record<string, unknown> =>
      isRecord(entry) &&
      typeof entry.id === "string" &&
      entry.id.trim() === normalized,
  );
  if (existing) return existing;
  const created: Record<string, unknown> = { id: normalized };
  list.push(created);
  return created;
};

const LEGACY_CONFIG_RULES: LegacyConfigRule[] = [
  {
    path: ["whatsapp"],
    message:
      "whatsapp config moved to channels.whatsapp (auto-migrated on load).",
  },
  {
    path: ["telegram"],
    message:
      "telegram config moved to channels.telegram (auto-migrated on load).",
  },
  {
    path: ["discord"],
    message:
      "discord config moved to channels.discord (auto-migrated on load).",
  },
  {
    path: ["slack"],
    message: "slack config moved to channels.slack (auto-migrated on load).",
  },
  {
    path: ["signal"],
    message: "signal config moved to channels.signal (auto-migrated on load).",
  },
  {
    path: ["imessage"],
    message:
      "imessage config moved to channels.imessage (auto-migrated on load).",
  },
  {
    path: ["msteams"],
    message:
      "msteams config moved to channels.msteams (auto-migrated on load).",
  },
  {
    path: ["routing", "allowFrom"],
    message:
      "routing.allowFrom was removed; use channels.whatsapp.allowFrom instead (auto-migrated on load).",
  },
  {
    path: ["routing", "bindings"],
    message:
      "routing.bindings was moved; use top-level bindings instead (auto-migrated on load).",
  },
  {
    path: ["routing", "agents"],
    message:
      "routing.agents was moved; use agents.list instead (auto-migrated on load).",
  },
  {
    path: ["routing", "defaultAgentId"],
    message:
      "routing.defaultAgentId was moved; use agents.list[].default instead (auto-migrated on load).",
  },
  {
    path: ["routing", "agentToAgent"],
    message:
      "routing.agentToAgent was moved; use tools.agentToAgent instead (auto-migrated on load).",
  },
  {
    path: ["routing", "groupChat", "requireMention"],
    message:
      'routing.groupChat.requireMention was removed; use channels.whatsapp/telegram/imessage groups defaults (e.g. channels.whatsapp.groups."*".requireMention) instead (auto-migrated on load).',
  },
  {
    path: ["routing", "groupChat", "mentionPatterns"],
    message:
      "routing.groupChat.mentionPatterns was moved; use agents.list[].groupChat.mentionPatterns or messages.groupChat.mentionPatterns instead (auto-migrated on load).",
  },
  {
    path: ["routing", "queue"],
    message:
      "routing.queue was moved; use messages.queue instead (auto-migrated on load).",
  },
  {
    path: ["routing", "transcribeAudio"],
    message:
      "routing.transcribeAudio was moved; use tools.audio.transcription instead (auto-migrated on load).",
  },
  {
    path: ["telegram", "requireMention"],
    message:
      'telegram.requireMention was removed; use channels.telegram.groups."*".requireMention instead (auto-migrated on load).',
  },
  {
    path: ["identity"],
    message:
      "identity was moved; use agents.list[].identity instead (auto-migrated on load).",
  },
  {
    path: ["agent"],
    message:
      "agent.* was moved; use agents.defaults (and tools.* for tool/elevated/exec settings) instead (auto-migrated on load).",
  },
  {
    path: ["agent", "model"],
    message:
      "agent.model string was replaced by agents.defaults.model.primary/fallbacks and agents.defaults.models (auto-migrated on load).",
    match: (value) => typeof value === "string",
  },
  {
    path: ["agent", "imageModel"],
    message:
      "agent.imageModel string was replaced by agents.defaults.imageModel.primary/fallbacks (auto-migrated on load).",
    match: (value) => typeof value === "string",
  },
  {
    path: ["agent", "allowedModels"],
    message:
      "agent.allowedModels was replaced by agents.defaults.models (auto-migrated on load).",
  },
  {
    path: ["agent", "modelAliases"],
    message:
      "agent.modelAliases was replaced by agents.defaults.models.*.alias (auto-migrated on load).",
  },
  {
    path: ["agent", "modelFallbacks"],
    message:
      "agent.modelFallbacks was replaced by agents.defaults.model.fallbacks (auto-migrated on load).",
  },
  {
    path: ["agent", "imageModelFallbacks"],
    message:
      "agent.imageModelFallbacks was replaced by agents.defaults.imageModel.fallbacks (auto-migrated on load).",
  },
  {
    path: ["gateway", "token"],
    message:
      "gateway.token is ignored; use gateway.auth.token instead (auto-migrated on load).",
  },
];

const LEGACY_CONFIG_MIGRATIONS: LegacyConfigMigration[] = [
  {
    id: "bindings.match.provider->bindings.match.channel",
    describe: "Move bindings[].match.provider to bindings[].match.channel",
    apply: (raw, changes) => {
      const bindings = Array.isArray(raw.bindings) ? raw.bindings : null;
      if (!bindings) return;

      let touched = false;
      for (const entry of bindings) {
        if (!isRecord(entry)) continue;
        const match = getRecord(entry.match);
        if (!match) continue;
        if (typeof match.channel === "string" && match.channel.trim()) continue;
        const provider =
          typeof match.provider === "string" ? match.provider.trim() : "";
        if (!provider) continue;
        match.channel = provider;
        delete match.provider;
        entry.match = match;
        touched = true;
      }

      if (touched) {
        raw.bindings = bindings;
        changes.push(
          "Moved bindings[].match.provider → bindings[].match.channel.",
        );
      }
    },
  },
  {
    id: "session.sendPolicy.rules.match.provider->match.channel",
    describe: "Move session.sendPolicy.rules[].match.provider to match.channel",
    apply: (raw, changes) => {
      const session = getRecord(raw.session);
      if (!session) return;
      const sendPolicy = getRecord(session.sendPolicy);
      if (!sendPolicy) return;
      const rules = Array.isArray(sendPolicy.rules) ? sendPolicy.rules : null;
      if (!rules) return;

      let touched = false;
      for (const rule of rules) {
        if (!isRecord(rule)) continue;
        const match = getRecord(rule.match);
        if (!match) continue;
        if (typeof match.channel === "string" && match.channel.trim()) continue;
        const provider =
          typeof match.provider === "string" ? match.provider.trim() : "";
        if (!provider) continue;
        match.channel = provider;
        delete match.provider;
        rule.match = match;
        touched = true;
      }

      if (touched) {
        sendPolicy.rules = rules;
        session.sendPolicy = sendPolicy;
        raw.session = session;
        changes.push(
          "Moved session.sendPolicy.rules[].match.provider → match.channel.",
        );
      }
    },
  },
  {
    id: "messages.queue.byProvider->byChannel",
    describe: "Move messages.queue.byProvider to messages.queue.byChannel",
    apply: (raw, changes) => {
      const messages = getRecord(raw.messages);
      if (!messages) return;
      const queue = getRecord(messages.queue);
      if (!queue) return;
      if (queue.byProvider === undefined) return;
      if (queue.byChannel === undefined) {
        queue.byChannel = queue.byProvider;
        changes.push(
          "Moved messages.queue.byProvider → messages.queue.byChannel.",
        );
      } else {
        changes.push(
          "Removed messages.queue.byProvider (messages.queue.byChannel already set).",
        );
      }
      delete queue.byProvider;
      messages.queue = queue;
      raw.messages = messages;
    },
  },
  {
    id: "providers->channels",
    describe: "Move provider config sections to channels.*",
    apply: (raw, changes) => {
      const legacyKeys = [
        "whatsapp",
        "telegram",
        "discord",
        "slack",
        "signal",
        "imessage",
        "msteams",
      ];
      const legacyEntries = legacyKeys.filter((key) => isRecord(raw[key]));
      if (legacyEntries.length === 0) return;

      const channels = ensureRecord(raw, "channels");
      for (const key of legacyEntries) {
        const legacy = getRecord(raw[key]);
        if (!legacy) continue;
        const channelEntry = ensureRecord(channels, key);
        const hadEntries = Object.keys(channelEntry).length > 0;
        mergeMissing(channelEntry, legacy);
        channels[key] = channelEntry;
        delete raw[key];
        changes.push(
          hadEntries
            ? `Merged ${key} → channels.${key}.`
            : `Moved ${key} → channels.${key}.`,
        );
      }
      raw.channels = channels;
    },
  },
  {
    id: "routing.allowFrom->channels.whatsapp.allowFrom",
    describe: "Move routing.allowFrom to channels.whatsapp.allowFrom",
    apply: (raw, changes) => {
      const routing = raw.routing;
      if (!routing || typeof routing !== "object") return;
      const allowFrom = (routing as Record<string, unknown>).allowFrom;
      if (allowFrom === undefined) return;

      const channels = ensureRecord(raw, "channels");
      const whatsapp =
        channels.whatsapp && typeof channels.whatsapp === "object"
          ? (channels.whatsapp as Record<string, unknown>)
          : {};

      if (whatsapp.allowFrom === undefined) {
        whatsapp.allowFrom = allowFrom;
        changes.push("Moved routing.allowFrom → channels.whatsapp.allowFrom.");
      } else {
        changes.push(
          "Removed routing.allowFrom (channels.whatsapp.allowFrom already set).",
        );
      }

      delete (routing as Record<string, unknown>).allowFrom;
      if (Object.keys(routing as Record<string, unknown>).length === 0) {
        delete raw.routing;
      }
      channels.whatsapp = whatsapp;
      raw.channels = channels;
    },
  },
  {
    id: "routing.groupChat.requireMention->groups.*.requireMention",
    describe:
      "Move routing.groupChat.requireMention to channels.whatsapp/telegram/imessage groups",
    apply: (raw, changes) => {
      const routing = raw.routing;
      if (!routing || typeof routing !== "object") return;
      const groupChat =
        (routing as Record<string, unknown>).groupChat &&
        typeof (routing as Record<string, unknown>).groupChat === "object"
          ? ((routing as Record<string, unknown>).groupChat as Record<
              string,
              unknown
            >)
          : null;
      if (!groupChat) return;
      const requireMention = groupChat.requireMention;
      if (requireMention === undefined) return;

      const channels = ensureRecord(raw, "channels");
      const applyTo = (key: "whatsapp" | "telegram" | "imessage") => {
        const section =
          channels[key] && typeof channels[key] === "object"
            ? (channels[key] as Record<string, unknown>)
            : {};
        const groups =
          section.groups && typeof section.groups === "object"
            ? (section.groups as Record<string, unknown>)
            : {};
        const defaultKey = "*";
        const entry =
          groups[defaultKey] && typeof groups[defaultKey] === "object"
            ? (groups[defaultKey] as Record<string, unknown>)
            : {};
        if (entry.requireMention === undefined) {
          entry.requireMention = requireMention;
          groups[defaultKey] = entry;
          section.groups = groups;
          channels[key] = section;
          changes.push(
            `Moved routing.groupChat.requireMention → channels.${key}.groups."*".requireMention.`,
          );
        } else {
          changes.push(
            `Removed routing.groupChat.requireMention (channels.${key}.groups."*" already set).`,
          );
        }
      };

      applyTo("whatsapp");
      applyTo("telegram");
      applyTo("imessage");

      delete groupChat.requireMention;
      if (Object.keys(groupChat).length === 0) {
        delete (routing as Record<string, unknown>).groupChat;
      }
      if (Object.keys(routing as Record<string, unknown>).length === 0) {
        delete raw.routing;
      }
      raw.channels = channels;
    },
  },
  {
    id: "gateway.token->gateway.auth.token",
    describe: "Move gateway.token to gateway.auth.token",
    apply: (raw, changes) => {
      const gateway = raw.gateway;
      if (!gateway || typeof gateway !== "object") return;
      const token = (gateway as Record<string, unknown>).token;
      if (token === undefined) return;

      const gatewayObj = gateway as Record<string, unknown>;
      const auth =
        gatewayObj.auth && typeof gatewayObj.auth === "object"
          ? (gatewayObj.auth as Record<string, unknown>)
          : {};
      if (auth.token === undefined) {
        auth.token = token;
        if (!auth.mode) auth.mode = "token";
        changes.push("Moved gateway.token → gateway.auth.token.");
      } else {
        changes.push("Removed gateway.token (gateway.auth.token already set).");
      }
      delete gatewayObj.token;
      if (Object.keys(auth).length > 0) {
        gatewayObj.auth = auth;
      }
      raw.gateway = gatewayObj;
    },
  },
  {
    id: "telegram.requireMention->channels.telegram.groups.*.requireMention",
    describe:
      "Move telegram.requireMention to channels.telegram.groups.*.requireMention",
    apply: (raw, changes) => {
      const channels = ensureRecord(raw, "channels");
      const telegram = channels.telegram;
      if (!telegram || typeof telegram !== "object") return;
      const requireMention = (telegram as Record<string, unknown>)
        .requireMention;
      if (requireMention === undefined) return;

      const groups =
        (telegram as Record<string, unknown>).groups &&
        typeof (telegram as Record<string, unknown>).groups === "object"
          ? ((telegram as Record<string, unknown>).groups as Record<
              string,
              unknown
            >)
          : {};
      const defaultKey = "*";
      const entry =
        groups[defaultKey] && typeof groups[defaultKey] === "object"
          ? (groups[defaultKey] as Record<string, unknown>)
          : {};

      if (entry.requireMention === undefined) {
        entry.requireMention = requireMention;
        groups[defaultKey] = entry;
        (telegram as Record<string, unknown>).groups = groups;
        changes.push(
          'Moved telegram.requireMention → channels.telegram.groups."*".requireMention.',
        );
      } else {
        changes.push(
          'Removed telegram.requireMention (channels.telegram.groups."*" already set).',
        );
      }

      delete (telegram as Record<string, unknown>).requireMention;
      channels.telegram = telegram as Record<string, unknown>;
      raw.channels = channels;
    },
  },
  {
    id: "agent.model-config-v2",
    describe:
      "Migrate legacy agent.model/allowedModels/modelAliases/modelFallbacks/imageModelFallbacks to agent.models + model lists",
    apply: (raw, changes) => {
      const agentRoot = getRecord(raw.agent);
      const defaults = getRecord(getRecord(raw.agents)?.defaults);
      const agent = agentRoot ?? defaults;
      if (!agent) return;
      const label = agentRoot ? "agent" : "agents.defaults";

      const legacyModel =
        typeof agent.model === "string" ? String(agent.model) : undefined;
      const legacyImageModel =
        typeof agent.imageModel === "string"
          ? String(agent.imageModel)
          : undefined;
      const legacyAllowed = Array.isArray(agent.allowedModels)
        ? (agent.allowedModels as unknown[]).map(String)
        : [];
      const legacyModelFallbacks = Array.isArray(agent.modelFallbacks)
        ? (agent.modelFallbacks as unknown[]).map(String)
        : [];
      const legacyImageModelFallbacks = Array.isArray(agent.imageModelFallbacks)
        ? (agent.imageModelFallbacks as unknown[]).map(String)
        : [];
      const legacyAliases =
        agent.modelAliases && typeof agent.modelAliases === "object"
          ? (agent.modelAliases as Record<string, unknown>)
          : {};

      const hasLegacy =
        legacyModel ||
        legacyImageModel ||
        legacyAllowed.length > 0 ||
        legacyModelFallbacks.length > 0 ||
        legacyImageModelFallbacks.length > 0 ||
        Object.keys(legacyAliases).length > 0;
      if (!hasLegacy) return;

      const models =
        agent.models && typeof agent.models === "object"
          ? (agent.models as Record<string, unknown>)
          : {};

      const ensureModel = (rawKey?: string) => {
        if (typeof rawKey !== "string") return;
        const key = rawKey.trim();
        if (!key) return;
        if (!models[key]) models[key] = {};
      };

      ensureModel(legacyModel);
      ensureModel(legacyImageModel);
      for (const key of legacyAllowed) ensureModel(key);
      for (const key of legacyModelFallbacks) ensureModel(key);
      for (const key of legacyImageModelFallbacks) ensureModel(key);
      for (const target of Object.values(legacyAliases)) {
        if (typeof target !== "string") continue;
        ensureModel(target);
      }

      for (const [alias, targetRaw] of Object.entries(legacyAliases)) {
        if (typeof targetRaw !== "string") continue;
        const target = targetRaw.trim();
        if (!target) continue;
        const entry =
          models[target] && typeof models[target] === "object"
            ? (models[target] as Record<string, unknown>)
            : {};
        if (!("alias" in entry)) {
          entry.alias = alias;
          models[target] = entry;
        }
      }

      const currentModel =
        agent.model && typeof agent.model === "object"
          ? (agent.model as Record<string, unknown>)
          : null;
      if (currentModel) {
        if (!currentModel.primary && legacyModel) {
          currentModel.primary = legacyModel;
        }
        if (
          legacyModelFallbacks.length > 0 &&
          (!Array.isArray(currentModel.fallbacks) ||
            currentModel.fallbacks.length === 0)
        ) {
          currentModel.fallbacks = legacyModelFallbacks;
        }
        agent.model = currentModel;
      } else if (legacyModel || legacyModelFallbacks.length > 0) {
        agent.model = {
          primary: legacyModel,
          fallbacks: legacyModelFallbacks.length ? legacyModelFallbacks : [],
        };
      }

      const currentImageModel =
        agent.imageModel && typeof agent.imageModel === "object"
          ? (agent.imageModel as Record<string, unknown>)
          : null;
      if (currentImageModel) {
        if (!currentImageModel.primary && legacyImageModel) {
          currentImageModel.primary = legacyImageModel;
        }
        if (
          legacyImageModelFallbacks.length > 0 &&
          (!Array.isArray(currentImageModel.fallbacks) ||
            currentImageModel.fallbacks.length === 0)
        ) {
          currentImageModel.fallbacks = legacyImageModelFallbacks;
        }
        agent.imageModel = currentImageModel;
      } else if (legacyImageModel || legacyImageModelFallbacks.length > 0) {
        agent.imageModel = {
          primary: legacyImageModel,
          fallbacks: legacyImageModelFallbacks.length
            ? legacyImageModelFallbacks
            : [],
        };
      }

      agent.models = models;

      if (legacyModel !== undefined) {
        changes.push(
          `Migrated ${label}.model string → ${label}.model.primary.`,
        );
      }
      if (legacyModelFallbacks.length > 0) {
        changes.push(
          `Migrated ${label}.modelFallbacks → ${label}.model.fallbacks.`,
        );
      }
      if (legacyImageModel !== undefined) {
        changes.push(
          `Migrated ${label}.imageModel string → ${label}.imageModel.primary.`,
        );
      }
      if (legacyImageModelFallbacks.length > 0) {
        changes.push(
          `Migrated ${label}.imageModelFallbacks → ${label}.imageModel.fallbacks.`,
        );
      }
      if (legacyAllowed.length > 0) {
        changes.push(`Migrated ${label}.allowedModels → ${label}.models.`);
      }
      if (Object.keys(legacyAliases).length > 0) {
        changes.push(
          `Migrated ${label}.modelAliases → ${label}.models.*.alias.`,
        );
      }

      delete agent.allowedModels;
      delete agent.modelAliases;
      delete agent.modelFallbacks;
      delete agent.imageModelFallbacks;
    },
  },
  {
    id: "routing.agents-v2",
    describe: "Move routing.agents/defaultAgentId to agents.list",
    apply: (raw, changes) => {
      const routing = getRecord(raw.routing);
      if (!routing) return;

      const routingAgents = getRecord(routing.agents);
      const agents = ensureRecord(raw, "agents");
      const list = getAgentsList(agents);

      if (routingAgents) {
        for (const [rawId, entryRaw] of Object.entries(routingAgents)) {
          const agentId = String(rawId ?? "").trim();
          const entry = getRecord(entryRaw);
          if (!agentId || !entry) continue;

          const target = ensureAgentEntry(list, agentId);
          const entryCopy: Record<string, unknown> = { ...entry };

          if ("mentionPatterns" in entryCopy) {
            const mentionPatterns = entryCopy.mentionPatterns;
            const groupChat = ensureRecord(target, "groupChat");
            if (groupChat.mentionPatterns === undefined) {
              groupChat.mentionPatterns = mentionPatterns;
              changes.push(
                `Moved routing.agents.${agentId}.mentionPatterns → agents.list (id "${agentId}").groupChat.mentionPatterns.`,
              );
            } else {
              changes.push(
                `Removed routing.agents.${agentId}.mentionPatterns (agents.list groupChat mentionPatterns already set).`,
              );
            }
            delete entryCopy.mentionPatterns;
          }

          const legacyGroupChat = getRecord(entryCopy.groupChat);
          if (legacyGroupChat) {
            const groupChat = ensureRecord(target, "groupChat");
            mergeMissing(groupChat, legacyGroupChat);
            delete entryCopy.groupChat;
          }

          const legacySandbox = getRecord(entryCopy.sandbox);
          if (legacySandbox) {
            const sandboxTools = getRecord(legacySandbox.tools);
            if (sandboxTools) {
              const tools = ensureRecord(target, "tools");
              const sandbox = ensureRecord(tools, "sandbox");
              const toolPolicy = ensureRecord(sandbox, "tools");
              mergeMissing(toolPolicy, sandboxTools);
              delete legacySandbox.tools;
              changes.push(
                `Moved routing.agents.${agentId}.sandbox.tools → agents.list (id "${agentId}").tools.sandbox.tools.`,
              );
            }
            entryCopy.sandbox = legacySandbox;
          }

          mergeMissing(target, entryCopy);
        }
        delete routing.agents;
        changes.push("Moved routing.agents → agents.list.");
      }

      const defaultAgentId =
        typeof routing.defaultAgentId === "string"
          ? routing.defaultAgentId.trim()
          : "";
      if (defaultAgentId) {
        const hasDefault = list.some(
          (entry): entry is Record<string, unknown> =>
            isRecord(entry) && entry.default === true,
        );
        if (!hasDefault) {
          const entry = ensureAgentEntry(list, defaultAgentId);
          entry.default = true;
          changes.push(
            `Moved routing.defaultAgentId → agents.list (id "${defaultAgentId}").default.`,
          );
        } else {
          changes.push(
            "Removed routing.defaultAgentId (agents.list default already set).",
          );
        }
        delete routing.defaultAgentId;
      }

      if (list.length > 0) {
        agents.list = list;
      }

      if (Object.keys(routing).length === 0) {
        delete raw.routing;
      }
    },
  },
  {
    id: "routing.config-v2",
    describe:
      "Move routing bindings/groupChat/queue/agentToAgent/transcribeAudio",
    apply: (raw, changes) => {
      const routing = getRecord(raw.routing);
      if (!routing) return;

      if (routing.bindings !== undefined) {
        if (raw.bindings === undefined) {
          raw.bindings = routing.bindings;
          changes.push("Moved routing.bindings → bindings.");
        } else {
          changes.push("Removed routing.bindings (bindings already set).");
        }
        delete routing.bindings;
      }

      if (routing.agentToAgent !== undefined) {
        const tools = ensureRecord(raw, "tools");
        if (tools.agentToAgent === undefined) {
          tools.agentToAgent = routing.agentToAgent;
          changes.push("Moved routing.agentToAgent → tools.agentToAgent.");
        } else {
          changes.push(
            "Removed routing.agentToAgent (tools.agentToAgent already set).",
          );
        }
        delete routing.agentToAgent;
      }

      if (routing.queue !== undefined) {
        const messages = ensureRecord(raw, "messages");
        if (messages.queue === undefined) {
          messages.queue = routing.queue;
          changes.push("Moved routing.queue → messages.queue.");
        } else {
          changes.push("Removed routing.queue (messages.queue already set).");
        }
        delete routing.queue;
      }

      const groupChat = getRecord(routing.groupChat);
      if (groupChat) {
        const historyLimit = groupChat.historyLimit;
        if (historyLimit !== undefined) {
          const messages = ensureRecord(raw, "messages");
          const messagesGroup = ensureRecord(messages, "groupChat");
          if (messagesGroup.historyLimit === undefined) {
            messagesGroup.historyLimit = historyLimit;
            changes.push(
              "Moved routing.groupChat.historyLimit → messages.groupChat.historyLimit.",
            );
          } else {
            changes.push(
              "Removed routing.groupChat.historyLimit (messages.groupChat.historyLimit already set).",
            );
          }
          delete groupChat.historyLimit;
        }

        const mentionPatterns = groupChat.mentionPatterns;
        if (mentionPatterns !== undefined) {
          const messages = ensureRecord(raw, "messages");
          const messagesGroup = ensureRecord(messages, "groupChat");
          if (messagesGroup.mentionPatterns === undefined) {
            messagesGroup.mentionPatterns = mentionPatterns;
            changes.push(
              "Moved routing.groupChat.mentionPatterns → messages.groupChat.mentionPatterns.",
            );
          } else {
            changes.push(
              "Removed routing.groupChat.mentionPatterns (messages.groupChat.mentionPatterns already set).",
            );
          }
          delete groupChat.mentionPatterns;
        }

        if (Object.keys(groupChat).length === 0) {
          delete routing.groupChat;
        } else {
          routing.groupChat = groupChat;
        }
      }

      if (routing.transcribeAudio !== undefined) {
        const mapped = mapLegacyAudioTranscription(routing.transcribeAudio);
        if (mapped) {
          const tools = ensureRecord(raw, "tools");
          const toolsAudio = ensureRecord(tools, "audio");
          if (toolsAudio.transcription === undefined) {
            toolsAudio.transcription = mapped;
            changes.push(
              "Moved routing.transcribeAudio → tools.audio.transcription.",
            );
          } else {
            changes.push(
              "Removed routing.transcribeAudio (tools.audio.transcription already set).",
            );
          }
        } else {
          changes.push(
            "Removed routing.transcribeAudio (unsupported transcription CLI).",
          );
        }
        delete routing.transcribeAudio;
      }

      const audio = getRecord(raw.audio);
      if (audio?.transcription !== undefined) {
        const mapped = mapLegacyAudioTranscription(audio.transcription);
        if (mapped) {
          const tools = ensureRecord(raw, "tools");
          const toolsAudio = ensureRecord(tools, "audio");
          if (toolsAudio.transcription === undefined) {
            toolsAudio.transcription = mapped;
            changes.push(
              "Moved audio.transcription → tools.audio.transcription.",
            );
          } else {
            changes.push(
              "Removed audio.transcription (tools.audio.transcription already set).",
            );
          }
          delete audio.transcription;
          if (Object.keys(audio).length === 0) delete raw.audio;
          else raw.audio = audio;
        } else {
          delete audio.transcription;
          changes.push(
            "Removed audio.transcription (unsupported transcription CLI).",
          );
          if (Object.keys(audio).length === 0) delete raw.audio;
          else raw.audio = audio;
        }
      }

      if (Object.keys(routing).length === 0) {
        delete raw.routing;
      }
    },
  },
  {
    id: "agent.defaults-v2",
    describe: "Move agent config to agents.defaults and tools",
    apply: (raw, changes) => {
      const agent = getRecord(raw.agent);
      if (!agent) return;

      const agents = ensureRecord(raw, "agents");
      const defaults = getRecord(agents.defaults) ?? {};
      const tools = ensureRecord(raw, "tools");

      const agentTools = getRecord(agent.tools);
      if (agentTools) {
        if (tools.allow === undefined && agentTools.allow !== undefined) {
          tools.allow = agentTools.allow;
          changes.push("Moved agent.tools.allow → tools.allow.");
        }
        if (tools.deny === undefined && agentTools.deny !== undefined) {
          tools.deny = agentTools.deny;
          changes.push("Moved agent.tools.deny → tools.deny.");
        }
      }

      const elevated = getRecord(agent.elevated);
      if (elevated) {
        if (tools.elevated === undefined) {
          tools.elevated = elevated;
          changes.push("Moved agent.elevated → tools.elevated.");
        } else {
          changes.push("Removed agent.elevated (tools.elevated already set).");
        }
      }

      const bash = getRecord(agent.bash);
      if (bash) {
        if (tools.exec === undefined && tools.bash === undefined) {
          tools.exec = bash;
          changes.push("Moved agent.bash → tools.exec.");
        } else if (tools.exec !== undefined) {
          changes.push("Removed agent.bash (tools.exec already set).");
        } else {
          changes.push("Removed agent.bash (tools.bash already set).");
        }
      }

      const sandbox = getRecord(agent.sandbox);
      if (sandbox) {
        const sandboxTools = getRecord(sandbox.tools);
        if (sandboxTools) {
          const toolsSandbox = ensureRecord(tools, "sandbox");
          const toolPolicy = ensureRecord(toolsSandbox, "tools");
          mergeMissing(toolPolicy, sandboxTools);
          delete sandbox.tools;
          changes.push("Moved agent.sandbox.tools → tools.sandbox.tools.");
        }
      }

      const subagents = getRecord(agent.subagents);
      if (subagents) {
        const subagentTools = getRecord(subagents.tools);
        if (subagentTools) {
          const toolsSubagents = ensureRecord(tools, "subagents");
          const toolPolicy = ensureRecord(toolsSubagents, "tools");
          mergeMissing(toolPolicy, subagentTools);
          delete subagents.tools;
          changes.push("Moved agent.subagents.tools → tools.subagents.tools.");
        }
      }

      const agentCopy: Record<string, unknown> = structuredClone(agent);
      delete agentCopy.tools;
      delete agentCopy.elevated;
      delete agentCopy.bash;
      if (isRecord(agentCopy.sandbox)) delete agentCopy.sandbox.tools;
      if (isRecord(agentCopy.subagents)) delete agentCopy.subagents.tools;

      mergeMissing(defaults, agentCopy);
      agents.defaults = defaults;
      raw.agents = agents;
      delete raw.agent;
      changes.push("Moved agent → agents.defaults.");
    },
  },
  {
    id: "identity->agents.list",
    describe: "Move identity to agents.list[].identity",
    apply: (raw, changes) => {
      const identity = getRecord(raw.identity);
      if (!identity) return;

      const agents = ensureRecord(raw, "agents");
      const list = getAgentsList(agents);
      const defaultId = resolveDefaultAgentIdFromRaw(raw);
      const entry = ensureAgentEntry(list, defaultId);
      if (entry.identity === undefined) {
        entry.identity = identity;
        changes.push(
          `Moved identity → agents.list (id "${defaultId}").identity.`,
        );
      } else {
        changes.push("Removed identity (agents.list identity already set).");
      }
      agents.list = list;
      raw.agents = agents;
      delete raw.identity;
    },
  },
  {
    id: "bind-tailnet->auto",
    describe: "Remap gateway/bridge bind 'tailnet' to 'auto'",
    apply: (raw, changes) => {
      const migrateBind = (
        obj: Record<string, unknown> | null | undefined,
        key: string,
      ) => {
        if (!obj) return;
        const bind = obj.bind;
        if (bind === "tailnet") {
          obj.bind = "auto";
          changes.push(`Migrated ${key}.bind from 'tailnet' to 'auto'.`);
        }
      };

      const gateway = getRecord(raw.gateway);
      migrateBind(gateway, "gateway");

      const bridge = getRecord(raw.bridge);
      migrateBind(bridge, "bridge");
    },
  },
];

export function findLegacyConfigIssues(raw: unknown): LegacyConfigIssue[] {
  if (!raw || typeof raw !== "object") return [];
  const root = raw as Record<string, unknown>;
  const issues: LegacyConfigIssue[] = [];
  for (const rule of LEGACY_CONFIG_RULES) {
    let cursor: unknown = root;
    for (const key of rule.path) {
      if (!cursor || typeof cursor !== "object") {
        cursor = undefined;
        break;
      }
      cursor = (cursor as Record<string, unknown>)[key];
    }
    if (cursor !== undefined && (!rule.match || rule.match(cursor, root))) {
      issues.push({ path: rule.path.join("."), message: rule.message });
    }
  }
  return issues;
}

export function applyLegacyMigrations(raw: unknown): {
  next: Record<string, unknown> | null;
  changes: string[];
} {
  if (!raw || typeof raw !== "object") return { next: null, changes: [] };
  const next = structuredClone(raw) as Record<string, unknown>;
  const changes: string[] = [];
  for (const migration of LEGACY_CONFIG_MIGRATIONS) {
    migration.apply(next, changes);
  }
  if (changes.length === 0) return { next: null, changes: [] };
  return { next, changes };
}
