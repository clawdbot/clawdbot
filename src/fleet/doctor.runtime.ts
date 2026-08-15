import fs from "node:fs/promises";
import { resolveStateDir } from "../config/paths.js";
import {
  cellAuthSecretDir,
  cellNetworkName,
  cellOwnerId,
  FLEET_DISK_LIMIT_LABEL,
  validateDiskSize,
  FLEET_GATEWAY_PORT,
  FLEET_OWNER_LABEL,
  FLEET_TENANT_LABEL,
} from "./cell-profile.js";
import type { FleetContainerRuntime } from "./containers.runtime.js";
import { listFleetCells } from "./registry.js";
import { probeCellHealth, requireCell } from "./service-support.runtime.js";

type FleetDoctorFinding = {
  check: string;
  status: "pass" | "warn" | "fail";
  detail: string;
};

type FleetDoctorCellReport = { tenant: string; findings: FleetDoctorFinding[] };

function finding(
  check: string,
  status: FleetDoctorFinding["status"],
  detail: string,
): FleetDoctorFinding {
  return { check, status, detail };
}

async function directoryFindings(params: {
  check: "data-dir" | "auth-dir";
  dir: string;
  expectedUid?: number;
}): Promise<FleetDoctorFinding[]> {
  try {
    const stat = await fs.lstat(params.dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      return [finding(params.check, "fail", `${params.dir} is not a real directory.`)];
    }
    const findings = [
      (stat.mode & 0o777) === 0o700
        ? finding(params.check, "pass", `${params.dir} is a private 0700 directory.`)
        : finding(
            params.check,
            "fail",
            `${params.dir} has mode 0${(stat.mode & 0o777).toString(8)}; expected 0700.`,
          ),
    ];
    if (
      params.expectedUid !== undefined &&
      params.expectedUid > 0 &&
      stat.uid !== params.expectedUid
    ) {
      findings.push(
        finding(
          `${params.check}-owner`,
          "warn",
          `${params.dir} is owned by uid ${stat.uid}; container uid is ${params.expectedUid}.`,
        ),
      );
    }
    return findings;
  } catch (error) {
    return [
      finding(
        params.check,
        "fail",
        `${params.dir} cannot be inspected: ${error instanceof Error ? error.message : String(error)}.`,
      ),
    ];
  }
}

function diskLimitFinding(
  runtime: "docker" | "podman",
  diskLimit: string,
  applied: string | undefined,
): FleetDoctorFinding {
  try {
    validateDiskSize(diskLimit);
  } catch {
    return finding(
      "disk-limit",
      "fail",
      `Container disk limit label is malformed and would break upgrade/restore replay: ${diskLimit}.`,
    );
  }
  if (runtime === "docker" && applied !== diskLimit) {
    return finding(
      "disk-limit",
      "fail",
      `Container disk limit label is ${diskLimit} but the applied storage option is ${applied ?? "unset"}.`,
    );
  }
  return finding(
    "disk-limit",
    "pass",
    runtime === "docker"
      ? `Container writable-layer disk limit is ${diskLimit}.`
      : `Container writable-layer disk limit was requested as ${diskLimit}; Podman does not expose the applied storage option for verification.`,
  );
}

