import type { GatewayHelloOk } from "../api/gateway.ts";
import type { UpdateAvailable, UpdateScheduleState } from "../api/types.ts";
import {
  readUpdateAvailable,
  readUpdateAvailableValue,
  readUpdateSchedule,
  readUpdateScheduleValue,
} from "./update-schedule-dto.ts";

type UpdateScheduleProjection = {
  updateAvailable: UpdateAvailable | null;
  updateSchedule: UpdateScheduleState | null;
  heldUpdateCampaignId: string | null;
  updateCampaignStatusHydrated: boolean;
};

function retainCampaignStatusHydration(
  current: UpdateScheduleState | null,
  next: UpdateScheduleState | null | undefined,
  hydrated: boolean,
): boolean {
  const currentCampaign = current?.campaign;
  const nextCampaign = next?.campaign;
  return (
    !nextCampaign ||
    (hydrated &&
      currentCampaign?.id === nextCampaign.id &&
      currentCampaign.updatedAtMs === nextCampaign.updatedAtMs)
  );
}

export function resolveHeldUpdateCampaignId(
  schedule: UpdateScheduleState | null,
  currentCampaignId: string | null,
): string | null {
  return schedule?.campaign?.holdUntilMs !== undefined ? schedule.campaign.id : currentCampaignId;
}

export function projectConnectedUpdateSnapshot(
  current: UpdateScheduleProjection,
  hello: GatewayHelloOk | null,
): UpdateScheduleProjection {
  const updateSchedule = readUpdateSchedule(hello);
  return {
    updateAvailable: readUpdateAvailable(hello),
    updateSchedule,
    heldUpdateCampaignId: resolveHeldUpdateCampaignId(updateSchedule, current.heldUpdateCampaignId),
    updateCampaignStatusHydrated: retainCampaignStatusHydration(
      current.updateSchedule,
      updateSchedule,
      current.updateCampaignStatusHydrated,
    ),
  };
}

export function projectUpdateAvailableEvent(
  current: UpdateScheduleProjection,
  payload: { updateAvailable?: unknown; schedule?: unknown } | undefined,
): Partial<UpdateScheduleProjection> {
  const updateSchedule =
    payload && Object.hasOwn(payload, "schedule")
      ? readUpdateScheduleValue(payload.schedule)
      : undefined;
  return {
    updateAvailable: readUpdateAvailableValue(payload?.updateAvailable),
    ...(updateSchedule !== undefined
      ? {
          updateSchedule,
          heldUpdateCampaignId: resolveHeldUpdateCampaignId(
            updateSchedule,
            current.heldUpdateCampaignId,
          ),
          updateCampaignStatusHydrated: retainCampaignStatusHydration(
            current.updateSchedule,
            updateSchedule,
            current.updateCampaignStatusHydrated,
          ),
        }
      : {}),
  };
}
