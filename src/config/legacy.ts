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

const LEGACY_CONFIG_RULES: LegacyConfigRule[] = [
  {
    path: ["routing", "allowFrom"],
    message:
      "routing.allowFrom was removed; use whatsapp.allowFrom instead (run `clawdbot doctor` to migrate).",
  },
  {
    path: ["routing", "groupChat", "requireMention"],
    message:
      'routing.groupChat.requireMention was removed; use whatsapp/telegram/imessage groups defaults (e.g. whatsapp.groups."*".requireMention) instead (run `clawdbot doctor` to migrate).',
  },
  {
    path: ["telegram", "requireMention"],
    message:
      'telegram.requireMention was removed; use telegram.groups."*".requireMention instead (run `clawdbot doctor` to migrate).',
  },
  {
    path: ["agent", "model"],
    message:
      "agent.model string was replaced by agent.model.primary/fallbacks and agent.models (run `clawdbot doctor` to migrate).",
    match: (value) => typeof value === "string",
  },
  {
    path: ["agent", "imageModel"],
    message:
      "agent.imageModel string was replaced by agent.imageModel.primary/fallbacks (run `clawdbot doctor` to migrate).",
    match: (value) => typeof value === "string",
  },
  {
    path: ["agent", "allowedModels"],
    message:
      "agent.allowedModels was replaced by agent.models (run `clawdbot doctor` to migrate).",
  },
  {
    path: ["agent", "modelAliases"],
    message:
      "agent.modelAliases was replaced by agent.models.*.alias (run `clawdbot doctor` to migrate).",
  },
  {
    path: ["agent", "modelFallbacks"],
    message:
      "agent.modelFallbacks was replaced by agent.model.fallbacks (run `clawdbot doctor` to migrate).",
  },
  {
    path: ["agent", "imageModelFallbacks"],
    message:
      "agent.imageModelFallbacks was replaced by agent.imageModel.fallbacks (run `clawdbot doctor` to migrate).",
  },
];

const LEGACY_CONFIG_MIGRATIONS: LegacyConfigMigration[] = [
  {
    id: "routing.allowFrom->whatsapp.allowFrom",
    describe: "Move routing.allowFrom to whatsapp.allowFrom",
    apply: (raw, changes) => {
      const routing = raw.routing;
      if (!routing || typeof routing !== "object") return;
      const allowFrom = (routing as Record<string, unknown>).allowFrom;
      if (allowFrom === undefined) return;

      const whatsapp =
        raw.whatsapp && typeof raw.whatsapp === "object"
          ? (raw.whatsapp as Record<string, unknown>)
          : {};

      if (whatsapp.allowFrom === undefined) {
        whatsapp.allowFrom = allowFrom;
        changes.push("Moved routing.allowFrom → whatsapp.allowFrom.");
      } else {
        changes.push(
          "Removed routing.allowFrom (whatsapp.allowFrom already set).",
        );
      }

      delete (routing as Record<string, unknown>).allowFrom;
      if (Object.keys(routing as Record<string, unknown>).length === 0) {
        delete raw.routing;
      }
      raw.whatsapp = whatsapp;
    },
  },
  {
    id: "routing.groupChat.requireMention->groups.*.requireMention",
    describe:
      "Move routing.groupChat.requireMention to whatsapp/telegram/imessage groups",
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

      const applyTo = (key: "whatsapp" | "telegram" | "imessage") => {
        const section =
          raw[key] && typeof raw[key] === "object"
            ? (raw[key] as Record<string, unknown>)
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
          raw[key] = section;
          changes.push(
            `Moved routing.groupChat.requireMention → ${key}.groups."*".requireMention.`,
          );
        } else {
          changes.push(
            `Removed routing.groupChat.requireMention (${key}.groups."*" already set).`,
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
    },
  },
  {
    id: "telegram.requireMention->telegram.groups.*.requireMention",
    describe:
      "Move telegram.requireMention to telegram.groups.*.requireMention",
    apply: (raw, changes) => {
      const telegram = raw.telegram;
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
          'Moved telegram.requireMention → telegram.groups."*".requireMention.',
        );
      } else {
        changes.push(
          'Removed telegram.requireMention (telegram.groups."*" already set).',
        );
      }

      delete (telegram as Record<string, unknown>).requireMention;
      if (Object.keys(telegram as Record<string, unknown>).length === 0) {
        delete raw.telegram;
      }
    },
  },
  {
    id: "agent.model-config-v2",
    describe:
      "Migrate legacy agent.model/allowedModels/modelAliases/modelFallbacks/imageModelFallbacks to agent.models + model lists",
    apply: (raw, changes) => {
      const agent =
        raw.agent && typeof raw.agent === "object"
          ? (raw.agent as Record<string, unknown>)
          : null;
      if (!agent) return;

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
        changes.push("Migrated agent.model string → agent.model.primary.");
      }
      if (legacyModelFallbacks.length > 0) {
        changes.push("Migrated agent.modelFallbacks → agent.model.fallbacks.");
      }
      if (legacyImageModel !== undefined) {
        changes.push(
          "Migrated agent.imageModel string → agent.imageModel.primary.",
        );
      }
      if (legacyImageModelFallbacks.length > 0) {
        changes.push(
          "Migrated agent.imageModelFallbacks → agent.imageModel.fallbacks.",
        );
      }
      if (legacyAllowed.length > 0) {
        changes.push("Migrated agent.allowedModels → agent.models.");
      }
      if (Object.keys(legacyAliases).length > 0) {
        changes.push("Migrated agent.modelAliases → agent.models.*.alias.");
      }

      delete agent.allowedModels;
      delete agent.modelAliases;
      delete agent.modelFallbacks;
      delete agent.imageModelFallbacks;
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