export async function runFleetDoctor(params: {
  env: NodeJS.ProcessEnv;
  containers: FleetContainerRuntime;
  fetchImpl: typeof fetch;
  tenant?: string;
  getuid?: () => number | undefined;
  getgid?: () => number | undefined;
}): Promise<FleetDoctorCellReport[]> {
  const records = params.tenant
    ? [requireCell(params.env, params.tenant)]
    : listFleetCells(params.env);
  const stateDir = resolveStateDir(params.env);
  return await Promise.all(
    records.map(async (record) => {
      const findings: FleetDoctorFinding[] = [];
      try {
        await params.containers.assertLocal(record.runtime);
        findings.push(
          finding("runtime-local", "pass", `${record.runtime} uses a local container endpoint.`),
        );
      } catch (error) {
        findings.push(
          finding(
            "runtime-local",
            "fail",
            `${record.runtime} locality check failed: ${error instanceof Error ? error.message : String(error)}.`,
          ),
        );
        return { tenant: record.tenantId, findings };
      }

      let inspection;
      try {
        inspection = await params.containers.inspect(record.runtime, record.containerName);
      } catch (error) {
        findings.push(
          finding(
            "container-present",
            "fail",
            `Container inspection failed: ${error instanceof Error ? error.message : String(error)}.`,
          ),
        );
        return { tenant: record.tenantId, findings };
      }
      if (inspection.kind !== "ok") {
        findings.push(
          finding(
            "container-present",
            "fail",
            inspection.kind === "missing"
              ? `Container ${record.containerName} is missing.`
              : `Container inspection failed: ${inspection.error}.`,
          ),
        );
        return { tenant: record.tenantId, findings };
      }
      findings.push(
        finding("container-present", "pass", `Container ${record.containerName} is present.`),
      );
      const owned =
        inspection.labels[FLEET_TENANT_LABEL] === record.tenantId &&
        inspection.labels[FLEET_OWNER_LABEL] === cellOwnerId(record.dataDir);
      findings.push(
        owned
          ? finding(
              "container-owned",
              "pass",
              `Container ownership labels match tenant ${record.tenantId}.`,
            )
          : finding(
              "container-owned",
              "fail",
              `Container ownership labels do not match tenant ${record.tenantId}.`,
            ),
      );
      findings.push(
        inspection.running
          ? finding("container-running", "pass", `Container ${record.containerName} is running.`)
          : finding("container-running", "warn", `Container ${record.containerName} is stopped.`),
      );

      if (owned) {
        if (inspection.running) {
          const health = await probeCellHealth({
            port: record.hostPort,
            fetchImpl: params.fetchImpl,
          });
          findings.push(
            health.status === "ok"
              ? finding(
                  "gateway-health",
                  "pass",
                  `Gateway health check returned HTTP ${health.httpStatus}.`,
                )
              : finding(
                  "gateway-health",
                  "fail",
                  `Gateway health check failed: ${health.status === "failed" ? health.error : health.reason}.`,
                ),
          );
        } else {
          findings.push(
            finding(
              "gateway-health",
              "warn",
              "Gateway health check was skipped because the container is stopped.",
            ),
          );
        }
        // Docker records --cap-drop=ALL literally; Podman expands it into the
        // individual default caps but exposes an empty top-level EffectiveCaps
        // (both shapes verified live). Either representation proves the drop.
        const capsDropped =
          inspection.capDrop.includes("ALL") ||
          (inspection.effectiveCaps !== undefined && inspection.effectiveCaps.length === 0);
        findings.push(
          capsDropped
            ? finding("cap-drop", "pass", "Container drops all Linux capabilities.")
            : finding("cap-drop", "fail", "Container does not drop all Linux capabilities."),
        );
        findings.push(
          inspection.securityOpt.some(
            (option) => option === "no-new-privileges" || option === "no-new-privileges:true",
          )
            ? finding("security-opt", "pass", "Container enables no-new-privileges.")
            : finding("security-opt", "fail", "Container does not enable no-new-privileges."),
        );
        findings.push(
          inspection.init === true
            ? finding("init", "pass", "Container init is enabled.")
            : finding("init", "fail", "Container init is not enabled."),
        );
        for (const [check, value] of [
          ["pids-limit", inspection.pidsLimit],
          ["memory-limit", Number(inspection.memory)],
          ["cpu-limit", Number(inspection.cpus)],
        ] as const) {
          findings.push(
            typeof value === "number" && Number.isFinite(value) && value > 0
              ? finding(check, "pass", `${check} is positive.`)
              : finding(check, "fail", `${check} is missing or invalid.`),
          );
        }
        findings.push(
          inspection.restartPolicy === "unless-stopped"
            ? finding("restart-policy", "pass", "Restart policy is unless-stopped.")
            : finding(
                "restart-policy",
                "fail",
                `Restart policy is ${inspection.restartPolicy ?? "unset"}; expected unless-stopped.`,
              ),
        );
        const expectedPort = String(record.hostPort);
        const binding = inspection.portBindings[0];
        const validBinding =
          inspection.portBindings.length === 1 &&
          binding?.containerPort === `${FLEET_GATEWAY_PORT}/tcp` &&
          binding.hostIp === "127.0.0.1" &&
          binding.hostPort === expectedPort;
        findings.push(
          validBinding
            ? finding("port-binding", "pass", `Gateway port is bound to 127.0.0.1:${expectedPort}.`)
            : finding(
                "port-binding",
                "fail",
                `Gateway port binding must be exactly ${FLEET_GATEWAY_PORT}/tcp to 127.0.0.1:${expectedPort}.`,
              ),
        );
        const diskLimit = inspection.labels[FLEET_DISK_LIMIT_LABEL];
        if (diskLimit !== undefined) {
          // Docker reports the applied quota via HostConfig.StorageOpt; Podman's
          // inspect schema has no such field, so only the label can be checked
          // there. A malformed label would also break upgrade/restore replay.
          findings.push(diskLimitFinding(record.runtime, diskLimit, inspection.storageOpt.size));
        } else if (inspection.storageOpt.size !== undefined) {
          findings.push(
            finding(
              "disk-limit",
              "pass",
              `Container writable-layer disk limit is ${inspection.storageOpt.size}.`,
            ),
          );
        }
        findings.push(
          inspection.environment.OPENCLAW_GATEWAY_TOKEN
            ? finding("gateway-token-env", "pass", "Gateway token environment is present.")
            : finding(
                "gateway-token-env",
                "fail",
                "Gateway token environment is missing or empty.",
              ),
        );
      }

      const networkName = cellNetworkName(record.tenantId);
      const network = await params.containers.inspectNetwork(record.runtime, networkName);
      if (network.kind !== "ok") {
        findings.push(
          finding(
            "network-present",
            "fail",
            network.kind === "missing"
              ? `Network ${networkName} is missing.`
              : `Network inspection failed: ${network.error}.`,
          ),
        );
      } else {
        findings.push(finding("network-present", "pass", `Network ${networkName} is present.`));
        const networkOwned =
          network.labels[FLEET_TENANT_LABEL] === record.tenantId &&
          network.labels[FLEET_OWNER_LABEL] === cellOwnerId(record.dataDir);
        findings.push(
          networkOwned
            ? finding(
                "network-owned",
                "pass",
                `Network ownership labels match tenant ${record.tenantId}.`,
              )
            : finding(
                "network-owned",
                "fail",
                `Network ownership labels do not match tenant ${record.tenantId}.`,
              ),
        );
        // Podman's network inspect omits the containers map entirely (verified
        // live on netavark), so an empty attachment list is not evidence of a
        // missing cell there; only affirmative foreign entries or a Docker
        // report that omits the running cell are drift.
        const foreignAttachments = network.attachedContainers.filter(
          (attachment) => attachment.name !== record.containerName,
        );
        findings.push(
          foreignAttachments.length > 0
            ? finding(
                "network-attachments",
                "fail",
                "Unexpected containers are attached to the cell network.",
              )
            : record.runtime === "docker" &&
                inspection.running &&
                network.attachedContainers.length !== 1
              ? finding(
                  "network-attachments",
                  "fail",
                  "The running cell container is not attached to its network.",
                )
              : finding(
                  "network-attachments",
                  "pass",
                  "No unexpected containers are attached to the network.",
                ),
        );
        findings.push(
          network.internal && record.runtime === "docker"
            ? finding(
                "network-egress",
                "fail",
                "Docker internal networking breaks the published loopback Gateway port.",
              )
            : network.internal
              ? finding("network-egress", "pass", "egress: internal")
              : finding("network-egress", "pass", "egress: bridge (unrestricted)"),
        );
      }

      const userMatch = inspection.user?.match(/^(\d+):(\d+)$/u);
      const expectedUid = userMatch && Number(userMatch[1]) > 0 ? Number(userMatch[1]) : undefined;
      findings.push(
        ...(await directoryFindings({ check: "data-dir", dir: record.dataDir, expectedUid })),
      );
      findings.push(
        ...(await directoryFindings({
          check: "auth-dir",
          dir: cellAuthSecretDir(stateDir, record.tenantId),
          expectedUid,
        })),
      );
      return { tenant: record.tenantId, findings };
    }),
  );
}
