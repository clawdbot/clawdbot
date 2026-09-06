import { err, ok, type Result } from "@openclaw/normalization-core/result";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { DEVICE_WORKER_PROVIDER_ID } from "./device-provider-identity.js";
import type { WorkerPlacementDispatchRequest } from "./service-contract.js";

type WorkerPlacementDestination =
  | {
      profileId: string;
      deviceId?: undefined;
      machineClass?: string;
      inheritedProfile?: undefined;
    }
  | {
      profileId: string;
      deviceId: string;
      inheritedProfile: NonNullable<WorkerPlacementDispatchRequest["inheritedProfile"]>;
    };

export function resolveWorkerPlacementDestination(params: {
  cfg: Pick<OpenClawConfig, "cloudWorkers">;
  profileId?: string;
  deviceId?: string;
  machineClass?: string;
}): Result<WorkerPlacementDestination | undefined, string> {
  const profileId = normalizeOptionalString(params.profileId);
  if (profileId) {
    if (!Object.hasOwn(params.cfg.cloudWorkers?.profiles ?? {}, profileId)) {
      return err(`cloud worker profile is not configured: ${profileId}`);
    }
    const machineClass = normalizeOptionalString(params.machineClass);
    if (params.machineClass !== undefined && !machineClass) {
      return err("cloud worker machine class must be non-empty");
    }
    return ok({ profileId, ...(machineClass ? { machineClass } : {}) });
  }
  const deviceId = normalizeOptionalString(params.deviceId);
  if (!deviceId) {
    return ok(undefined);
  }
  return ok({
    profileId: `device:${deviceId}`,
    deviceId,
    inheritedProfile: {
      providerId: DEVICE_WORKER_PROVIDER_ID,
      profileSnapshot: { install: "bundle", settings: { device: deviceId } },
    },
  });
}
