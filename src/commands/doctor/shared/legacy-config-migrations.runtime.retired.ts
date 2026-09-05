// Retired runtime config keys that migrate or disappear before canonical validation.
import {
  defineLegacyConfigMigration,
  ensureRecord,
  getRecord,
  mergeMissing,
  type LegacyConfigMigrationSpec,
  type LegacyConfigRule,
} from "../../../config/legacy.shared.js";
import {
  hasConfigTrancheLegacyKeys,
  migrateConfigTranche,
} from "./legacy-config-migrations.runtime.config-tranche.js";
import {
  consolidateMediaCapabilityConfig,
  hasDiscordRealtimeVoice,
  hasLegacyMediaCapabilityConfig,
  hasMediaDeepgram,
  migrateDiscordVoice,
  migrateMediaDeepgram,
  moveVoice,
  stripRetiredTuningKnobs,
} from "./legacy-config-migrations.runtime.retired-media.js";
import { LEGACY_CONFIG_MIGRATION_RUNTIME_MEMORY_QMD } from "./legacy-config-migrations.runtime.retired-memory-qmd.js";
import { migrateTierEvalTranche } from "./legacy-config-migrations.runtime.tier-eval.js";
import { visitAgentConfigScopes, visitChannelEntries } from "./legacy-config-record-shared.js";

const rule = (
  path: string[],
  message: string,
  match?: LegacyConfigRule["match"],
): LegacyConfigRule => ({
  path,
  message: `${message} Run "openclaw doctor --fix".`,
  ...(match ? { match } : {}),
});

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

function migrateMessageCrossContext(raw: Record<string, unknown>, changes: string[]): void {
  const globalMessage = getRecord(getRecord(raw.tools)?.message);
  const globalBypass = globalMessage?.allowCrossContextSend;
  const globalCrossContext = getRecord(globalMessage?.crossContext);
  const migrate = (message: Record<string, unknown> | null, path: string, agent: boolean) => {
    if (!message) {
      return;
    }
    const legacy = message.allowCrossContextSend;
    const inheritedBypass = agent && globalBypass === true;
    if (legacy === undefined && !inheritedBypass) {
      return;
    }
    const crossContext = getRecord(message.crossContext) ?? {};
    // The shipped legacy flag bypassed both checks. An agent's false masked the
    // root bypass, so preserve that effective policy before changing the root.
    if ((legacy ?? (agent ? globalBypass : undefined)) === true) {
      message.crossContext = {
        ...crossContext,
        allowWithinProvider: true,
        allowAcrossProviders: true,
      };
    } else if (inheritedBypass) {
      message.crossContext = {
        ...crossContext,
        allowWithinProvider:
          (crossContext.allowWithinProvider ?? globalCrossContext?.allowWithinProvider) !== false,
        allowAcrossProviders:
          (crossContext.allowAcrossProviders ?? globalCrossContext?.allowAcrossProviders) === true,
      };
    }
    delete message.allowCrossContextSend;
    changes.push(`Moved ${path}.allowCrossContextSend → ${path}.crossContext.`);
  };
  visitAgentConfigScopes(raw, (scope, path) => {
    if (path !== "agents.defaults") {
      migrate(getRecord(getRecord(scope.tools)?.message), `${path}.tools.message`, true);
    }
  });
  migrate(globalMessage, "tools.message", false);
}

function migrateTruncateAfterCompaction(raw: Record<string, unknown>, changes: string[]): void {
  const compaction = getRecord(getRecord(getRecord(raw.agents)?.defaults)?.compaction);
  if (!compaction || !Object.hasOwn(compaction, "truncateAfterCompaction")) {
    return;
  }
  if (
    compaction.truncateAfterCompaction === false &&
    Object.hasOwn(compaction, "maxActiveTranscriptBytes")
  ) {
    delete compaction.maxActiveTranscriptBytes;
    changes.push("Removed maxActiveTranscriptBytes to preserve truncateAfterCompaction: false.");
  }
  delete compaction.truncateAfterCompaction;
  changes.push("Removed retired agents.defaults.compaction.truncateAfterCompaction.");
}

