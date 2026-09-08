import { isExperimentalClawsEnabled } from "../claws/experimental.js";
import { shouldDeferConfiguredPluginInstallRepair } from "../commands/doctor/shared/update-phase.js";
import { hasActiveGatewayExecCredential } from "./doctor-gateway-exec-credential.js";
import { runCoreHealthFindingNote } from "./doctor-health-contribution-core.js";
import {
  collectWriteConfigHealthFindings,
  runFinalConfigValidationHealth,
  runWriteConfigHealth,
} from "./doctor-health-contribution-runners.config.js";
import {
  runBrowserHealth,
  runDevicePairingHealth,
  runGatewayDaemonHealth,
  runGatewayServicesHealth,
  runHostDesktopHealth,
  runGitHubProjectHealth,
  runOpenAIOAuthTlsHealth,
  runSecurityHealth,
  runStartupChannelMaintenanceHealth,
  runWebFetchProxyHealth,
  runWhatsappResponsivenessHealth,
} from "./doctor-health-contribution-runners.gateway.js";
import {
  collectMemorySearchHealthFindings,
  collectWorkspaceStatusPluginVersionReadiness,
  runBootstrapSizeHealth,
  runHeartbeatCadenceMigrationHealth,
  runHeartbeatScratchMigrationHealth,
  runHeartbeatTaskMigrationHealth,
  runHooksModelHealth,
  runMemorySearchHealthContribution,
  runSkillsHealth,
  runToolsMdMigrationHealth,
  runWorkspaceAliasHealth,
  runWorkspaceStatusHealth,
  runWorkspaceSuggestionsHealth,
} from "./doctor-health-contribution-runners.workspace.js";
import type {
  DoctorHealthCheckContext,
  DoctorHealthContribution,
  DoctorHealthFlowContext,
} from "./doctor-health-contribution-types.js";
import { createDoctorHealthContribution } from "./doctor-health-contribution.js";
import type { HealthCheck } from "./health-checks.js";

const CHANNEL_PACKAGE_STATE_CAPABILITIES_CHECK_ID =
  "core/doctor/channel-package-state-capabilities";

