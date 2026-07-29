// Runtime-backed fleet command handlers and human/JSON output formatting.
import { getTerminalTableWidth, renderTable } from "../../../packages/terminal-core/src/table.js";
import {
  createFleetService,
  type FleetCreateOptions,
  type FleetHealthResult,
  type FleetLifecycleAction,
  type FleetLogsOptions,
} from "../../fleet/service.runtime.js";
import { defaultRuntime } from "../../runtime.js";

const fleetService = createFleetService();

export async function runFleetCreateCommand(
  options: FleetCreateOptions & { json: boolean },
): Promise<void> {
  const result = await fleetService.create(options);
  if (options.json) {
    defaultRuntime.writeJson(result);
    return;
  }
  defaultRuntime.log(`Tenant: ${result.tenant}`);
  defaultRuntime.log(`Container: ${result.containerName}`);
  defaultRuntime.log(`Port: ${result.port}`);
  defaultRuntime.log(`Token: ${result.token}`);
  defaultRuntime.log(result.tokenNote);
  defaultRuntime.log(`Next: ${result.nextStep}`);
}

export async function runFleetBackupCommand(options: {
  tenant: string;
  out?: string;
  maxBytes?: number;
  json: boolean;
}): Promise<void> {
  const result = await fleetService.backup(options);
  if (options.json) {
    defaultRuntime.writeJson(result);
    return;
  }
  defaultRuntime.log(`Archive: ${result.archivePath}`);
  if (result.skippedSymlinks > 0 || result.skippedSpecial > 0) {
    defaultRuntime.log(
      `Skipped ${result.skippedSymlinks} symlink(s) and ${result.skippedSpecial} special file(s); Fleet archives regular files and directories only.`,
    );
  }
  defaultRuntime.log(result.note);
}

export async function runFleetRestoreCommand(options: {
  tenant: string;
  from: string;
  force: boolean;
  maxBytes?: number;
  json: boolean;
}): Promise<void> {
  const result = await fleetService.restore(options);
  if (options.json) {
    defaultRuntime.writeJson(result);
    return;
  }
  defaultRuntime.log(`Tenant: ${result.tenant}`);
  defaultRuntime.log(`Token: ${result.token}`);
  defaultRuntime.log(result.tokenNote);
}

export async function runFleetDoctorCommand(options: {
  tenant?: string;
  json: boolean;
}): Promise<void> {
  const reports = await fleetService.doctor(options.tenant);
  if (options.json) {
    defaultRuntime.writeJson(reports);
  } else {
    for (const report of reports) {
      defaultRuntime.log(`${report.tenant}:`);
      const nonPass = report.findings.filter((entry) => entry.status !== "pass");
      if (nonPass.length === 0) {
        defaultRuntime.log("  ok");
      } else {
        for (const entry of nonPass) {
          defaultRuntime.log(`  [${entry.status}] ${entry.check}: ${entry.detail}`);
        }
      }
    }
    const failures = reports
      .flatMap((report) => report.findings)
      .filter((entry) => entry.status === "fail").length;
    const warnings = reports
      .flatMap((report) => report.findings)
      .filter((entry) => entry.status === "warn").length;
    defaultRuntime.log(
      `Summary: ${reports.length} cell(s), ${failures} failure(s), ${warnings} warning(s).`,
    );
  }
  if (reports.some((report) => report.findings.some((entry) => entry.status === "fail"))) {
    process.exitCode = 1;
  }
}

export async function runFleetListCommand(options: { json: boolean }): Promise<void> {
  const cells = await fleetService.list();
  if (options.json) {
    defaultRuntime.writeJson({ cells });
    return;
  }
  if (cells.length === 0) {
    defaultRuntime.log("No fleet cells.");
    return;
  }
  defaultRuntime.log(
    renderTable({
      width: getTerminalTableWidth(),
      columns: [
        { key: "tenant", header: "Tenant", minWidth: 10, flex: true },
        { key: "state", header: "State", minWidth: 10 },
        { key: "port", header: "Port", minWidth: 7 },
        { key: "image", header: "Image", minWidth: 24, flex: true },
        { key: "created", header: "Created", minWidth: 24 },
      ],
      rows: cells.map((cell) => ({
        tenant: cell.tenant,
        state: cell.state,
        port: String(cell.port),
        image: cell.image,
        created: cell.created,
      })),
    }).trimEnd(),
  );
}

function formatHealth(health: FleetHealthResult): string {
  if (health.status === "ok") {
    return `ok (HTTP ${health.httpStatus})`;
  }
  if (health.status === "failed") {
    return `failed (${health.error})`;
  }
  return `skipped (${health.reason})`;
}

export async function runFleetStatusCommand(options: {
  tenant: string;
  json: boolean;
}): Promise<void> {
  const result = await fleetService.status(options.tenant);
  if (options.json) {
    defaultRuntime.writeJson(result);
    return;
  }
  defaultRuntime.log(`Tenant: ${result.tenant}`);
  defaultRuntime.log(`Container: ${result.containerName}`);
  defaultRuntime.log(`State: ${result.container.state}`);
  defaultRuntime.log(`Port: ${result.port}`);
  defaultRuntime.log(`Image: ${result.image}`);
  defaultRuntime.log(`Created: ${result.created}`);
  defaultRuntime.log(`Data: ${result.dataDir}`);
  defaultRuntime.log(`Health: ${formatHealth(result.health)}`);
}

export async function runFleetLogsCommand(options: FleetLogsOptions): Promise<void> {
  await fleetService.logs(options);
}

export async function runFleetLifecycleCommand(options: {
  tenant: string;
  action: FleetLifecycleAction;
}): Promise<void> {
  const result = await fleetService.lifecycle(options.tenant, options.action);
  defaultRuntime.log(`${result.action} complete for fleet cell ${result.tenant}.`);
}

export async function runFleetUpgradeCommand(options: {
  tenant: string;
  image?: string;
}): Promise<void> {
  const result = await fleetService.upgrade(options.tenant, options.image);
  defaultRuntime.log(`Upgraded fleet cell ${result.tenant} to ${result.image}.`);
}

export async function runFleetRemoveCommand(options: {
  tenant: string;
  purgeData: boolean;
  force: boolean;
}): Promise<void> {
  const result = await fleetService.remove(options);
  defaultRuntime.log(
    result.dataPurged
      ? `Removed fleet cell ${result.tenant} and purged its data.`
      : `Removed fleet cell ${result.tenant}; data retained.`,
  );
}