function migrateFinalLayoutRenames(raw: Record<string, unknown>, changes: string[]): void {
  const agents = getRecord(raw.agents);
  const defaults = getRecord(agents?.defaults);
  moveKey(defaults, "pdfMaxBytesMb", "pdfMaxMb", "agents.defaults", changes);
  if (defaults) {
    const mediaModels = getRecord(defaults.mediaModels) ?? {};
    for (const [legacyKey, canonicalKey] of [
      ["imageGenerationModel", "image"],
      ["videoGenerationModel", "video"],
      ["musicGenerationModel", "music"],
    ] as const) {
      if (!Object.hasOwn(defaults, legacyKey)) {
        continue;
      }
      if (mediaModels[canonicalKey] === undefined) {
        mediaModels[canonicalKey] = defaults[legacyKey];
        changes.push(
          `Moved agents.defaults.${legacyKey} → agents.defaults.mediaModels.${canonicalKey}.`,
        );
      } else {
        changes.push(
          `Removed agents.defaults.${legacyKey} (agents.defaults.mediaModels.${canonicalKey} already set).`,
        );
      }
      delete defaults[legacyKey];
    }
    if (Object.keys(mediaModels).length > 0) {
      defaults.mediaModels = mediaModels;
    }
  }

  visitAgentConfigScopes(raw, (scope, path) => {
    moveKey(
      getRecord(getRecord(scope.tools)?.exec),
      "timeoutSec",
      "timeoutSeconds",
      `${path}.tools.exec`,
      changes,
    );
    moveKey(
      getRecord(getRecord(scope.sandbox)?.browser),
      "enableNoVnc",
      "noVncEnabled",
      `${path}.sandbox.browser`,
      changes,
    );
  });
  moveKey(
    getRecord(getRecord(raw.tools)?.exec),
    "timeoutSec",
    "timeoutSeconds",
    "tools.exec",
    changes,
  );

  const env = getRecord(raw.env);
  if (env) {
    const vars = getRecord(env.vars) ?? {};
    let moved = false;
    for (const [key, value] of Object.entries(env)) {
      if (key === "vars" || key === "shellEnv" || typeof value !== "string") {
        continue;
      }
      if (vars[key] === undefined) {
        vars[key] = value;
        changes.push(`Moved env.${key} → env.vars.${key}.`);
      } else {
        changes.push(`Removed env.${key} (env.vars.${key} already set).`);
      }
      delete env[key];
      moved = true;
    }
    if (moved) {
      env.vars = vars;
    }
  }

  const browser = getRecord(raw.browser);
  const ssrfPolicy = getRecord(browser?.ssrfPolicy);
  if (ssrfPolicy && Array.isArray(ssrfPolicy.hostnameAllowlist)) {
    const canonical = Array.isArray(ssrfPolicy.allowedHostnames) ? ssrfPolicy.allowedHostnames : [];
    ssrfPolicy.allowedHostnames = [
      ...new Set(
        [...canonical, ...ssrfPolicy.hostnameAllowlist].filter(
          (value) => typeof value === "string",
        ),
      ),
    ];
    delete ssrfPolicy.hostnameAllowlist;
    changes.push("Merged browser.ssrfPolicy.hostnameAllowlist → allowedHostnames.");
  }

  const legacyMedia = getRecord(raw.media);
  if (legacyMedia) {
    const attachments = ensureRecord(raw, "attachments");
    mergeMissing(attachments, legacyMedia);
    delete raw.media;
    changes.push("Moved media → attachments.");
  }

  const audit = getRecord(raw.audit);
  if (audit) {
    const logging = ensureRecord(raw, "logging");
    const canonicalAudit = getRecord(logging.audit) ?? {};
    mergeMissing(canonicalAudit, audit);
    logging.audit = canonicalAudit;
    delete raw.audit;
    changes.push("Moved audit → logging.audit.");
  }

  const nodes = getRecord(getRecord(raw.gateway)?.nodes);
  if (nodes) {
    const skills = getRecord(nodes.skills);
    if (skills && Object.hasOwn(skills, "enabled")) {
      if (nodes.allowSkills === undefined) {
        nodes.allowSkills = skills.enabled;
      }
      delete nodes.skills;
      changes.push("Moved gateway.nodes.skills.enabled → gateway.nodes.allowSkills.");
    }
    const commands = getRecord(nodes.commands) ?? {};
    if (Object.hasOwn(nodes, "allowCommands")) {
      if (commands.allow === undefined) {
        commands.allow = nodes.allowCommands;
      }
      delete nodes.allowCommands;
      changes.push("Moved gateway.nodes.allowCommands → gateway.nodes.commands.allow.");
    }
    if (Object.hasOwn(nodes, "denyCommands")) {
      if (commands.deny === undefined) {
        commands.deny = nodes.denyCommands;
      }
      delete nodes.denyCommands;
      changes.push("Moved gateway.nodes.denyCommands → gateway.nodes.commands.deny.");
    }
    if (Object.keys(commands).length > 0) {
      nodes.commands = commands;
    }
  }

  visitChannelEntries(raw, "slack", (entry, path) => {
    moveKey(entry, "identity", "postAs", path, changes);
  });
}