export function resolveFinalDoctorHealthContributions(params: {
  runSystemdLingerHealth: (ctx: DoctorHealthFlowContext) => Promise<void>;
  detectSystemdLingerFindings: HealthCheck["detect"];
  runShellCompletionHealth: (ctx: DoctorHealthFlowContext) => Promise<void>;
  runGatewayHealthChecks: (ctx: DoctorHealthFlowContext) => Promise<void>;
}): DoctorHealthContribution[] {
  return [
    createDoctorHealthContribution({
      id: "doctor:gateway-services",
      label: "Gateway services",
      healthCheckIds: [
        "core/doctor/gateway-services/extra",
        "core/doctor/gateway-services/platform-notes",
      ],
      run: runGatewayServicesHealth,
    }),
    createDoctorHealthContribution({
      id: "doctor:host-desktop",
      label: "Host desktop",
      healthChecks: {
        description: "Gateway-host desktop enablement, reachability, and RFB security state.",
        defaultEnabled: false,
        async detect(ctx) {
          const { collectHostDesktopHealthFindings } =
            await import("../commands/doctor-host-desktop.js");
          return collectHostDesktopHealthFindings(ctx.cfg);
        },
      },
      run: runHostDesktopHealth,
    }),
    createDoctorHealthContribution({
      id: "doctor:default-account-routing",
      label: "Default account routing",
      healthChecks: {
        description: "Multi-account channels have explicit default routing or complete bindings.",
        defaultEnabled: false,
        async detect(ctx) {
          const {
            collectMissingDefaultAccountBindingWarnings,
            collectMissingExplicitDefaultAccountWarnings,
          } = await import("../commands/doctor/shared/default-account-warnings.js");
          return [
            ...collectMissingDefaultAccountBindingWarnings(ctx.cfg),
            ...collectMissingExplicitDefaultAccountWarnings(ctx.cfg),
          ].map((message) => ({
            checkId: "core/doctor/default-account-routing",
            severity: "warning" as const,
            message: message.replace(/^- /, "").trim(),
          }));
        },
      },
    }),
    createDoctorHealthContribution({
      id: "doctor:channel-package-state-capabilities",
      label: "Channel package-state capabilities",
      healthChecks: {
        id: CHANNEL_PACKAGE_STATE_CAPABILITIES_CHECK_ID,
        description: "Declared channel package-state checker modules must load.",
        defaultEnabled: true,
        async detect(ctx) {
          if (shouldDeferConfiguredPluginInstallRepair(ctx.env ?? process.env)) {
            return [];
          }
          const { collectBundledChannelPackageStateLoadFailures } =
            await import("../channels/plugins/package-state-probes.js");
          return collectBundledChannelPackageStateLoadFailures().map((failure) => ({
            checkId: CHANNEL_PACKAGE_STATE_CAPABILITIES_CHECK_ID,
            severity: "warning" as const,
            message: `Plugin ${failure.pluginId} declared ${failure.metadataKey}, but its checker failed to load: ${failure.detail}`,
            target: failure.pluginId,
            requirement: "declared-channel-package-state-capability-loadable",
            fixHint: `Rebuild or reinstall plugin ${failure.pluginId}, then rerun \`openclaw doctor\`.`,
          }));
        },
      },
    }),
    createDoctorHealthContribution({
      id: "doctor:startup-channel-maintenance",
      label: "Startup channel maintenance",
      healthChecks: [
        {
          id: "core/doctor/channel-plugin-blockers",
          description: "Configured channels must have loadable backing channel plugins.",
          defaultEnabled: false,
          async detect(ctx) {
            const { channelPluginBlockerHitToHealthFinding, scanConfiguredChannelPluginBlockers } =
              await import("../commands/doctor/shared/channel-plugin-blockers.js");
            return scanConfiguredChannelPluginBlockers(ctx.cfg, process.env).map(
              channelPluginBlockerHitToHealthFinding,
            );
          },
        },
        {
          id: "core/doctor/channel-preview-warnings",
          description: "Channel doctor preview warnings are captured as structured findings.",
          defaultEnabled: false,
          async detect(ctx) {
            const { collectChannelPreviewWarningHealthFindings } =
              await import("./doctor-startup-channel-maintenance.js");
            return collectChannelPreviewWarningHealthFindings({
              cfg: ctx.cfg,
              allowExec: ctx.allowExecSecretRefs === true,
            });
          },
        },
      ],
      run: runStartupChannelMaintenanceHealth,
    }),
    createDoctorHealthContribution({
      id: "doctor:security",
      label: "Security",
      healthCheckIds: ["core/doctor/security"],
      run: runSecurityHealth,
    }),
    createDoctorHealthContribution({
      id: "doctor:web-fetch-proxy",
      label: "Web fetch proxy",
      run: runWebFetchProxyHealth,
    }),
    createDoctorHealthContribution({
      id: "doctor:github-projects",
      label: "GitHub projects",
      run: runGitHubProjectHealth,
    }),
    createDoctorHealthContribution({
      id: "doctor:browser",
      label: "Browser",
      healthCheckIds: ["core/doctor/browser", "core/doctor/browser-clawd-profile-residue"],
      run: runBrowserHealth,
    }),
    createDoctorHealthContribution({
      id: "doctor:oauth-tls",
      label: "OAuth TLS",
      healthCheckIds: ["core/doctor/oauth-tls"],
      run: runOpenAIOAuthTlsHealth,
    }),
    createDoctorHealthContribution({
      id: "doctor:hooks-model",
      label: "Hooks model",
      healthCheckIds: ["core/doctor/hooks-model"],
      run: runHooksModelHealth,
    }),
    createDoctorHealthContribution({
      id: "doctor:model-references",
      label: "Model references",
      healthCheckIds: ["core/doctor/model-references"],
      run: (ctx) => runCoreHealthFindingNote(ctx, "core/doctor/model-references"),
    }),
    createDoctorHealthContribution({
      id: "doctor:provider-catalog-projection",
      label: "Provider catalog projection",
      healthCheckIds: ["core/doctor/provider-catalog-projection"],
      run: (ctx) => runCoreHealthFindingNote(ctx, "core/doctor/provider-catalog-projection"),
    }),
    createDoctorHealthContribution({
      id: "doctor:local-audio-acceleration",
      label: "Local audio acceleration",
      healthCheckIds: ["core/doctor/local-audio-acceleration"],
      run: (ctx) => runCoreHealthFindingNote(ctx, "core/doctor/local-audio-acceleration"),
    }),
    createDoctorHealthContribution({
      id: "doctor:runtime-tool-schemas",
      label: "Runtime tool schemas",
      healthCheckIds: ["core/doctor/runtime-tool-schemas"],
      run: (ctx) => runCoreHealthFindingNote(ctx, "core/doctor/runtime-tool-schemas"),
    }),
    createDoctorHealthContribution({
      id: "doctor:skill-workshop-tool-policy",
      label: "Skill Workshop tool policy",
      healthCheckIds: ["core/doctor/skill-workshop-tool-policy"],
      run: (ctx) => runCoreHealthFindingNote(ctx, "core/doctor/skill-workshop-tool-policy"),
    }),
    createDoctorHealthContribution({
      id: "doctor:skill-workshop-relocation",
      label: "Skill Workshop relocation",
      healthCheckIds: ["core/doctor/skill-workshop-relocation"],
      run: (ctx) => runCoreHealthFindingNote(ctx, "core/doctor/skill-workshop-relocation"),
    }),
    createDoctorHealthContribution({
      id: "doctor:systemd-linger",
      label: "systemd linger",
      healthChecks: {
        description: "Disabled systemd user lingering is reported as a finding.",
        defaultEnabled: false,
        detect: params.detectSystemdLingerFindings,
      },
      run: params.runSystemdLingerHealth,
    }),
    createDoctorHealthContribution({
      id: "doctor:workspace-status",
      label: "Workspace status",
      healthChecks: {
        description: "Workspace plugin/status diagnostics are exposed as findings.",
        defaultEnabled: false,
        async detect(ctx) {
          const { collectWorkspaceStatusHealthFindings } =
            await import("../commands/doctor-workspace-status.js");
          const pluginVersionReadiness = await collectWorkspaceStatusPluginVersionReadiness({
            cfg: ctx.cfg,
            options: { nonInteractive: true, allowExec: ctx.allowExecSecretRefs === true },
          });
          const runWithPluginMetadataSnapshot = (ctx as DoctorHealthCheckContext)
            .runWithPluginMetadataSnapshot;
          return collectWorkspaceStatusHealthFindings(ctx.cfg, {
            pluginVersionReadiness,
            ...(runWithPluginMetadataSnapshot ? { runWithPluginMetadataSnapshot } : {}),
          });
        },
      },
      run: runWorkspaceStatusHealth,
    }),
    ...(isExperimentalClawsEnabled()
      ? [
          createDoctorHealthContribution({
            id: "doctor:claws-state",
            label: "Claws state",
            healthCheckIds: ["core/doctor/claws-state"],
            run: (ctx) => runCoreHealthFindingNote(ctx, "core/doctor/claws-state"),
          }),
        ]
      : []),
    createDoctorHealthContribution({
      id: "doctor:workspace-alias",
      label: "Workspace alias",
      healthChecks: {
        description:
          "Persisted workspace aliases must resolve to the canonical target that owns their stored state.",
        defaultEnabled: true,
        async detect(ctx) {
          const { collectRepointedWorkspaceAliasFindings } =
            await import("../commands/doctor-workspace-alias.js");
          return collectRepointedWorkspaceAliasFindings(ctx.cfg);
        },
      },
      run: runWorkspaceAliasHealth,
    }),
    createDoctorHealthContribution({
      id: "doctor:skills",
      label: "Skills",
      healthCheckIds: ["core/doctor/skills-readiness"],
      run: runSkillsHealth,
    }),
    createDoctorHealthContribution({
      id: "doctor:bootstrap-size",
      label: "Bootstrap size",
      healthCheckIds: ["core/doctor/bootstrap-size"],
      run: runBootstrapSizeHealth,
    }),
    createDoctorHealthContribution({
      id: "doctor:heartbeat-cadence-migration",
      label: "Heartbeat cadence migration",
      healthChecks: {
        description: "Heartbeat cadence config must be materialized in cron monitor rows.",
        defaultEnabled: true,
        async detect(ctx) {
          const { collectHeartbeatCadenceMigrationFindings } =
            await import("../commands/doctor-heartbeat-cadence-migration.js");
          return collectHeartbeatCadenceMigrationFindings(ctx.cfg, ctx.env);
        },
      },
      run: runHeartbeatCadenceMigrationHealth,
    }),
    createDoctorHealthContribution({
      id: "doctor:heartbeat-scratch-migration",
      label: "Heartbeat scratch migration",
      healthChecks: {
        description: "Workspace HEARTBEAT.md files must migrate into cron-owned scratch.",
        defaultEnabled: true,
        async detect(ctx) {
          const { collectHeartbeatScratchMigrationFindings } =
            await import("../commands/doctor-heartbeat-scratch-migration.js");
          return collectHeartbeatScratchMigrationFindings(ctx.cfg);
        },
      },
      run: runHeartbeatScratchMigrationHealth,
    }),
    createDoctorHealthContribution({
      id: "doctor:tools-md-migration",
      label: "TOOLS.md migration",
      healthChecks: {
        description: "Workspace TOOLS.md notes must migrate into the AGENTS.md Tools section.",
        defaultEnabled: true,
        async detect(ctx) {
          const { collectToolsMdMigrationFindings } =
            await import("../commands/doctor-tools-md-migration.js");
          return collectToolsMdMigrationFindings(ctx.cfg);
        },
      },
      run: runToolsMdMigrationHealth,
    }),
    createDoctorHealthContribution({
      id: "doctor:heartbeat-task-cron-migration",
      label: "Heartbeat task cron migration",
      healthChecks: {
        description: "Heartbeat scratch task blocks must migrate into automations.",
        defaultEnabled: true,
        async detect(ctx) {
          const { collectHeartbeatTaskMigrationFindings } =
            await import("../commands/doctor-heartbeat-task-migration.js");
          return collectHeartbeatTaskMigrationFindings(ctx.cfg, ctx.env);
        },
      },
      run: runHeartbeatTaskMigrationHealth,
    }),
    createDoctorHealthContribution({
      id: "doctor:shell-completion",
      label: "Shell completion",
      healthCheckIds: ["core/doctor/shell-completion"],
      run: params.runShellCompletionHealth,
    }),
    createDoctorHealthContribution({
      id: "doctor:gateway-health",
      label: "Gateway health",
      healthCheckIds: ["core/doctor/gateway-health"],
      run: params.runGatewayHealthChecks,
    }),
    createDoctorHealthContribution({
      id: "doctor:whatsapp-responsiveness",
      label: "WhatsApp responsiveness",
      healthChecks: {
        description: "Gateway pressure and local TUI observations when WhatsApp is enabled.",
        defaultEnabled: false,
        async detect(ctx) {
          const { collectWhatsappResponsivenessHealthFindings } =
            await import("../commands/doctor-whatsapp-responsiveness.js");
          let status: import("../status/types.js").StatusSummary | undefined;
          if (
            !(
              (await hasActiveGatewayExecCredential({ cfg: ctx.cfg })) &&
              ctx.allowExecSecretRefs !== true
            )
          ) {
            const { callGateway } = await import("../gateway/call.js");
            status = await callGateway<import("../status/types.js").StatusSummary>({
              method: "status",
              params: { includeChannelSummary: false },
              timeoutMs: 3000,
              config: ctx.cfg,
              deviceIdentity: null,
            }).catch(() => undefined);
          }
          return collectWhatsappResponsivenessHealthFindings({ cfg: ctx.cfg, status });
        },
      },
      run: runWhatsappResponsivenessHealth,
    }),
    createDoctorHealthContribution({
      id: "doctor:memory-search",
      label: "Memory search",
      healthChecks: {
        description: "Memory search provider and backend readiness are captured as findings.",
        defaultEnabled: false,
        detect: collectMemorySearchHealthFindings,
      },
      run: runMemorySearchHealthContribution,
    }),
    createDoctorHealthContribution({
      id: "doctor:device-pairing",
      label: "Device pairing",
      healthChecks: {
        description: "Device pairing requests and stale device-auth records are findings.",
        defaultEnabled: false,
        async detect(ctx) {
          const { collectDevicePairingHealthFindings } =
            await import("../commands/doctor-device-pairing.js");
          return collectDevicePairingHealthFindings({
            cfg: ctx.cfg,
            healthOk: false,
            env: ctx.env,
          });
        },
      },
      run: runDevicePairingHealth,
    }),
    createDoctorHealthContribution({
      id: "doctor:gateway-daemon",
      label: "Gateway daemon",
      healthCheckIds: ["core/doctor/gateway-daemon"],
      run: runGatewayDaemonHealth,
    }),
    createDoctorHealthContribution({
      id: "doctor:write-config",
      label: "Write config",
      healthChecks: {
        description: "Config write blockers are findings before doctor repair writes.",
        defaultEnabled: false,
        detect: collectWriteConfigHealthFindings,
      },
      run: runWriteConfigHealth,
    }),
    createDoctorHealthContribution({
      id: "doctor:workspace-suggestions",
      label: "Workspace suggestions",
      healthCheckIds: ["core/doctor/workspace-suggestions"],
      run: runWorkspaceSuggestionsHealth,
    }),
    createDoctorHealthContribution({
      id: "doctor:final-config-validation",
      label: "Final config validation",
      healthCheckIds: ["core/doctor/final-config-validation"],
      run: runFinalConfigValidationHealth,
    }),
  ];
}
