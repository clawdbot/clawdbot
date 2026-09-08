/** Coordinates explicit Doctor repair with the managed Gateway lifecycle. */
import path from "node:path";
import { formatCliCommand } from "../cli/command-format.js";
import type { PreManagedServiceStop } from "../cli/update-cli/update-command-service-maintenance.js";
import { isDefaultInstallIdentity, resolveConfigPath, resolveStateDir } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolvePathViaExistingAncestorSync } from "../infra/boundary-path.js";
import {
  acquireGatewayLifecycleCoordinator,
  acquireStateDatabaseCoordinator,
} from "../infra/state-database-coordinator.js";
import { DoctorUnreadableStateDatabaseError } from "../infra/state-repair-message.js";
import type { RuntimeEnv } from "../runtime.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import type { DoctorOptions } from "./doctor-prompter.js";
import { isDoctorUpdateRepairMode, resolveDoctorRepairMode } from "./doctor-repair-mode.js";
import {
  isServiceRepairExternallyManaged,
  resolveUpdateParentGatewayActivation,
  shouldManageGatewayService,
} from "./doctor-service-repair-policy.js";

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

function assertDoctorMaintenanceInspection(
  inspection: PreManagedServiceStop,
  env: NodeJS.ProcessEnv,
): void {
  const kind = inspection.serviceUpdateVerdict?.kind;
  // Non-owned services grant no stop authority. The native lifecycle owner
  // must prove them offline before Doctor can repair its own selected state.
  if (
    !inspection.blockMessage &&
    inspection.inspected &&
    (kind === "owned" || kind === "absent" || inspection.offline === true)
  ) {
    return;
  }
  throw new Error(
    kind === "owned" && inspection.blockMessage
      ? inspection.blockMessage
      : `Gateway service ownership or shutdown could not be verified. Run ${formatCliCommand("openclaw gateway status --deep", env)} and stop it through its service owner before retrying.`,
  );
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
  const parentActivation = isDoctorUpdateRepairMode(resolveDoctorRepairMode(params.options))
    ? resolveUpdateParentGatewayActivation(env)
    : undefined;
  // Repair discovery can execute plugins and open writable state. Establish
  // ownership for every explicit repair before running those inspections.
  let stopped: PreManagedServiceStop | undefined;
  let serviceMaintenance:
    | typeof import("../cli/update-cli/update-command-service-maintenance.js")
    | undefined;
  const coordinators: Array<{ release(): void }> = [];
  let repairStoresMayBeOpen = false;
  const release = async () => {
    try {
      if (repairStoresMayBeOpen) {
        repairStoresMayBeOpen = false;
        const [{ closeOpenClawAgentDatabasesAsync }, { closeOpenClawStateDatabaseByPath }] =
          await Promise.all([
            import("../state/openclaw-agent-db.js"),
            import("../state/openclaw-state-db.js"),
          ]);
        // Agent handles release leases through shared state. Close them before
        // handing off the coordinators, or the restarted Gateway sees Doctor as a writer.
        await closeOpenClawAgentDatabasesAsync();
        closeOpenClawStateDatabaseByPath(resolveOpenClawStateSqlitePath(env));
      }
    } finally {
      for (const coordinator of coordinators.splice(0).toReversed()) {
        coordinator.release();
      }
      const recovery = stopped?.windowsTaskAutoStartRecovery;
      try {
        await serviceMaintenance?.maybeResumeWindowsTaskAutoStartAfterPackageUpdate(stopped);
      } finally {
        await recovery?.complete();
      }
    }
  };
  try {
    if (
      params.root &&
      isDefaultInstallIdentity(env) &&
      !isServiceRepairExternallyManaged() &&
      (await shouldManageGatewayService(env))
    ) {
      serviceMaintenance = await import("../cli/update-cli/update-command-service-maintenance.js");
      const { maybeStopManagedServiceBeforeMutableUpdate } = serviceMaintenance;
      const inspection = await maybeStopManagedServiceBeforeMutableUpdate({
        updateInstallKind: "package",
        root: params.root,
        shouldRestart: true,
        jsonMode: true,
        phase: "inspect",
      });
      assertDoctorMaintenanceInspection(inspection, env);
      if (
        parentActivation !== undefined &&
        inspection.serviceUpdateVerdict?.kind !== "absent" &&
        inspection.offline !== true
      ) {
        throw new Error(
          "The update parent owns Gateway activation. Stop the service through its owner before retrying the update; Doctor will not stop or restart it.",
        );
      }
      if (inspection.serviceUpdateVerdict?.kind === "owned") {
        if (inspection.serviceEnv) {
          assertDoctorServiceSelection(env, inspection.serviceEnv);
        }
        // An explicit update policy leaves activation with the parent. Ordinary
        // Doctor pins and restores the same launcher; neither path rewrites it.
        if (parentActivation === undefined) {
          inspection.serviceUpdateVerdict.refreshDefinition = false;
          stopped = await maybeStopManagedServiceBeforeMutableUpdate({
            updateInstallKind: "package",
            root: params.root,
            shouldRestart: true,
            jsonMode: true,
            expectedService: inspection,
          });
          assertDoctorMaintenanceInspection(stopped, env);
          if (stopped.stopped) {
            params.runtime.log("Stopped the managed Gateway for Doctor repair.");
          }
        }
      } else if (inspection.serviceUpdateVerdict?.kind !== "absent") {
        params.runtime.log(
          "The stopped Gateway service was left unchanged; repairing Doctor's selected state only.",
        );
      }
    }
    const databasePath = path.resolve(resolveOpenClawStateSqlitePath(env));
    // Hold the reentrant lifecycle coordinators, not an in-tree Gateway lock:
    // individual migrations acquire their own in-tree locks under this scope.
    // Gateway ownership lasts until that process stops, not for a short transaction.
    coordinators.push(acquireGatewayLifecycleCoordinator({ databasePath, busyTimeoutMs: 0 }));
    coordinators.push(acquireStateDatabaseCoordinator({ databasePath, busyTimeoutMs: 250 }));
    const { assertNoOpenClawAgentDatabaseLeasesReadOnly, OpenClawAgentDatabaseLeaseActiveError } =
      await import("../state/openclaw-agent-db-lease.js");
    try {
      assertNoOpenClawAgentDatabaseLeasesReadOnly({ env });
    } catch (error) {
      if (error instanceof OpenClawAgentDatabaseLeaseActiveError) {
        throw error;
      }
      // Classify unreadable state under the held owners without opening a writer.
      const { preflightOpenClawDatabaseSchemas } =
        await import("../state/openclaw-database-preflight.js");
      const { OPENCLAW_STATE_SCHEMA_VERSION } =
        await import("../state/openclaw-state-db-contract.js");
      const { OPENCLAW_AGENT_SCHEMA_VERSION } =
        await import("../state/openclaw-agent-db-contract.js");
      const schemas = await preflightOpenClawDatabaseSchemas({
        env,
        scope: "state",
        supportedVersions: {
          state: OPENCLAW_STATE_SCHEMA_VERSION,
          agent: OPENCLAW_AGENT_SCHEMA_VERSION,
        },
      });
      const unreadable = schemas.indeterminate.find((database) => database.kind === "state");
      if (unreadable) {
        throw new DoctorUnreadableStateDatabaseError(unreadable.path, unreadable.reason);
      }
      throw error;
    }
    repairStoresMayBeOpen = true;
  } catch (error) {
    await release();
    if (error instanceof DoctorUnreadableStateDatabaseError) {
      throw error;
    }
    throw new Error(
      `Doctor could not enter maintenance. ${String(error)} Stop the Gateway service and other OpenClaw processes using this state, then run ${formatCliCommand("openclaw doctor --fix", env)} from an independent shell.`,
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
      const [
        { readGatewayServiceState, resolveGatewayService },
        { resolveUpdatedGatewayRestartPort },
        { renderRestartDiagnostics, waitForGatewayHealthyRestart },
        { revalidateManagedGatewayServiceAfterUpdate },
      ] = await Promise.all([
        import("../daemon/service.js"),
        import("../cli/update-cli/update-command-service-plan.js"),
        import("../cli/daemon-cli/restart-health.js"),
        import("../cli/update-cli/update-command-service-maintenance.js"),
      ]);
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
      params.runtime.log("Gateway restarted and verified after Doctor repair.");
    },
  };
}
