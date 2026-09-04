// Lazy core handler families keep gateway startup metadata-only until first use.
import { createLazyPromise } from "../../shared/lazy-promise.js";
import {
  listCoreGatewayHandlerMethodNames,
  type CoreGatewayHandlerFamily,
} from "../methods/core-descriptors.js";
import { createLazyCoreHandlers } from "./lazy-core-handlers.js";
import type { GatewayRequestHandlers } from "./types.js";

type CoreGatewayHandlerModuleLoader = () => Promise<GatewayRequestHandlers>;

const CORE_GATEWAY_HANDLER_MODULES = {
  agent: () => import("./agent.js").then((module) => module.agentHandlers),
  "agent-identity": () =>
    import("./agent-identity.js").then((module) => module.agentIdentityHandlers),
  agents: () => import("./agents.js").then((module) => module.agentsHandlers),
  "agents-workspace": () =>
    import("./agents-workspace.js").then((module) => module.agentsWorkspaceHandlers),
  artifacts: () => import("./artifacts.js").then((module) => module.artifactsHandlers),
  board: () => import("./board.js").then((module) => module.boardHandlers),
  audit: () => import("./audit.js").then((module) => module.auditHandlers),
  users: () => import("./users.js").then((module) => module.usersHandlers),
  "users-mentionable": () =>
    import("./users-mentionable.js").then((module) => module.usersMentionableHandlers),
  attach: () => import("./attach.js").then((module) => module.attachHandlers),
  channels: () => import("./channels.js").then((module) => module.channelsHandlers),
  "channel-pairing": () =>
    import("./channel-pairing.js").then((module) => module.channelPairingHandlers),
  chat: () => import("./chat.js").then((module) => module.chatHandlers),
  // Cancellation must not wait for unrelated chat history and send workflows to load.
  "chat-abort": () =>
    import("./chat-abort-handler.js").then((module) => ({
      "chat.abort": module.handleChatAbortRequest,
    })),
  commands: () => import("./commands.js").then((module) => module.commandsHandlers),
  config: () => import("./config.js").then((module) => module.configHandlers),
  conversations: () => import("./conversations.js").then((module) => module.conversationHandlers),
  connect: () => import("./connect.js").then((module) => module.connectHandlers),
  "control-ui": () => import("./control-ui.js").then((module) => module.controlUiHandlers),
  cron: () => import("./cron.js").then((module) => module.cronHandlers),
  devices: () => import("./devices.js").then((module) => module.deviceHandlers),
  "device-pair-setup": () =>
    import("./device-pair-setup.js").then((module) => module.devicePairSetupHandlers),
  diagnostics: () => import("./diagnostics.js").then((module) => module.diagnosticsHandlers),
  doctor: () => import("./doctor.js").then((module) => module.createDoctorHandlers()),
  environments: () => import("./environments.js").then((module) => module.environmentsHandlers),
  worktrees: () => import("./worktrees.js").then((module) => module.worktreesHandlers),
  "exec-approvals": () =>
    import("./exec-approvals.js").then((module) => module.execApprovalsHandlers),
  fs: () => import("./fs.js").then((module) => module.fsHandlers),
  health: () => import("./health.js").then((module) => module.healthHandlers),
  logs: () => import("./logs.js").then((module) => module.logsHandlers),
  "memory-search": () => import("./memory-search.js").then((module) => module.memorySearchHandlers),
  mentions: () => import("./mentions.js").then((module) => module.mentionHandlers),
  terminal: () => import("./terminal.js").then((module) => module.terminalHandlers),
  transcripts: () => import("./transcripts.js").then((module) => module.transcriptsHandlers),
  "ui-command": () => import("./ui-command.js").then((module) => module.uiCommandHandlers),
  "models-auth-status": () =>
    import("./models-auth-status.js").then((module) => module.modelsAuthStatusHandlers),
  "models-auth-order": () =>
    import("./models-auth-order.js").then((module) => module.modelsAuthOrderHandlers),
  models: () => import("./models.js").then((module) => module.modelsHandlers),
  "models-probe": () => import("./models-probe.js").then((module) => module.modelsProbeHandlers),
  "native-hook-relay": () =>
    import("./native-hook-relay.js").then((module) => module.nativeHookRelayHandlers),
  "nodes-pending": () =>
    import("./nodes.pending-work.js").then((module) => module.nodePendingWorkHandlers),
  nodes: () => import("./nodes.js").then((module) => module.nodeHandlers),
  "plugin-host-hooks": () =>
    import("./plugin-host-hooks.js").then((module) => module.pluginHostHookHandlers),
  plugins: () => import("./plugins.js").then((module) => module.pluginsHandlers),
  projects: () => import("./projects.js").then((module) => module.projectsHandlers),
  portals: () => import("./portals.js").then((module) => module.portalHandlers),
  "progress-card": () => import("./progress-card.js").then((module) => module.progressCardHandlers),
  migrations: () => import("./migrations.js").then((module) => module.migrationsHandlers),
  push: () => import("./push.js").then((module) => module.pushHandlers),
  restart: () => import("./restart.js").then((module) => module.restartHandlers),
  suspend: () => import("./suspend.js").then((module) => module.suspendHandlers),
  send: () => import("./send.js").then((module) => module.sendHandlers),
  "sessions-files": () =>
    import("./sessions-files.js").then((module) => module.sessionsFilesHandlers),
  "sessions-github": () =>
    import("./sessions-github.js").then((module) => module.sessionsGitHubHandlers),
  "sessions-diff": () => import("./sessions-diff.js").then((module) => module.sessionsDiffHandlers),
  "sessions-abort": () =>
    import("./sessions-abort.js").then((module) => module.sessionAbortHandlers),
  "sessions-compact": () =>
    import("./sessions-compact.js").then((module) => module.sessionCompactHandlers),
  "sessions-compaction-checkpoints": () =>
    import("./sessions-compaction-checkpoints.js").then(
      (module) => module.sessionCheckpointHandlers,
    ),
  "sessions-compaction-queries": () =>
    import("./sessions-compaction-queries.js").then(
      (module) => module.sessionCheckpointQueryHandlers,
    ),
  "sessions-create": () =>
    import("./sessions-create.js").then((module) => module.sessionCreateHandlers),
  "sessions-title": () =>
    import("./sessions-title.js").then((module) => module.sessionTitleHandlers),
  "sessions-recover": () =>
    import("./sessions-recover.js").then((module) => module.sessionRecoverHandlers),
  "sessions-delete": () =>
    import("./sessions-delete.js").then((module) => module.sessionDeleteHandlers),
  "sessions-dispatch": () =>
    import("./sessions-dispatch.js").then((module) => module.sessionDispatchHandlers),
  "sessions-groups": () =>
    import("./sessions-groups.js").then((module) => module.sessionGroupHandlers),
  "sessions-goal": () => import("./sessions-goal.js").then((module) => module.sessionGoalHandlers),
  "sessions-messaging": () =>
    import("./sessions-messaging.js").then((module) => module.sessionMessagingHandlers),
  "sessions-mutations": () =>
    import("./sessions-mutations.js").then((module) => module.sessionMutationHandlers),
  "sessions-read": () => import("./sessions-read.js").then((module) => module.sessionReadHandlers),
  "sessions-rewind": () =>
    import("./sessions-rewind.js").then((module) => module.sessionRewindHandlers),
  "sessions-sharing": () =>
    import("./sessions-sharing.js").then((module) => module.sessionSharingHandlers),
  "sessions-subscriptions": () =>
    import("./sessions-subscriptions.js").then((module) => module.sessionSubscriptionHandlers),
  "sessions-suggestions": () =>
    import("./sessions-suggestions.js").then((module) => module.sessionSuggestionHandlers),
  "session-catalog": () =>
    import("./session-catalog.js").then((module) => module.sessionCatalogHandlers),
  "session-discussion": () =>
    import("./session-discussion.js").then((module) => module.sessionDiscussionHandlers),
  "session-observer-rpc": () =>
    import("../session-observer-rpc.js").then((module) => module.sessionObserverHandlers),
  "session-companion-rpc": () =>
    import("../session-companion-rpc.js").then((module) => module.sessionCompanionHandlers),
  "hooks-status": () => import("./hooks-status.js").then((module) => module.hooksStatusHandlers),
  skills: () => import("./skills.js").then((module) => module.skillsHandlers),
  system: () => import("./system.js").then((module) => module.systemHandlers),
  talk: () => import("./talk.js").then((module) => module.talkHandlers),
  // Mode synchronization does not depend on loading speech or realtime providers.
  "talk-mode": () => import("./talk-mode.js").then((module) => module.talkModeHandlers),
  tasks: () => import("./tasks.js").then((module) => module.tasksHandlers),
  "task-suggestions": () =>
    import("./task-suggestions.js").then((module) => module.taskSuggestionsHandlers),
  "tools-catalog": () => import("./tools-catalog.js").then((module) => module.toolsCatalogHandlers),
  "tools-github": () => import("./tools-github.js").then((module) => module.toolsGitHubHandlers),
  "tools-effective": () =>
    import("./tools-effective.js").then((module) => module.toolsEffectiveHandlers),
  "tools-invoke": () => import("./tools-invoke.js").then((module) => module.toolsInvokeHandlers),
  "mcp-app": () => import("./mcp-app.js").then((module) => module.mcpAppHandlers),
  tts: () => import("./tts.js").then((module) => module.ttsHandlers),
  update: () => import("./update.js").then((module) => module.updateHandlers),
  usage: () => import("./usage.js").then((module) => module.usageHandlers),
  "voicewake-routing": () =>
    import("./voicewake-routing.js").then((module) => module.voicewakeRoutingHandlers),
  voicewake: () => import("./voicewake.js").then((module) => module.voicewakeHandlers),
  web: () => import("./web.js").then((module) => module.webHandlers),
  "system-agent": () => import("./system-agent.js").then((module) => module.systemAgentHandlers),
  "system-changes": () =>
    import("./system-changes.js").then((module) => module.systemChangesHandlers),
  wizard: () => import("./wizard.js").then((module) => module.wizardHandlers),
} satisfies Record<CoreGatewayHandlerFamily, CoreGatewayHandlerModuleLoader>;

export const coreGatewayHandlers: GatewayRequestHandlers = Object.fromEntries(
  Array.from(listCoreGatewayHandlerMethodNames()).flatMap(([family, methods]) =>
    Object.entries(
      createLazyCoreHandlers({
        methods,
        // Failed family imports stay cached until restart, just like successful loads.
        loadHandlers: createLazyPromise(CORE_GATEWAY_HANDLER_MODULES[family], {
          cacheRejections: true,
        }),
      }),
    ),
  ),
);