function migrateFinalLayoutKills(raw: Record<string, unknown>, changes: string[]): void {
  const defaults = getRecord(getRecord(raw.agents)?.defaults);
  if (defaults && Object.hasOwn(defaults, "promptOverlays")) {
    const personality = getRecord(getRecord(defaults.promptOverlays)?.gpt5)?.personality;
    if (personality !== undefined) {
      const openaiConfig = ensureRecord(
        ensureRecord(ensureRecord(ensureRecord(raw, "plugins"), "entries"), "openai"),
        "config",
      );
      if (openaiConfig.personality === undefined) {
        openaiConfig.personality = personality;
        changes.push(
          "Moved agents.defaults.promptOverlays.gpt5.personality → plugins.entries.openai.config.personality.",
        );
      } else {
        changes.push(
          "Removed agents.defaults.promptOverlays.gpt5.personality (plugins.entries.openai.config.personality already set).",
        );
      }
    } else {
      changes.push("Removed agents.defaults.promptOverlays; built-in behavior now applies.");
    }
    delete defaults.promptOverlays;
  }
  for (const key of [
    "envelopeTimestamp",
    "envelopeElapsed",
    "envelopeTimezone",
    "timeFormat",
    "bootstrapPromptTruncationWarning",
    "mediaGenerationAutoProviderFallback",
  ]) {
    if (defaults && Object.hasOwn(defaults, key)) {
      delete defaults[key];
      changes.push(`Removed agents.defaults.${key}; built-in behavior now applies.`);
    }
  }

  const diagnostics = getRecord(raw.diagnostics);
  const otel = getRecord(diagnostics?.otel);
  const captureContent = getRecord(otel?.captureContent);
  if (otel && captureContent) {
    otel.captureContent =
      typeof captureContent.enabled === "boolean"
        ? captureContent.enabled
        : Object.entries(captureContent).some(
            ([key, value]) => key !== "enabled" && value === true,
          );
    changes.push("Collapsed diagnostics.otel.captureContent to a boolean.");
  }
  const cacheTrace = getRecord(diagnostics?.cacheTrace);
  if (
    cacheTrace &&
    (Object.keys(cacheTrace).some((key) => key !== "enabled") ||
      (cacheTrace.enabled !== undefined && typeof cacheTrace.enabled !== "boolean"))
  ) {
    diagnostics!.cacheTrace = { enabled: cacheTrace.enabled === true };
    changes.push("Removed diagnostics.cacheTrace detail fields; only enabled remains.");
  }

  const attachments = getRecord(raw.attachments);
  if (attachments && Object.hasOwn(attachments, "preserveFilenames")) {
    delete attachments.preserveFilenames;
    changes.push("Removed attachments.preserveFilenames; temp-safe names now always apply.");
  }
  const browser = getRecord(raw.browser);
  if (browser && Object.hasOwn(browser, "color")) {
    delete browser.color;
    changes.push("Removed browser.color; the built-in color now applies.");
  }
  const profiles = getRecord(browser?.profiles);
  if (profiles) {
    for (const [profileId, value] of Object.entries(profiles)) {
      const profile = getRecord(value);
      if (profile && Object.hasOwn(profile, "color")) {
        delete profile.color;
        changes.push(`Removed browser.profiles.${profileId}.color.`);
      }
    }
  }

  visitChannelEntries(raw, "discord", (entry, path) => {
    const autoPresence = getRecord(entry.autoPresence);
    for (const key of ["healthyText", "degradedText", "exhaustedText"]) {
      if (autoPresence && Object.hasOwn(autoPresence, key)) {
        delete autoPresence[key];
        changes.push(`Removed ${path}.autoPresence.${key}.`);
      }
    }
    const components = getRecord(getRecord(entry.ui)?.components);
    if (components && Object.hasOwn(components, "accentColor")) {
      delete components.accentColor;
      changes.push(`Removed ${path}.ui.components.accentColor.`);
      const ui = getRecord(entry.ui);
      if (Object.keys(components).length === 0 && ui) {
        delete ui.components;
      }
      if (ui && Object.keys(ui).length === 0) {
        delete entry.ui;
      }
    }
  });

  const messages = getRecord(raw.messages);
  const statusReactions = getRecord(messages?.statusReactions);
  if (statusReactions && Object.hasOwn(statusReactions, "emojis")) {
    delete statusReactions.emojis;
    changes.push("Removed messages.statusReactions.emojis; curated defaults now apply.");
  }
  if (messages && Object.hasOwn(messages, "removeAckAfterReply")) {
    delete messages.removeAckAfterReply;
    changes.push("Removed messages.removeAckAfterReply; acknowledgements are retained.");
  }

  visitChannelEntries(raw, "whatsapp", (entry, path) => {
    moveKey(entry, "messagePrefix", "responsePrefix", path, changes);
  });

  visitChannelEntries(raw, "slack", (entry, path) => {
    const socketMode = getRecord(entry.socketMode);
    for (const key of ["clientPingTimeout", "serverPingTimeout", "pingPongLoggingEnabled"]) {
      if (socketMode && Object.hasOwn(socketMode, key)) {
        delete socketMode[key];
        changes.push(`Removed ${path}.socketMode.${key}.`);
      }
    }
    if (socketMode && Object.keys(socketMode).length === 0) {
      delete entry.socketMode;
    }
  });
  visitChannelEntries(raw, "imessage", (entry, path) => {
    if (Object.hasOwn(entry, "coalesceSameSenderDms")) {
      delete entry.coalesceSameSenderDms;
      changes.push(`Removed ${path}.coalesceSameSenderDms.`);
    }
  });

  const commands = getRecord(raw.commands);
  for (const key of ["ownerDisplay", "ownerDisplaySecret"]) {
    if (commands && Object.hasOwn(commands, key)) {
      delete commands[key];
      changes.push(`Removed commands.${key}; owner ids now render raw.`);
    }
  }

  const cron = getRecord(raw.cron);
  const failureDestination = getRecord(cron?.failureDestination);
  if (cron && failureDestination) {
    const failureAlert = getRecord(cron.failureAlert) ?? {};
    mergeMissing(failureAlert, failureDestination);
    cron.failureAlert = failureAlert;
    delete cron.failureDestination;
    changes.push("Merged cron.failureDestination → cron.failureAlert.");
  }
  const gateway = getRecord(raw.gateway);
  const reload = getRecord(gateway?.reload);
  if (reload?.mode === "restart" || reload?.mode === "hot") {
    reload.mode = "hybrid";
    changes.push("Mapped gateway.reload.mode to hybrid.");
  }
  const logging = getRecord(raw.logging);
  if (logging?.consoleStyle === "compact") {
    logging.consoleStyle = "pretty";
    changes.push("Mapped logging.consoleStyle compact → pretty.");
  }
  const controlUi = getRecord(gateway?.controlUi);
  if (controlUi && Object.hasOwn(controlUi, "chatMessageMaxWidth")) {
    delete controlUi.chatMessageMaxWidth;
    changes.push("Removed gateway.controlUi.chatMessageMaxWidth; chat width is now browser-local.");
  }
}

