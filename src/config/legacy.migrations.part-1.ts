import {
  ensureRecord,
  getRecord,
  isRecord,
  type LegacyConfigMigration,
  mergeMissing,
} from "./legacy.shared.js";

export const LEGACY_CONFIG_MIGRATIONS_PART_1: LegacyConfigMigration[] = [
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
        const provider = typeof match.provider === "string" ? match.provider.trim() : "";
        if (!provider) continue;
        match.channel = provider;
        delete match.provider;
        entry.match = match;
        touched = true;
      }

      if (touched) {
        raw.bindings = bindings;
        changes.push("Moved bindings[].match.provider → bindings[].match.channel.");
      }
    },
  },
  {
    id: "bindings.match.accountID->bindings.match.accountId",
    describe: "Move bindings[].match.accountID to bindings[].match.accountId",
    apply: (raw, changes) => {
      const bindings = Array.isArray(raw.bindings) ? raw.bindings : null;
      if (!bindings) return;

      let touched = false;
      for (const entry of bindings) {
        if (!isRecord(entry)) continue;
        const match = getRecord(entry.match);
        if (!match) continue;
        if (match.accountId !== undefined) continue;
        const accountID =
          typeof match.accountID === "string" ? match.accountID.trim() : match.accountID;
        if (!accountID) continue;
        match.accountId = accountID;
        delete match.accountID;
        entry.match = match;
        touched = true;
      }

      if (touched) {
        raw.bindings = bindings;
        changes.push("Moved bindings[].match.accountID → bindings[].match.accountId.");
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
        const provider = typeof match.provider === "string" ? match.provider.trim() : "";
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
        changes.push("Moved session.sendPolicy.rules[].match.provider → match.channel.");
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
        changes.push("Moved messages.queue.byProvider → messages.queue.byChannel.");
      } else {
        changes.push("Removed messages.queue.byProvider (messages.queue.byChannel already set).");
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
        "mattermost",
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
          hadEntries ? `Merged ${key} → channels.${key}.` : `Moved ${key} → channels.${key}.`,
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
        changes.push("Removed routing.allowFrom (channels.whatsapp.allowFrom already set).");
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
    describe: "Move routing.groupChat.requireMention to channels.whatsapp/telegram/imessage groups",
    apply: (raw, changes) => {
      const routing = raw.routing;
      if (!routing || typeof routing !== "object") return;
      const groupChat =
        (routing as Record<string, unknown>).groupChat &&
        typeof (routing as Record<string, unknown>).groupChat === "object"
          ? ((routing as Record<string, unknown>).groupChat as Record<string, unknown>)
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
    describe: "Move telegram.requireMention to channels.telegram.groups.*.requireMention",
    apply: (raw, changes) => {
      const channels = ensureRecord(raw, "channels");
      const telegram = channels.telegram;
      if (!telegram || typeof telegram !== "object") return;
      const requireMention = (telegram as Record<string, unknown>).requireMention;
      if (requireMention === undefined) return;

      const groups =
        (telegram as Record<string, unknown>).groups &&
        typeof (telegram as Record<string, unknown>).groups === "object"
          ? ((telegram as Record<string, unknown>).groups as Record<string, unknown>)
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
        changes.push('Removed telegram.requireMention (channels.telegram.groups."*" already set).');
      }

      delete (telegram as Record<string, unknown>).requireMention;
      channels.telegram = telegram as Record<string, unknown>;
      raw.channels = channels;
    },
  },
];
