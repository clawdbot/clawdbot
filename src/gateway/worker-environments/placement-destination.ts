import { err, ok, type Result } from "@openclaw/normalization-core/result";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { DEVICE_WORKER_PROVIDER_ID } from "./device-provider.js";
import type { WorkerPlacementDispatchRequest } from "./service-contract.js";

type WorkerPlacementDestination =
  | {
      profileId: string;
      deviceId?: undefined;
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
}): Result<WorkerPlacementDestination, string> {
  const profileId = normalizeOptionalString(params.profileId);
  if (profileId) {
    return Object.hasOwn(params.cfg.cloudWorkers?.profiles ?? {}, profileId)
      ? ok({ profileId })
      : err(`cloud worker profile is not configured: ${profileId}`);
  }
  const deviceId = normalizeOptionalString(params.deviceId);
  if (!deviceId) {
    return err("worker dispatch target is missing");
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
