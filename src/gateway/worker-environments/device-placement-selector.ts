import type { EnvironmentSummary } from "../../../packages/gateway-protocol/src/index.js";
import type { DevicePlacementRequirement } from "../../agents/harness/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { NodeRegistry } from "../node-registry.js";
import { resolveDevicePlacementEligibility } from "./device-placement-eligibility.js";
import { deviceUnavailableText } from "./device-provider.js";

type DevicePlacementCandidate = {
  deviceId: string;
  availableSlots: number;
};

type DevicePlacementSelection =
  | { ok: true; candidates: DevicePlacementCandidate[] }
  | { ok: false; error: string };

export async function selectDevicePlacementCandidates(params: {
  environments: readonly EnvironmentSummary[];
  nodeRegistry: Pick<NodeRegistry, "get">;
  environmentService: object | undefined;
  requirement: DevicePlacementRequirement | undefined;
  runtimeId: string;
  config: OpenClawConfig;
}): Promise<DevicePlacementSelection> {
  const { requirement } = params;
  if (!requirement) {
    return {
      ok: false,
      error: `runtime ${params.runtimeId} does not support paired-device placement; select a compatible runtime or cloud worker provider`,
    };
  }

  const nodes = params.environments
    .filter((environment) => environment.type === "node")
    .toSorted((left, right) => left.id.localeCompare(right.id));
  const outdated = nodes.find((node) =>
    node.issues?.some((issue) => issue.code === "update-required"),
  );
  const hosts = nodes.filter((node) => node.sessionHost === true);
  if (hosts.length === 0) {
    if (outdated) {
      return {
        ok: false,
        error: deviceUnavailableText(outdated.id.slice("node:".length), {
          available: false,
          issue: outdated.issues?.[0],
        }),
      };
    }
    return {
      ok: false,
      error:
        "no paired session-host nodes are available; pair a node, enable session hosting, then retry",
    };
  }

  const connected = hosts.filter((node) => node.status === "available");
  if (connected.length === 0) {
    const deviceId = hosts[0]!.id.slice("node:".length);
    return {
      ok: false,
      error: `all paired session-host nodes are disconnected; ${deviceUnavailableText(deviceId, {
        available: false,
        unavailableReason: "disconnected",
      })}`,
    };
  }

  const attempts = await Promise.all(
    connected
      .filter((node) => !node.issues?.some((issue) => issue.code === "update-required"))
      .map(async (node) => {
        const deviceId = node.id.slice("node:".length);
        const eligibility = await resolveDevicePlacementEligibility({
          environmentService: params.environmentService,
          deviceId,
          runtimeId: params.runtimeId,
          requirement,
          config: params.config,
          currentNode: params.nodeRegistry.get(deviceId),
        });
        return {
          deviceId,
          availableSlots: node.workerSlots?.available ?? 0,
          eligibility,
        };
      }),
  );
  const candidates = attempts
    .filter((attempt) => attempt.eligibility.ok)
    .map(({ deviceId, availableSlots }) => ({ deviceId, availableSlots }))
    .toSorted(
      (left, right) =>
        (requirement.consumesWorkerSlot ? right.availableSlots - left.availableSlots : 0) ||
        left.deviceId.localeCompare(right.deviceId),
    );

  if (candidates.length > 0) {
    return { ok: true, candidates };
  }
  if (attempts.length === 0 && outdated) {
    return {
      ok: false,
      error: deviceUnavailableText(outdated.id.slice("node:".length), {
        available: false,
        issue: outdated.issues?.[0],
      }),
    };
  }
  const atCapacity =
    requirement.consumesWorkerSlot && attempts.every(({ availableSlots }) => availableSlots === 0);
  if (atCapacity) {
    return {
      ok: false,
      error: `all paired session-host nodes are at capacity; ${deviceUnavailableText(
        attempts[0]!.deviceId,
        { available: false, unavailableReason: "at-capacity" },
      )}`,
    };
  }
  const failed = attempts.find(({ eligibility }) => !eligibility.ok);
  return {
    ok: false,
    error:
      failed && !failed.eligibility.ok
        ? failed.eligibility.error
        : "no paired session-host node supports this runtime; check node commands and reconnect an eligible host",
  };
}
