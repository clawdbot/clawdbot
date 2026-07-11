import { InvalidArgumentError, type Command } from "commander";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";
import { collectOption, parseStrictPositiveIntOption } from "../program/helpers.js";

type FleetRuntimeModule = typeof import("./commands.runtime.js");

const fleetRuntimeLoader = createLazyImportLoader<FleetRuntimeModule>(
  () => import("./commands.runtime.js"),
);

function loadFleetRuntime(): Promise<FleetRuntimeModule> {
  return fleetRuntimeLoader.load();
}

function parseContainerRuntime(value: string): "docker" | "podman" {
  if (value === "docker" || value === "podman") {
    return value;
  }
  throw new InvalidArgumentError("--runtime must be docker or podman.");
}

function parsePort(value: string): number {
  const port = parseStrictPositiveIntOption(value, "--port");
  if (port > 65_535) {
    throw new InvalidArgumentError("--port must be between 1 and 65535.");
  }
  return port;
}

function parseCpus(value: string): string {
  const cpus = Number(value);
  if (!Number.isFinite(cpus) || cpus <= 0) {
    throw new InvalidArgumentError("--cpus must be a positive number.");
  }
  return value;
}

export function registerFleetCli(program: Command): void {
  const fleet = program
    .command("fleet")
    .description("Provision and manage isolated tenant cells (experimental)");

  fleet
    .command("create")
    .description("Create an isolated tenant cell")
    .argument("<tenant>", "Tenant slug")
    .option("--image <ref>", "Container image", "ghcr.io/openclaw/openclaw:latest")
    .option(
      "--runtime <runtime>",
      "Container runtime (docker or podman)",
      parseContainerRuntime,
      "docker",
    )
    .option("--port <port>", "Host loopback port (default: allocate from 19100)", parsePort)
    .option("--memory <limit>", "Container memory limit", "2g")
    .option("--cpus <count>", "Container CPU limit", parseCpus, "2")
    .option(
      "--pids-limit <count>",
      "Container process limit",
      (value: string) => parseStrictPositiveIntOption(value, "--pids-limit"),
      512,
    )
    .option("--env <KEY=VAL>", "Pass an environment variable to the cell", collectOption, [])
    .option("--gateway-token <token>", "Use an existing Gateway token")
    .option("--no-start", "Create the container without starting it")
    .option("--json", "Output JSON", false)
    .action(
      async (
        tenant: string,
        options: {
          image: string;
          runtime: "docker" | "podman";
          port?: number;
          memory: string;
          cpus: string;
          pidsLimit: number;
          env: string[];
          gatewayToken?: string;
          start: boolean;
          json: boolean;
        },
      ) => {
        const runtime = await loadFleetRuntime();
        await runtime.runFleetCreateCommand({ tenant, ...options });
      },
    );

  fleet
    .command("list")
    .alias("ls")
    .description("List tenant cells")
    .option("--json", "Output JSON", false)
    .action(async (options: { json: boolean }) => {
      const runtime = await loadFleetRuntime();
      await runtime.runFleetListCommand(options);
    });

  fleet
    .command("status")
    .description("Show tenant cell status")
    .argument("<tenant>", "Tenant slug")
    .option("--json", "Output JSON", false)
    .action(async (tenant: string, options: { json: boolean }) => {
      const runtime = await loadFleetRuntime();
      await runtime.runFleetStatusCommand({ tenant, ...options });
    });

  fleet
    .command("logs")
    .description("Stream tenant cell container logs")
    .argument("<tenant>", "Tenant slug")
    .option("--follow", "Follow log output", false)
    .option("--tail <count>", "Number of lines to show", (value: string) =>
      parseStrictPositiveIntOption(value, "--tail"),
    )
    .option("--since <value>", "Show logs since a duration or timestamp")
    .action(async (tenant: string, options: { follow: boolean; tail?: number; since?: string }) => {
      const runtime = await loadFleetRuntime();
      await runtime.runFleetLogsCommand({ tenant, ...options });
    });

  for (const action of ["start", "stop", "restart"] as const) {
    fleet
      .command(action)
      .description(`${action[0]?.toUpperCase()}${action.slice(1)} a tenant cell`)
      .argument("<tenant>", "Tenant slug")
      .action(async (tenant: string) => {
        const runtime = await loadFleetRuntime();
        await runtime.runFleetLifecycleCommand({ action, tenant });
      });
  }

  fleet
    .command("upgrade")
    .description("Replace a tenant cell with a freshly pulled image")
    .argument("<tenant>", "Tenant slug")
    .option("--image <ref>", "Replacement image (default: recorded image)")
    .action(async (tenant: string, options: { image?: string }) => {
      const runtime = await loadFleetRuntime();
      await runtime.runFleetUpgradeCommand({ tenant, ...options });
    });

  fleet
    .command("rm")
    .description("Remove a tenant cell")
    .argument("<tenant>", "Tenant slug")
    .option("--purge-data", "Delete the tenant data directory", false)
    .option("--force", "Remove a running cell", false)
    .action(async (tenant: string, options: { purgeData: boolean; force: boolean }) => {
      const runtime = await loadFleetRuntime();
      await runtime.runFleetRemoveCommand({ tenant, ...options });
    });
}
