/** Coordinates explicit Doctor migrations with the managed Gateway lifecycle. */
import path from "node:path";
import { formatCliCommand } from "../cli/command-format.js";
import {
  renderRestartDiagnostics,
  waitForGatewayHealthyRestart,
} from "../cli/daemon-cli/restart-health.js";
import {
  maybeStopManagedServiceBeforeMutableUpdate,
  maybeResumeWindowsTaskAutoStartAfterPackageUpdate,
  revalidateManagedGatewayServiceAfterUpdate,
  resolveUpdatedGatewayRestartPort,
  type PreManagedServiceStop,
} from "../cli/update-cli/update-command-service-maintenance.js";
import { createConfigIO } from "../config/io.js";
import { resolveConfigPath, resolveStateDir } from "../config/paths.js";
import { resolveConfiguredAgentDatabaseTargets } from "../config/sessions/targets.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { readGatewayServiceState, resolveGatewayService } from "../daemon/service.js";
import { resolvePathViaExistingAncestorSync } from "../infra/boundary-path.js";
import {
  acquireGatewayLifecycleCoordinator,
  acquireStateDatabaseCoordinator,
} from "../infra/state-database-coordinator.js";
import { detectLegacyStateMigrations } from "../infra/state-migrations.doctor.js";
import { prepareLegacySessionSurfaces } from "../plugins/legacy-session-surfaces.js";
import type { RuntimeEnv } from "../runtime.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../state/openclaw-agent-db-contract.js";
import {
  preflightOpenClawDatabaseSchemas,
  OpenClawDatabaseSchemaPreflightError,
} from "../state/openclaw-database-preflight.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../state/openclaw-state-db-contract.js";
import { detectOpenClawStateDatabaseSchemaMigrations } from "../state/openclaw-state-db-schema-repair.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import type { DoctorOptions } from "./doctor-prompter.js";
import {
  isServiceRepairExternallyManaged,
  shouldManageGatewayService,
} from "./doctor-service-repair-policy.js";

async function needsDoctorMaintenance(env: NodeJS.ProcessEnv): Promise<boolean> {
  // Core-only materialization avoids plugin runtime/state loading before the
  // current Gateway has relinquished ownership. Keep config env changes local.
  const snapshot = await createConfigIO({
    env: { ...env },
    observe: false,
    pluginValidation: "core-only",
  }).readConfigFileSnapshot();
  const cfg = snapshot.sourceConfig ?? snapshot.config;
  const schemas = preflightOpenClawDatabaseSchemas({
    env,
    supportedVersions: {
      state: OPENCLAW_STATE_SCHEMA_VERSION,
      agent: OPENCLAW_AGENT_SCHEMA_VERSION,
    },
    configuredAgentDatabaseTargets: resolveConfiguredAgentDatabaseTargets(cfg, { env }),
    verifyCurrentSchemaShape: true,
  });
  if (schemas.incompatible.length > 0) {
    throw new OpenClawDatabaseSchemaPreflightError(schemas.incompatible, { operation: "doctor" });
  }
  if (
    schemas.indeterminate.length > 0 ||
    detectOpenClawStateDatabaseSchemaMigrations({ env }).length > 0
  ) {
    return true;
  }
  const detected = await detectLegacyStateMigrations({
    cfg,
    env,
    doctorOnlyStateMigrations: true,
    legacySessionSurfaces: prepareLegacySessionSurfaces({ config: cfg, env }),
  });
  return detected.preview.length > 0;
}

function assertDoctorServiceSelection(env: NodeJS.ProcessEnv, serviceEnv: NodeJS.ProcessEnv): void {
  const selection = (candidate: NodeJS.ProcessEnv) => {
    const stateDir = resolveStateDir(candidate);
    return [stateDir, resolveConfigPath(candidate, stateDir)].map((value) =>
      resolvePathViaExistingAncestorSync(value),
    );
  };
  const before = selection(env);
  if (selection(serviceEnv).some((value, index) => value !== before[index])) {
    throw new Error(
      "Doctor and the managed Gateway select different config or state directories. Run doctor with the Gateway's installation and profile; the service was left unchanged.",
    );
  }
}

