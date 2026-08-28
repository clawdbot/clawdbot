import { runInitialConfigWriteHealth } from "./doctor-health-contribution-runners.config.js";
import {
  runClaudeCliHealth,
  runCommandOwnerHealth,
} from "./doctor-health-contribution-runners.gateway.js";
import {
  runChannelIngressDeadLettersHealth,
  runAgentMemorySchemaHealth,
  runCodexSessionRouteHealth,
  runConfigAuditScrubHealth,
  runDatabaseBloatHealth,
  runDiskSpaceHealth,
  runLegacyCronHealth,
  runLegacyPluginManifestHealth,
  runPluginRegistryHealth,
  runReleaseConfiguredPluginInstallsHealth,
  runSandboxHealth,
  runSessionSnapshotsHealth,
  runSessionTranscriptHeadersHealth,
  runSessionTranscriptLabelsHealth,
  runSessionTranscriptsHealth,
  runStateIntegrityHealth,
} from "./doctor-health-contribution-runners.state.js";
import { runActiveToolSchemaWarningsHealth } from "./doctor-health-contribution-runners.workspace.js";
import type {
  DoctorHealthContribution,
  DoctorHealthFlowContext,
} from "./doctor-health-contribution-types.js";
import { createDoctorHealthContribution } from "./doctor-health-contribution.js";
import type { HealthCheck, HealthRepairContext, HealthRepairEffect } from "./health-checks.js";

function legacyOwnedRepair(
  collectEffects: (ctx: HealthRepairContext) => Promise<readonly HealthRepairEffect[]>,
  reason: string,
): NonNullable<HealthCheck["repair"]> {
  return async (ctx) => {
    const effects = await collectEffects(ctx);
    return ctx.dryRun === true
      ? { status: "repaired", changes: [], effects }
      : { status: "skipped", reason, changes: [], effects };
  };
}

async function runTelegramGeneralTopicConversationHealth(
  ctx: DoctorHealthFlowContext,
): Promise<void> {
  const { runCoreContributionHealth } = await import("./doctor-health-contribution-core.js");
  await runCoreContributionHealth(ctx, ["core/doctor/telegram-general-topic-conversations"]);
}