function removeUiAssistantIdentity(raw: Record<string, unknown>, changes: string[]): void {
  const ui = getRecord(raw.ui);
  if (!ui || !Object.hasOwn(ui, "assistant")) {
    return;
  }

  // The retired override was presentation-only. Translating it into agent identity
  // would unexpectedly change outbound channel identity.
  delete ui.assistant;
  if (Object.keys(ui).length === 0) {
    delete raw.ui;
  }
  changes.push("Removed retired ui.assistant; configure agents.list[].identity instead.");
}

export const LEGACY_CONFIG_MIGRATIONS_RUNTIME_RETIRED: LegacyConfigMigrationSpec[] = [
  LEGACY_CONFIG_MIGRATION_RUNTIME_MEMORY_QMD,
  defineLegacyConfigMigration({
    id: "runtime.messages-suppress-tool-errors",
    describe: "Remove retired tool failure warning suppression",
    legacyRules: [
      rule(
        ["messages", "suppressToolErrors"],
        "messages.suppressToolErrors is retired; tool failure warnings now appear only when a run ends without a reply.",
      ),
    ],
    apply: (raw, changes) => {
      const messages = getRecord(raw.messages);
      if (!messages || !Object.hasOwn(messages, "suppressToolErrors")) {
        return;
      }
      delete messages.suppressToolErrors;
      changes.push(
        "Removed messages.suppressToolErrors (tool failure warnings now appear only when a run ends without a reply).",
      );
    },
  }),
  defineLegacyConfigMigration({
    id: "runtime.retired-internal-hook-handlers",
    describe: "Remove retired internal hook handler registrations",
    legacyRules: [
      {
        path: ["hooks", "internal", "handlers"],
        message:
          'hooks.internal.handlers is retired. Move each module to a managed/workspace hook directory with HOOK.md + handler file before running "openclaw doctor --fix"; the fix removes retired registrations and does not materialize executable files.',
      },
    ],
    apply: (raw, changes) => {
      const internal = getRecord(getRecord(raw.hooks)?.internal);
      if (!internal || !Object.hasOwn(internal, "handlers")) {
        return;
      }

      delete internal.handlers;
      changes.push(
        "Removed retired hooks.internal.handlers registrations; hook files must be migrated separately.",
      );

      const entries = getRecord(internal.entries);
      const extraDirs = getRecord(internal.load)?.extraDirs;
      const hasNamedEntries = Boolean(entries && Object.keys(entries).length > 0);
      const hasExtraDirs =
        Array.isArray(extraDirs) &&
        extraDirs.some((dir) => typeof dir === "string" && dir.trim().length > 0);
      if (internal.enabled === true && !hasNamedEntries && !hasExtraDirs) {
        delete internal.enabled;
        changes.push(
          "Removed legacy-only hooks.internal.enabled to avoid enabling broad hook discovery.",
        );
      }
    },
  }),
  defineLegacyConfigMigration({
    id: "runtime.doctor-tier-eval-tranche",
    describe: "Consolidate approved tier-eval configuration surfaces",
    legacyRules: [
      rule([], "Approved tier-eval configuration surfaces were consolidated.", (_value, root) => {
        const changes: string[] = [];
        migrateTierEvalTranche(structuredClone(root), changes);
        return changes.length > 0;
      }),
    ],
    apply: migrateTierEvalTranche,
  }),
  defineLegacyConfigMigration({
    id: "runtime.final-layout-polish",
    describe: "Normalize final configuration layout names",
    legacyRules: [
      rule([], "Final layout aliases were retired.", (_value, root) => {
        const changes: string[] = [];
        migrateFinalLayoutRenames(structuredClone(root), changes);
        return changes.length > 0;
      }),
    ],
    apply: migrateFinalLayoutRenames,
  }),
  defineLegacyConfigMigration({
    id: "runtime.final-layout-kills",
    describe: "Remove final layout tuning knobs",
    legacyRules: [
      rule([], "Final layout tuning knobs were retired.", (_value, root) => {
        const changes: string[] = [];
        migrateFinalLayoutKills(structuredClone(root), changes);
        return changes.length > 0;
      }),
    ],
    apply: migrateFinalLayoutKills,
  }),
  defineLegacyConfigMigration({
    id: "runtime.media-models-consolidation",
    describe: "Consolidate per-capability media model configuration",
    legacyRules: [
      rule(
        ["tools", "media"],
        "Per-capability media model settings moved to capability-tagged tools.media.models entries.",
        hasLegacyMediaCapabilityConfig,
      ),
    ],
    apply: (raw, changes) => {
      migrateMediaDeepgram(raw, changes);
      consolidateMediaCapabilityConfig(raw, changes);
    },
  }),
  defineLegacyConfigMigration({
    id: "runtime.config-tranche",
    describe: "Migrate retired config-tranche options",
    legacyRules: [
      rule(
        [],
        "Presentation-only preferences and duplicate tuning options moved to canonical defaults.",
        (_value, root) => hasConfigTrancheLegacyKeys(root),
      ),
    ],
    apply: migrateConfigTranche,
  }),
  defineLegacyConfigMigration({
    id: "runtime.tuning-knobs-purge",
    describe: "Remove retired runtime tuning knobs",
    legacyRules: [
      rule(
        [],
        "Numeric runtime tuning knobs were retired and now use built-in defaults.",
        (_value, root) => stripRetiredTuningKnobs(structuredClone(root)),
      ),
    ],
    apply: (raw, changes) => {
      if (stripRetiredTuningKnobs(raw)) {
        changes.push("Removed retired runtime tuning knobs; built-in defaults now apply.");
      }
    },
  }),
  defineLegacyConfigMigration({
    id: "runtime.ui-assistant-identity",
    describe: "Remove the retired UI assistant identity override",
    legacyRules: [
      rule(["ui", "assistant"], "ui.assistant was retired; use agents.list[].identity instead."),
    ],
    apply: removeUiAssistantIdentity,
  }),
  defineLegacyConfigMigration({
    id: "runtime.retired-config-keys",
    describe: "Migrate retired root and tool config keys",
    legacyRules: [
      rule(["tui"], "tui was retired and is ignored."),
      rule(["commands", "modelsWrite"], "commands.modelsWrite was retired and is ignored."),
      rule(
        ["messages", "messagePrefix"],
        "messages.messagePrefix moved to channels.whatsapp.responsePrefix.",
      ),
      rule(
        ["tools", "media", "asyncCompletion"],
        "tools.media.asyncCompletion.directSend was retired and is ignored.",
      ),
      rule(
        ["tools", "message", "allowCrossContextSend"],
        "tools.message.allowCrossContextSend moved to tools.message.crossContext.",
      ),
      rule(
        ["agents"],
        "Per-agent tools.message.allowCrossContextSend moved to tools.message.crossContext on the same agent.",
        (value) => {
          let found = false;
          visitAgentConfigScopes({ agents: value }, (scope, path) => {
            found ||=
              path !== "agents.defaults" &&
              Object.hasOwn(
                getRecord(getRecord(scope.tools)?.message) ?? {},
                "allowCrossContextSend",
              );
          });
          return found;
        },
      ),
      rule(["tools", "experimental"], "tools.experimental.planTool moved to tools.updatePlan."),
      rule(
        ["talk", "realtime", "voice"],
        "talk.realtime.voice moved to talk.realtime.speakerVoice.",
      ),
      rule(
        ["channels", "discord"],
        "Discord realtime voice aliases moved to speakerVoice.",
        hasDiscordRealtimeVoice,
      ),
      rule(
        ["tools", "media"],
        "Legacy Deepgram options moved to providerOptions.deepgram.",
        hasMediaDeepgram,
      ),
      rule(
        ["agents", "defaults", "compaction", "truncateAfterCompaction"],
        "agents.defaults.compaction.truncateAfterCompaction is retired; byte-triggered compaction now opts in via maxActiveTranscriptBytes alone.",
      ),
    ],
    apply: (raw, changes) => {
      migrateTruncateAfterCompaction(raw, changes);
      if (Object.hasOwn(raw, "tui")) {
        delete raw.tui;
        changes.push("Removed retired tui config; the footer uses the default compact display.");
      }
      const commands = getRecord(raw.commands);
      if (commands && Object.hasOwn(commands, "modelsWrite")) {
        delete commands.modelsWrite;
        changes.push("Removed retired commands.modelsWrite.");
      }
      const messages = getRecord(raw.messages);
      if (messages && Object.hasOwn(messages, "messagePrefix")) {
        const whatsapp = ensureRecord(ensureRecord(raw, "channels"), "whatsapp");
        if (whatsapp.responsePrefix === undefined) {
          whatsapp.responsePrefix = messages.messagePrefix;
          changes.push("Moved messages.messagePrefix → channels.whatsapp.responsePrefix.");
        } else {
          changes.push(
            "Removed messages.messagePrefix (channels.whatsapp.responsePrefix already set).",
          );
        }
        delete messages.messagePrefix;
      }
      const media = getRecord(getRecord(raw.tools)?.media);
      if (media && Object.hasOwn(media, "asyncCompletion")) {
        delete media.asyncCompletion;
        changes.push("Removed retired tools.media.asyncCompletion.directSend.");
      }
      migrateMessageCrossContext(raw, changes);
      // planTool was the only tools.experimental member, so the strict schema now
      // rejects the whole container; lift the value, then drop the empty parent.
      const tools = getRecord(raw.tools);
      const experimentalTools = getRecord(tools?.experimental);
      if (tools && experimentalTools) {
        if (Object.hasOwn(experimentalTools, "planTool") && tools.updatePlan === undefined) {
          tools.updatePlan = experimentalTools.planTool;
          changes.push("Moved tools.experimental.planTool → tools.updatePlan.");
        } else {
          changes.push("Removed tools.experimental; tools.updatePlan now owns the switch.");
        }
        delete tools.experimental;
      }
      const talkRealtime = getRecord(getRecord(raw.talk)?.realtime);
      if (talkRealtime) {
        moveVoice(talkRealtime, "talk.realtime", changes);
      }
      const channels = getRecord(raw.channels);
      if (channels) {
        migrateDiscordVoice(channels, changes);
      }
      migrateMediaDeepgram(raw, changes);
    },
  }),
];
