import crypto from "node:crypto";
import fs from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { backupFleetCell, restoreFleetCell } from "./backup.runtime.js";
import {
  allocateHostPort,
  buildCellEnvironment,
  cellAuthSecretDir,
  cellContainerName,
  cellDataDir,
  cellNetworkName,
  cellOwnerId,
  DEFAULT_FLEET_IMAGE,
  FLEET_ATTEMPT_LABEL,
  FLEET_OWNER_LABEL,
  FLEET_TENANT_LABEL,
  parseEnvAssignments,
  validateCellContainerProfile,
  validateFleetImage,
  validateDiskSize,
  validateTenantId,
  type CellContainerProfile,
  type FleetContainerRuntimeName,
} from "./cell-profile.js";
import {
  createFleetContainerRuntime,
  type FleetContainerInspectResult,
  type FleetContainerRuntime,
} from "./containers.runtime.js";
import { runFleetDoctor } from "./doctor.runtime.js";
import {
  deleteFleetCell,
  getFleetCell,
  listFleetCells,
  reserveFleetCell,
  updateFleetCellImage,
} from "./registry.js";
import {
  assertCurrentReservation,
  assertManagedInspection,
  assertManagedNetwork,
  buildProfileBaseFromInspection,
  cleanupFailedCreateContainer,
  cleanupFailedCreateNetwork,
  detectHostSelinux,
  inspectionState,
  prepareCellConfig,
  prepareCellDirectories,
  probeCellHealth,
  readHostIdentity,
  requireInspectedAttemptId,
  requireInspectedGatewayToken,
  requireCell,
  resolveContainerUser,
  resolvePurgeTarget,
  restorePreviousCell,
  withFleetCellOperation,
  verifyReplacementHealthy,
} from "./service-support.runtime.js";

const OFFICIAL_IMAGE_UID = 1_000;
const OFFICIAL_IMAGE_GID = 1_000;
// Mirrors the compose healthcheck contract: an upgrade commits only after /healthz
// answers. The deadline bounds how long a broken image can hold the cell before
// restore without rolling back slow-booting cells prematurely.
const CELL_VERIFY_TIMEOUT_MS = 60_000;
const CELL_VERIFY_POLL_MS = 1_000;

async function probeLoopbackPort(port: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const server = createServer();
    server.once("error", (error: NodeJS.ErrnoException) => {
      // The probe exists only to catch the one legible failure early (address in
      // use). Anything else - e.g. EACCES on a privileged port an unprivileged CLI
      // cannot bind but a rootful daemon can - defers to the authoritative runtime bind.
      resolve(error.code !== "EADDRINUSE");
    });
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolve(true));
    });
  });
}

export type FleetCreateOptions = {
  tenant: string;
  image?: string;
  runtime?: FleetContainerRuntimeName;
  port?: number;
  memory?: string;
  cpus?: string;
  pidsLimit?: number;
  disk?: string;
  network?: "bridge" | "internal";
  env?: string[];
  gatewayToken?: string;
  start?: boolean;
};

type FleetCreateResult = {
  tenant: string;
  containerName: string;
  port: number;
  image: string;
  runtime: FleetContainerRuntimeName;
  started: boolean;
  token: string;
  tokenNote: string;
  url: string;
  nextStep: string;
};

type FleetListEntry = {
  tenant: string;
  state: string;
  port: number;
  image: string;
  created: string;
};

export type FleetHealthResult =
  | { status: "ok"; url: string; httpStatus: number }
  | { status: "failed"; url: string; error: string; httpStatus?: number }
  | { status: "skipped"; url: string; reason: string };

type FleetStatusResult = {
  tenant: string;
  containerName: string;
  runtime: FleetContainerRuntimeName;
  port: number;
  image: string;
  created: string;
  dataDir: string;
  container: { imageId?: string } & (
    | { state: string; running: boolean; managed: boolean }
    | { state: "missing"; running: false; managed: false }
    | { state: "unknown"; running: false; managed: false; error: string }
  );
  health: FleetHealthResult;
};

export type FleetLifecycleAction = "start" | "stop" | "restart";

export type FleetLogsOptions = {
  tenant: string;
  follow?: boolean;
  tail?: number;
  since?: string;
};

type FleetActionResult = {
  tenant: string;
  action: FleetLifecycleAction | "upgrade" | "rm";
  image?: string;
  dataPurged?: boolean;
};