export function resolveInitialDoctorHealthContributions(params: {
  runStructuredHealthRepairs: (ctx: DoctorHealthFlowContext) => Promise<void>;
  runGatewayConfigHealth: (ctx: DoctorHealthFlowContext) => Promise<void>;
  runAuthProfileHealth: (ctx: DoctorHealthFlowContext) => Promise<void>;
  runGatewayAuthHealth: (ctx: DoctorHealthFlowContext) => Promise<void>;
  runLegacyStateHealth: (ctx: DoctorHealthFlowContext) => Promise<void>;
}): DoctorHealthContribution[] {
  return [
    createDoctorHealthContribution({
      id: "doctor:write-config-migrations",
      label: "Write config migrations",
      required: true,
      run: runInitialConfigWriteHealth,
    }),
    createDoctorHealthContribution({
      id: "doctor:gateway-config",
      label: "Gateway config",
      healthCheckIds: ["core/doctor/gateway-config"],
      run: params.runGatewayConfigHealth,
    }),
    createDoctorHealthContribution({
      id: "doctor:auth-profiles",
      label: "Auth profiles",
      healthChecks: {
        description: "Auth profile cooldown, expiry, missing credential, and legacy override state",
        defaultEnabled: false,
        async detect(ctx) {
          const { collectAuthProfileHealthFindings } = await import("../commands/doctor-auth.js");
          return collectAuthProfileHealthFindings({ cfg: ctx.cfg, allowKeychainPrompt: false });
        },
      },
      run: params.runAuthProfileHealth,
    }),
    createDoctorHealthContribution({
      id: "doctor:claude-cli",
      label: "Claude CLI",
      healthCheckIds: ["core/doctor/claude-cli"],
      run: runClaudeCliHealth,
    }),
    createDoctorHealthContribution({
      id: "doctor:gateway-auth",
      label: "Gateway auth",
      healthCheckIds: ["core/doctor/gateway-auth"],
      run: params.runGatewayAuthHealth,
    }),
    createDoctorHealthContribution({
      id: "doctor:node-hosting-preconditions",
      label: "Node hosting preconditions",
      healthChecks: {
        description: "Gateway config can authenticate and onboard node and worker hosts.",
        async detect(ctx) {
          const { collectNodeHostingPreconditionFindings } =
            await import("../commands/doctor-node-hosting-preconditions.js");
          return collectNodeHostingPreconditionFindings(ctx.cfg);
        },
      },
    }),
    createDoctorHealthContribution({
      id: "doctor:command-owner",
      label: "Command owner",
      healthCheckIds: ["core/doctor/command-owner"],
      run: runCommandOwnerHealth,
    }),
    createDoctorHealthContribution({
      id: "doctor:structured-health-repairs",
      label: "Structured health repairs",
      run: params.runStructuredHealthRepairs,
    }),
    createDoctorHealthContribution({
      id: "doctor:legacy-state",
      label: "Legacy state",
      healthCheckIds: ["core/doctor/legacy-state", "core/doctor/removed-workspaces-state"],
      run: params.runLegacyStateHealth,
    }),
    createDoctorHealthContribution({
      id: "doctor:session-transcripts",
      label: "Session transcripts",
      healthChecks: {
        description: "Legacy or branchy session transcript files are represented as findings.",
        defaultEnabled: false,
        async detect() {
          const { detectSessionTranscriptHealthIssues, sessionTranscriptIssueToHealthFinding } =
            await import("../commands/doctor-session-transcripts.js");
          return (await detectSessionTranscriptHealthIssues()).map(
            sessionTranscriptIssueToHealthFinding,
          );
        },
        repair: legacyOwnedRepair(async () => {
          const { detectSessionTranscriptHealthIssues, sessionTranscriptIssueToRepairEffect } =
            await import("../commands/doctor-session-transcripts.js");
          return (await detectSessionTranscriptHealthIssues()).map(
            sessionTranscriptIssueToRepairEffect,
          );
        }, "legacy doctor session transcript contribution owns transcript rewrites"),
      },
      run: runSessionTranscriptsHealth,
    }),
    createDoctorHealthContribution({
      id: "doctor:agent-memory-schema",
      label: "Agent memory schema",
      run: runAgentMemorySchemaHealth,
    }),
    createDoctorHealthContribution({
      id: "doctor:legacy-plugin-manifests",
      label: "Legacy plugin manifests",
      healthChecks: {
        description: "Legacy plugin manifest capability keys are reported as findings.",
        defaultEnabled: false,
        async detect(ctx) {
          const {
            collectLegacyPluginManifestContractMigrations,
            legacyPluginManifestContractMigrationToHealthFinding,
          } = await import("../commands/doctor-plugin-manifests.js");
          return collectLegacyPluginManifestContractMigrations({
            config: ctx.cfg,
            env: process.env,
          }).map(legacyPluginManifestContractMigrationToHealthFinding);
        },
      },
      run: runLegacyPluginManifestHealth,
    }),
    createDoctorHealthContribution({
      id: "doctor:legacy-plugin-dependencies",
      label: "Legacy plugin dependencies",
      healthChecks: {
        description: "Legacy plugin dependency state roots are represented as findings.",
        defaultEnabled: false,
        async detect() {
          const {
            detectLegacyPluginDependencyStateIssues,
            legacyPluginDependencyStateIssueToHealthFinding,
          } = await import("../commands/doctor/shared/plugin-dependency-cleanup.js");
          return (await detectLegacyPluginDependencyStateIssues({ env: process.env })).map(
            legacyPluginDependencyStateIssueToHealthFinding,
          );
        },
      },
      run: async () => {},
    }),
    createDoctorHealthContribution({
      id: "doctor:stale-plugin-runtime-symlinks",
      label: "Stale plugin runtime symlinks",
      healthChecks: {
        description: "Stale plugin-runtime symlinks are represented as findings.",
        defaultEnabled: false,
        async detect() {
          const { collectStalePluginRuntimeSymlinkHealthFindings } =
            await import("../commands/doctor/shared/plugin-runtime-symlinks.js");
          return collectStalePluginRuntimeSymlinkHealthFindings();
        },
      },
      run: async () => {},
    }),
    createDoctorHealthContribution({
      id: "doctor:release-configured-plugin-installs",
      label: "Configured plugin repair",
      healthChecks: {
        id: "core/doctor/configured-plugin-installs",
        description: "Configured plugin install records and package payloads are repairable.",
        defaultEnabled: false,
        async detect(ctx) {
          const {
            detectConfiguredPluginInstallHealthIssues,
            configuredPluginInstallIssueToHealthFinding,
          } = await import("../commands/doctor/shared/missing-configured-plugin-install.js");
          return (
            await detectConfiguredPluginInstallHealthIssues({ cfg: ctx.cfg, env: process.env })
          ).map(configuredPluginInstallIssueToHealthFinding);
        },
        repair: legacyOwnedRepair(async (ctx) => {
          const {
            detectConfiguredPluginInstallHealthIssues,
            configuredPluginInstallIssueToRepairEffect,
          } = await import("../commands/doctor/shared/missing-configured-plugin-install.js");
          return (
            await detectConfiguredPluginInstallHealthIssues({ cfg: ctx.cfg, env: process.env })
          ).map(configuredPluginInstallIssueToRepairEffect);
        }, "legacy doctor configured plugin install repair owns package mutation"),
      },
      run: runReleaseConfiguredPluginInstallsHealth,
    }),
    createDoctorHealthContribution({
      id: "doctor:plugin-registry",
      label: "Plugin registry",
      healthChecks: {
        description: "Plugin registry migration, stale shadow, and peer-link issues are findings.",
        defaultEnabled: false,
        async detect(ctx) {
          const { detectPluginRegistryHealthIssues, pluginRegistryIssueToHealthFinding } =
            await import("../commands/doctor-plugin-registry.js");
          return (
            await detectPluginRegistryHealthIssues({
              config: ctx.cfg,
              env: process.env,
              prompter: { shouldRepair: false },
            })
          ).map(pluginRegistryIssueToHealthFinding);
        },
        repair: legacyOwnedRepair(async (ctx) => {
          const { detectPluginRegistryHealthIssues, pluginRegistryIssueToRepairEffect } =
            await import("../commands/doctor-plugin-registry.js");
          return (
            await detectPluginRegistryHealthIssues({
              config: ctx.cfg,
              env: process.env,
              prompter: { shouldRepair: false },
            })
          ).map(pluginRegistryIssueToRepairEffect);
        }, "legacy doctor plugin registry contribution owns registry repairs"),
      },
      run: runPluginRegistryHealth,
    }),
    // Runtime tool discovery must follow plugin metadata repair; running it earlier
    // scans each workspace again after the authoritative generation changes.
    createDoctorHealthContribution({
      id: "doctor:active-tool-schema-warnings",
      label: "Active tool schema warnings",
      run: runActiveToolSchemaWarningsHealth,
    }),
    createDoctorHealthContribution({
      id: "doctor:ui-protocol-freshness",
      label: "UI protocol freshness",
      healthCheckIds: ["core/doctor/ui-protocol-freshness"],
      run: async () => {},
    }),
    createDoctorHealthContribution({
      id: "doctor:disk-space",
      label: "Disk space",
      healthChecks: {
        description: "Low disk space around the OpenClaw state directory is a finding.",
        defaultEnabled: false,
        async detect(ctx) {
          const { collectDiskSpaceHealthFindings } =
            await import("../commands/doctor-disk-space.js");
          return collectDiskSpaceHealthFindings(ctx.cfg);
        },
      },
      run: runDiskSpaceHealth,
    }),
    createDoctorHealthContribution({
      id: "doctor:db-bloat",
      label: "SQLite database size",
      run: runDatabaseBloatHealth,
    }),
    createDoctorHealthContribution({
      id: "doctor:channel-ingress-dead-letters",
      label: "Channel ingress dead letters",
      run: runChannelIngressDeadLettersHealth,
    }),
    createDoctorHealthContribution({
      id: "doctor:state-integrity",
      label: "State integrity",
      healthChecks: {
        description: "State directory, config permission, and runtime state issues are findings.",
        defaultEnabled: false,
        async detect(ctx) {
          const { detectStateIntegrityHealthIssues, stateIntegrityIssueToHealthFinding } =
            await import("../commands/doctor-state-integrity.js");
          return detectStateIntegrityHealthIssues(ctx.cfg, {
            configPath: ctx.configPath,
            env: process.env,
          }).map(stateIntegrityIssueToHealthFinding);
        },
        repair: legacyOwnedRepair(async (ctx) => {
          const { detectStateIntegrityHealthIssues, stateIntegrityIssueToRepairEffect } =
            await import("../commands/doctor-state-integrity.js");
          return detectStateIntegrityHealthIssues(ctx.cfg, {
            configPath: ctx.configPath,
            env: process.env,
          }).map(stateIntegrityIssueToRepairEffect);
        }, "legacy doctor state integrity contribution owns state repairs"),
      },
      run: runStateIntegrityHealth,
    }),
    createDoctorHealthContribution({
      id: "doctor:codex-session-routes",
      label: "Codex session routes",
      healthCheckIds: ["core/doctor/codex-session-routes"],
      run: runCodexSessionRouteHealth,
    }),
    createDoctorHealthContribution({
      id: "doctor:telegram-general-topic-conversations",
      label: "Telegram General-topic conversations",
      healthCheckIds: ["core/doctor/telegram-general-topic-conversations"],
      run: runTelegramGeneralTopicConversationHealth,
    }),
    createDoctorHealthContribution({
      id: "doctor:session-transcript-headers",
      label: "Session transcript headers",
      run: runSessionTranscriptHeadersHealth,
    }),
    createDoctorHealthContribution({
      id: "doctor:session-transcript-labels",
      label: "Session transcript labels",
      run: runSessionTranscriptLabelsHealth,
    }),
    createDoctorHealthContribution({
      id: "doctor:session-snapshots",
      label: "Session snapshots",
      healthChecks: {
        description: "Stale cached session snapshot paths are represented as findings.",
        defaultEnabled: false,
        async detect(ctx) {
          const { detectSessionSnapshotHealthIssues, sessionSnapshotIssueToHealthFinding } =
            await import("../commands/doctor-session-snapshots.js");
          return (await detectSessionSnapshotHealthIssues({ cfg: ctx.cfg, env: process.env })).map(
            sessionSnapshotIssueToHealthFinding,
          );
        },
        repair: legacyOwnedRepair(async (ctx) => {
          const { detectSessionSnapshotHealthIssues, sessionSnapshotIssueToRepairEffect } =
            await import("../commands/doctor-session-snapshots.js");
          return (await detectSessionSnapshotHealthIssues({ cfg: ctx.cfg, env: process.env })).map(
            sessionSnapshotIssueToRepairEffect,
          );
        }, "legacy doctor session snapshot contribution owns snapshot rewrites"),
      },
      run: runSessionSnapshotsHealth,
    }),
    createDoctorHealthContribution({
      id: "doctor:config-audit-scrub",
      label: "Config audit",
      healthChecks: {
        description:
          "Historical config-audit argv redaction gaps are represented as structured findings.",
        defaultEnabled: false,
        async detect() {
          const { configAuditScrubToHealthFinding, detectConfigAuditScrubIssue } =
            await import("../commands/doctor-config-audit-scrub.js");
          const result = await detectConfigAuditScrubIssue();
          return result.rewritten > 0 ? [configAuditScrubToHealthFinding(result)] : [];
        },
        repair: legacyOwnedRepair(async () => {
          const { configAuditScrubToRepairEffect, detectConfigAuditScrubIssue } =
            await import("../commands/doctor-config-audit-scrub.js");
          const result = await detectConfigAuditScrubIssue();
          return result.rewritten > 0 ? [configAuditScrubToRepairEffect(result)] : [];
        }, "legacy doctor config audit contribution owns cleanup"),
      },
      run: runConfigAuditScrubHealth,
    }),
    createDoctorHealthContribution({
      id: "doctor:legacy-cron",
      label: "Legacy cron",
      healthCheckIds: ["core/doctor/legacy-whatsapp-crontab", "core/doctor/legacy-cron-store"],
      run: runLegacyCronHealth,
    }),
    createDoctorHealthContribution({
      id: "doctor:sandbox",
      label: "Sandbox",
      healthChecks: {
        id: "core/doctor/sandbox/registry-files",
        description: "Legacy sandbox registry files are represented in SQLite registry storage.",
        async detect() {
          const {
            detectLegacySandboxRegistryFileIssues,
            legacySandboxRegistryInspectionToHealthFinding,
          } = await import("../commands/doctor-sandbox.js");
          return (await detectLegacySandboxRegistryFileIssues()).map(
            legacySandboxRegistryInspectionToHealthFinding,
          );
        },
        repair: legacyOwnedRepair(async () => {
          const {
            detectLegacySandboxRegistryFileIssues,
            legacySandboxRegistryInspectionToRepairEffect,
          } = await import("../commands/doctor-sandbox.js");
          return (await detectLegacySandboxRegistryFileIssues()).map(
            legacySandboxRegistryInspectionToRepairEffect,
          );
        }, "legacy doctor sandbox contribution owns registry migration"),
      },
      run: runSandboxHealth,
    }),
  ];
}