export async function beginDoctorMaintenance(params: {
  options: DoctorOptions;
  root: string | null;
  runtime: RuntimeEnv;
}): Promise<{ release(): Promise<void>; finish(cfg: OpenClawConfig): Promise<void> } | undefined> {
  if (!(params.options.repair === true || params.options.yes === true)) {
    return undefined;
  }
  const env = { ...process.env };
  if (!(await needsDoctorMaintenance(env))) {
    return undefined;
  }
  let stopped: PreManagedServiceStop | undefined;
  const coordinators: Array<{ release(): void }> = [];
  const release = async () => {
    for (const coordinator of coordinators.splice(0).toReversed()) {
      coordinator.release();
    }
    const recovery = stopped?.windowsTaskAutoStartRecovery;
    try {
      await maybeResumeWindowsTaskAutoStartAfterPackageUpdate(stopped);
    } finally {
      recovery?.complete();
    }
  };
  try {
    if (
      params.root &&
      !isServiceRepairExternallyManaged() &&
      (await shouldManageGatewayService(env))
    ) {
      const inspection = await maybeStopManagedServiceBeforeMutableUpdate({
        updateInstallKind: "package",
        root: params.root,
        shouldRestart: true,
        jsonMode: true,
        phase: "inspect",
      });
      if (inspection.serviceEnv) {
        assertDoctorServiceSelection(env, inspection.serviceEnv);
      }
      if (inspection.serviceUpdateVerdict?.kind === "owned") {
        // Doctor never rewrites the launcher: pin its complete definition through
        // stop and restart, including operator-owned environment overrides.
        inspection.serviceUpdateVerdict.refreshDefinition = false;
        stopped = await maybeStopManagedServiceBeforeMutableUpdate({
          updateInstallKind: "package",
          root: params.root,
          shouldRestart: true,
          jsonMode: true,
          expectedService: inspection,
        });
        if (stopped.blockMessage) {
          throw new Error(stopped.blockMessage);
        }
        if (stopped.stopped) {
          params.runtime.log("Stopped the managed Gateway for Doctor state migration.");
        }
      }
    }
    const databasePath = path.resolve(resolveOpenClawStateSqlitePath(env));
    // Hold the reentrant lifecycle coordinators, not an in-tree Gateway lock:
    // individual migrations acquire their own in-tree locks under this scope.
    coordinators.push(acquireGatewayLifecycleCoordinator({ databasePath, busyTimeoutMs: 250 }));
    coordinators.push(acquireStateDatabaseCoordinator({ databasePath, busyTimeoutMs: 250 }));
  } catch (error) {
    await release();
    throw new Error(
      `Doctor could not enter maintenance. Stop the Gateway through its service owner, then run ${formatCliCommand("openclaw doctor --fix", env)}. ${String(error)}`,
      { cause: error },
    );
  }
  return {
    release,
    async finish(cfg) {
      await release();
      if (!stopped?.stopped || !stopped.serviceEnv || !params.root) {
        return;
      }
      const service = resolveGatewayService();
      const state = await readGatewayServiceState(service, {
        env: stopped.serviceEnv,
        requireEffective: true,
      });
      assertDoctorServiceSelection(env, state.env);
      await revalidateManagedGatewayServiceAfterUpdate({
        state,
        root: params.root,
        preManagedServiceStop: stopped,
      });
      await service.restart({ env: state.env, stdout: process.stdout, preserveDefinition: true });
      const port = await resolveUpdatedGatewayRestartPort({
        config: cfg,
        serviceEnv: state.env,
        serviceCommand: state.command,
      });
      const health = await waitForGatewayHealthyRestart({
        service,
        port,
        env: state.env,
        requireRunningService: true,
      });
      if (!health.healthy) {
        throw new Error(
          `Doctor repaired state, but the managed Gateway did not become ready: ${renderRestartDiagnostics(health).join(" ")}. Run ${formatCliCommand("openclaw gateway status --deep", env)}.`,
        );
      }
      params.runtime.log("Gateway restarted and verified after Doctor state migration.");
    },
  };
}