type FleetServiceOptions = {
  env?: NodeJS.ProcessEnv;
  containers?: FleetContainerRuntime;
  fetch?: typeof fetch;
  now?: () => number;
  generateToken?: () => string;
  generateAttemptId?: () => string;
  getuid?: () => number | undefined;
  getgid?: () => number | undefined;
  sleep?: (ms: number) => Promise<void>;
  probePort?: (port: number) => Promise<boolean>;
  selinuxEnabled?: () => Promise<boolean>;
  updateImage?: typeof updateFleetCellImage;
};

export function createFleetService(options: FleetServiceOptions = {}) {
  const env = options.env ?? process.env;
  const containers = options.containers ?? createFleetContainerRuntime();
  const fetchImpl = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const { generateToken = () => crypto.randomBytes(16).toString("hex") } = options;
  const generateAttemptId =
    options.generateAttemptId ?? (() => crypto.randomBytes(16).toString("hex"));
  const getuid = options.getuid ?? (() => process.getuid?.());
  const getgid = options.getgid ?? (() => process.getgid?.());
  const sleep =
    options.sleep ??
    ((ms: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
      }));
  const selinuxEnabled = options.selinuxEnabled ?? detectHostSelinux;
  const updateImage = options.updateImage ?? updateFleetCellImage;
  const probePort = options.probePort ?? probeLoopbackPort;

  return {
    async create(createOptions: FleetCreateOptions): Promise<FleetCreateResult> {
      const tenantId = validateTenantId(createOptions.tenant);
      const image = validateFleetImage(createOptions.image ?? DEFAULT_FLEET_IMAGE);
      const runtime = createOptions.runtime ?? "docker";
      const network = createOptions.network ?? "bridge";
      const diskSize =
        createOptions.disk === undefined ? undefined : validateDiskSize(createOptions.disk);
      const { gatewayToken } = createOptions;
      if (gatewayToken !== undefined && !gatewayToken.trim()) {
        throw new Error("Gateway token must not be empty.");
      }
      const token = gatewayToken ?? generateToken();
      const environment = buildCellEnvironment(token, parseEnvAssignments(createOptions.env ?? []));
      const attemptId = generateAttemptId();
      await containers.assertLocal(runtime);
      if (network === "internal" && runtime === "docker") {
        throw new Error(
          "Docker cannot publish loopback ports for containers on --internal networks, so the cell Gateway's 127.0.0.1 port would be unreachable and health-gated operations would always fail. Use --runtime podman for internal cells, or keep the default bridge network and enforce Docker egress policy with host firewall rules (DOCKER-USER chain).",
        );
      }
      return await withFleetCellOperation({
        env,
        tenantId,
        operationName: "create",
        operation: async (checkpoint) => {
          checkpoint();
          const stateDir = resolveStateDir(env);
          const usedPorts = new Set(listFleetCells(env).map((cell) => cell.hostPort));
          const reservation = {
            tenantId,
            createdAtMs: now(),
            image,
            runtime,
            containerName: cellContainerName(tenantId),
            dataDir: cellDataDir(stateDir, tenantId),
          };
          let record: ReturnType<typeof reserveFleetCell> | undefined;
          if (createOptions.port !== undefined) {
            const candidatePort = allocateHostPort(usedPorts, createOptions.port);
            if (!(await probePort(candidatePort))) {
              throw new Error(
                `Host port ${candidatePort} is already in use on 127.0.0.1 by another process.`,
              );
            }
            // The probe is best-effort UX; the runtime bind remains authoritative across this TOCTOU gap.
            record = reserveFleetCell(env, { ...reservation, requestedPort: candidatePort });
          } else {
            const unavailablePorts = new Set(usedPorts);
            // The exclusion set only grows, so this terminates: allocateHostPort throws
            // its range-exhaustion error once every port through 65535 is excluded.
            while (!record) {
              for (const cell of listFleetCells(env)) {
                unavailablePorts.add(cell.hostPort);
              }
              const candidate = allocateHostPort(unavailablePorts);
              if (!(await probePort(candidate))) {
                unavailablePorts.add(candidate);
                continue;
              }
              try {
                // The probe is best-effort UX; the runtime bind remains authoritative across this TOCTOU gap.
                record = reserveFleetCell(env, { ...reservation, requestedPort: candidate });
              } catch (error) {
                if (getFleetCell(env, tenantId)) {
                  throw error;
                }
                const candidateWasReserved = listFleetCells(env).some(
                  (cell) => cell.hostPort === candidate,
                );
                if (!candidateWasReserved) {
                  throw error;
                }
                unavailablePorts.add(candidate);
              }
            }
          }

          let result: FleetCreateResult;
          let networkAttempted = false;
          let containerAttempted = false;
          try {
            const authSecretDir = cellAuthSecretDir(stateDir, tenantId);
            const hostIdentity = readHostIdentity(getuid, getgid);
            const containerUser = await resolveContainerUser({
              runtime,
              containers,
              hostIdentity,
            });
            const imageOwner =
              hostIdentity?.uid === 0 && !containerUser
                ? { uid: OFFICIAL_IMAGE_UID, gid: OFFICIAL_IMAGE_GID }
                : undefined;
            const profile: CellContainerProfile = {
              tenantId,
              containerName: record.containerName,
              networkName: cellNetworkName(tenantId),
              image,
              runtime,
              hostPort: record.hostPort,
              dataDir: record.dataDir,
              authSecretDir,
              ownerId: cellOwnerId(record.dataDir),
              attemptId,
              memory: createOptions.memory ?? "2g",
              cpus: createOptions.cpus ?? "2",
              ...(diskSize ? { diskSize } : {}),
              pidsLimit: createOptions.pidsLimit ?? 512,
              environment,
              ...(containerUser ? { containerUser } : {}),
              selinuxRelabel: await selinuxEnabled(),
            };
            validateCellContainerProfile(profile);
            checkpoint();
            await prepareCellDirectories(record, authSecretDir, imageOwner);
            assertCurrentReservation(env, record);
            const started = createOptions.start !== false;
            networkAttempted = true;
            checkpoint();
            await containers.createNetwork(
              runtime,
              profile.networkName,
              {
                [FLEET_TENANT_LABEL]: tenantId,
                [FLEET_OWNER_LABEL]: profile.ownerId,
                [FLEET_ATTEMPT_LABEL]: attemptId,
              },
              { internal: network === "internal" },
            );
            assertCurrentReservation(env, record);
            containerAttempted = true;
            checkpoint();
            await containers.run(profile, false);
            assertCurrentReservation(env, record);
            checkpoint();
            await prepareCellConfig(record, imageOwner);
            assertCurrentReservation(env, record);
            if (started) {
              checkpoint();
              await containers.start(runtime, record.containerName);
              assertCurrentReservation(env, record);
            }
            const url = `http://127.0.0.1:${record.hostPort}`;
            result = {
              tenant: tenantId,
              containerName: record.containerName,
              port: record.hostPort,
              image,
              runtime,
              started,
              token,
              tokenNote: "Shown once. Store this Gateway token securely.",
              url,
              nextStep: `Open ${url}, then configure per-tenant channel accounts inside the cell.`,
            };
          } catch (error) {
            let releaseReservation = true;
            try {
              if (containerAttempted) {
                releaseReservation = await cleanupFailedCreateContainer(
                  record,
                  containers,
                  attemptId,
                  checkpoint,
                );
              }
              if (releaseReservation && networkAttempted) {
                releaseReservation = await cleanupFailedCreateNetwork(
                  record,
                  containers,
                  attemptId,
                  checkpoint,
                );
              }
            } catch {
              releaseReservation = false;
            }
            if (releaseReservation) {
              try {
                checkpoint();
                deleteFleetCell(env, tenantId);
              } catch {
                // Preserve the provisioning error; a stale reservation remains recoverable via fleet list/rm.
              }
            }
            if (
              diskSize &&
              error instanceof Error &&
              /storage[ -]?opt|pquota|backingfs/iu.test(error.message)
            ) {
              throw new Error(
                `Fleet cannot enforce --disk on this container storage backend: ${error.message}. --disk requires Docker overlay2 on XFS with the pquota mount option (or btrfs/zfs storage drivers), or Podman overlay storage on XFS. Retry without --disk or move container storage to a supported filesystem.`,
                { cause: error },
              );
            }
            throw error;
          }
          if (result.started) {
            try {
              await verifyReplacementHealthy({
                containers,
                record,
                attemptId,
                fetchImpl,
                now,
                sleep,
                checkpoint,
                timeoutMs: CELL_VERIFY_TIMEOUT_MS,
                pollMs: CELL_VERIFY_POLL_MS,
                context: "create",
              });
            } catch (error) {
              // Unlike upgrade/restore, create has no previous container to bring back;
              // keep the sick cell (container + registry row) as diagnosable evidence.
              throw new Error(
                `Fleet cell ${tenantId} was created but did not become healthy within 60s; inspect it with \`openclaw fleet status ${tenantId}\` or \`openclaw fleet logs ${tenantId}\`, or remove it with \`openclaw fleet rm ${tenantId} --force\`.`,
                { cause: error },
              );
            }
          }
          return result;
        },
      });
    },

    async list(): Promise<FleetListEntry[]> {
      const records = listFleetCells(env);
      const localityChecks = new Map<FleetContainerRuntimeName, Promise<void>>();
      const inspections = await Promise.all(
        records.map(async (record) => {
          try {
            let locality = localityChecks.get(record.runtime);
            if (!locality) {
              locality = containers.assertLocal(record.runtime);
              localityChecks.set(record.runtime, locality);
            }
            await locality;
            return await containers.inspect(record.runtime, record.containerName);
          } catch (error) {
            return {
              kind: "unavailable" as const,
              state: "unknown" as const,
              error: error instanceof Error ? error.message : String(error),
            };
          }
        }),
      );
      return records.map((record, index) => ({
        tenant: record.tenantId,
        state: inspectionState(
          record,
          inspections[index] ?? {
            kind: "unavailable",
            state: "unknown",
            error: "inspect result missing",
          },
        ),
        port: record.hostPort,
        image: record.image,
        created: new Date(record.createdAtMs).toISOString(),
      }));
    },

    async status(tenant: string): Promise<FleetStatusResult> {
      const record = requireCell(env, tenant);
      let inspection: FleetContainerInspectResult;
      try {
        await containers.assertLocal(record.runtime);
        inspection = await containers.inspect(record.runtime, record.containerName);
      } catch (error) {
        inspection = {
          kind: "unavailable" as const,
          state: "unknown" as const,
          error: error instanceof Error ? error.message : String(error),
        };
      }
      const url = `http://127.0.0.1:${record.hostPort}/healthz`;
      let container: FleetStatusResult["container"];
      let health: FleetHealthResult;
      if (inspection.kind === "ok") {
        const managed =
          inspection.labels[FLEET_TENANT_LABEL] === record.tenantId &&
          inspection.labels[FLEET_OWNER_LABEL] === cellOwnerId(record.dataDir);
        container = {
          state: managed ? inspection.state : "unknown",
          running: inspection.running,
          managed,
          ...(managed ? { imageId: inspection.imageId } : {}),
        };
        health =
          managed && inspection.running
            ? await probeCellHealth({ port: record.hostPort, fetchImpl })
            : {
                status: "skipped",
                url,
                reason: managed ? "container is not running" : "fleet ownership mismatch",
              };
      } else if (inspection.kind === "missing") {
        container = { state: "missing", running: false, managed: false };
        health = { status: "skipped", url, reason: "container is missing" };
      } else {
        container = { state: "unknown", running: false, managed: false, error: inspection.error };
        health = { status: "skipped", url, reason: "container runtime unavailable" };
      }
      return {
        tenant: record.tenantId,
        containerName: record.containerName,
        runtime: record.runtime,
        port: record.hostPort,
        image: record.image,
        created: new Date(record.createdAtMs).toISOString(),
        dataDir: record.dataDir,
        container,
        health,
      };
    },

    async lifecycle(tenant: string, action: FleetLifecycleAction): Promise<FleetActionResult> {
      const tenantId = validateTenantId(tenant);
      await containers.assertLocal(requireCell(env, tenantId).runtime);
      return await withFleetCellOperation({
        env,
        tenantId,
        operationName: action,
        operation: async (checkpoint) => {
          const record = requireCell(env, tenantId);
          await containers.assertLocal(record.runtime);
          assertManagedInspection(
            record,
            await containers.inspect(record.runtime, record.containerName),
          );
          checkpoint();
          await containers[action](record.runtime, record.containerName);
          return { tenant: record.tenantId, action };
        },
      });
    },
    async logs(logOptions: FleetLogsOptions): Promise<void> {
      const record = requireCell(env, validateTenantId(logOptions.tenant));
      await containers.assertLocal(record.runtime);
      // Ownership must be proven before streaming; never stream a foreign name-squatting container.
      const inspection = assertManagedInspection(
        record,
        await containers.inspect(record.runtime, record.containerName),
      );
      const gatewayCredential = inspection.environment.OPENCLAW_GATEWAY_TOKEN;
      // Pin the inspected generation so a concurrent restore cannot redirect the stream.
      await containers.logs(record.runtime, inspection.containerId, {
        follow: logOptions.follow,
        tail: logOptions.tail,
        since: logOptions.since,
        redactValues: gatewayCredential ? [gatewayCredential] : [],
      });
    },

    async upgrade(tenant: string, requestedImage?: string): Promise<FleetActionResult> {
      const tenantId = validateTenantId(tenant);
      const explicitImage =
        requestedImage === undefined ? undefined : validateFleetImage(requestedImage);
      await containers.assertLocal(requireCell(env, tenantId).runtime);
      return await withFleetCellOperation({
        env,
        tenantId,
        operationName: "upgrade",
        operation: async (checkpoint) => {
          const record = requireCell(env, tenantId);
          await containers.assertLocal(record.runtime);
          const inspection = assertManagedInspection(
            record,
            await containers.inspect(record.runtime, record.containerName),
          );
          const image = explicitImage ?? validateFleetImage(record.image);
          // The token is intentionally absent from SQLite; capture container env before removal and replay it.
          const token = requireInspectedGatewayToken(inspection, "upgrade");
          const containerUser = await resolveContainerUser({
            runtime: record.runtime,
            containers,
            hostIdentity: readHostIdentity(getuid, getgid),
            user: inspection.user,
          });
          const previousAttemptId = requireInspectedAttemptId(inspection, "upgrade");
          const nextAttemptId = generateAttemptId();
          const profileBase = buildProfileBaseFromInspection({
            record,
            stateDir: resolveStateDir(env),
            inspection,
            containerUser,
            selinuxRelabel: await selinuxEnabled(),
            token,
            context: "upgrade",
          });
          const oldProfile: CellContainerProfile = {
            ...profileBase,
            image: inspection.imageId,
            attemptId: previousAttemptId,
          };
          const nextProfile: CellContainerProfile = {
            ...profileBase,
            image,
            attemptId: nextAttemptId,
          };
          validateCellContainerProfile(oldProfile);
          validateCellContainerProfile(nextProfile);

          checkpoint();
          await containers.pull(record.runtime, image);
          checkpoint();
          assertManagedNetwork(
            record,
            await containers.inspectNetwork(record.runtime, cellNetworkName(record.tenantId)),
          );
          try {
            if (inspection.running) {
              checkpoint();
              await containers.stop(record.runtime, record.containerName);
            }
            checkpoint();
            await containers.remove(record.runtime, record.containerName, false);
            checkpoint();
            await containers.run(nextProfile, true);
            // `run -d` succeeds once the container launches, and a broken image can stay
            // "running" briefly before crashing. Commit only after the replacement answers
            // /healthz (the image's compose health contract): exit/restart-loop fails fast,
            // and the deadline restores the old cell instead of leaving a dead replacement.
            await verifyReplacementHealthy({
              containers,
              record,
              attemptId: nextAttemptId,
              fetchImpl,
              now,
              sleep,
              checkpoint,
              timeoutMs: CELL_VERIFY_TIMEOUT_MS,
              pollMs: CELL_VERIFY_POLL_MS,
              context: "upgrade",
            });
            checkpoint();
            updateImage(env, record.tenantId, image);
          } catch (error) {
            try {
              await restorePreviousCell({
                record,
                containers,
                oldProfile,
                previousAttemptId,
                nextAttemptId,
                wasRunning: inspection.running,
                checkpoint,
              });
            } catch {
              throw new Error(
                `Fleet upgrade failed for ${record.tenantId}; the previous container could not be restored.`,
                { cause: error },
              );
            }
            throw new Error(
              `Fleet upgrade failed for ${record.tenantId}; the previous container was restored.`,
              { cause: error },
            );
          }
          return { tenant: record.tenantId, action: "upgrade", image };
        },
      });
    },

    async backup(params: { tenant: string; out?: string; maxBytes?: number }) {
      const tenantId = validateTenantId(params.tenant);
      return await withFleetCellOperation({
        env,
        tenantId,
        operationName: "backup",
        operation: async (checkpoint) => {
          checkpoint();
          const record = requireCell(env, tenantId);
          return await backupFleetCell({
            record,
            stateDir: resolveStateDir(env),
            containers,
            now,
            checkpoint,
            out: params.out,
            maxBytes: params.maxBytes,
          });
        },
      });
    },

    async restore(params: { tenant: string; from: string; force?: boolean; maxBytes?: number }) {
      const tenantId = validateTenantId(params.tenant);
      return await withFleetCellOperation({
        env,
        tenantId,
        operationName: "restore",
        operation: async (checkpoint) => {
          const record = requireCell(env, tenantId);
          return await restoreFleetCell({
            record,
            stateDir: resolveStateDir(env),
            containers,
            fetchImpl,
            now,
            sleep,
            checkpoint,
            generateToken,
            generateAttemptId,
            hostIdentity: readHostIdentity(getuid, getgid),
            selinuxRelabel: await selinuxEnabled(),
            from: params.from,
            force: params.force,
            maxBytes: params.maxBytes,
          });
        },
      });
    },

    async doctor(tenant?: string) {
      return await runFleetDoctor({ env, containers, fetchImpl, tenant, getuid, getgid });
    },

    async remove(params: {
      tenant: string;
      force?: boolean;
      purgeData?: boolean;
    }): Promise<FleetActionResult> {
      if (params.purgeData && !params.force) {
        throw new Error("--purge-data requires --force.");
      }
      const tenantId = validateTenantId(params.tenant);
      await containers.assertLocal(requireCell(env, tenantId).runtime);
      return await withFleetCellOperation({
        env,
        tenantId,
        operationName: "rm",
        operation: async (checkpoint) => {
          const record = requireCell(env, tenantId);
          await containers.assertLocal(record.runtime);
          const stateDir = resolveStateDir(env);
          const authSecretDir = cellAuthSecretDir(stateDir, record.tenantId);
          const purgeTargets: string[] = [];
          if (params.purgeData) {
            const dataTarget = await resolvePurgeTarget(
              path.join(stateDir, "fleet", "cells"),
              record.dataDir,
              record.tenantId,
            );
            if (dataTarget) {
              purgeTargets.push(dataTarget);
            }
            const authTarget = await resolvePurgeTarget(
              path.join(stateDir, "fleet", "auth-profile-secrets"),
              authSecretDir,
              record.tenantId,
            );
            if (authTarget) {
              purgeTargets.push(authTarget);
            }
          }
          const inspection = await containers.inspect(record.runtime, record.containerName);
          if (inspection.kind === "unavailable") {
            throw new Error(
              `Cannot inspect ${record.runtime} container for tenant ${record.tenantId}: ${inspection.error}`,
            );
          }
          const networkName = cellNetworkName(record.tenantId);
          const networkInspection = await containers.inspectNetwork(record.runtime, networkName);
          if (networkInspection.kind === "unavailable") {
            throw new Error(
              `Cannot inspect ${record.runtime} network for tenant ${record.tenantId}: ${networkInspection.error}`,
            );
          }
          if (networkInspection.kind === "ok") {
            assertManagedNetwork(record, networkInspection);
          }
          if (inspection.kind === "ok") {
            assertManagedInspection(record, inspection);
            if (inspection.running && !params.force) {
              throw new Error(
                `Fleet cell ${record.tenantId} is running; use --force to remove it.`,
              );
            }
            checkpoint();
            await containers.remove(record.runtime, record.containerName, params.force === true);
          }
          if (networkInspection.kind === "ok") {
            checkpoint();
            await containers.removeNetwork(record.runtime, networkName);
          }
          if (purgeTargets.length > 0) {
            checkpoint();
            await Promise.all(
              purgeTargets.map((target) => fs.rm(target, { recursive: true, force: true })),
            );
          }
          checkpoint();
          deleteFleetCell(env, record.tenantId);
          return {
            tenant: record.tenantId,
            action: "rm",
            dataPurged: params.purgeData === true,
          };
        },
      });
    },
  };
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
