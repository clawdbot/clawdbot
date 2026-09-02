import type { GatewayHelloOk } from "../api/gateway.ts";
import type { UpdateAvailable, UpdateScheduleState } from "../api/types.ts";
import { t } from "../i18n/index.ts";
import { formatCountdown } from "../lib/format.ts";
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

export function formatUpdateCampaignLabel(
  schedule: UpdateScheduleState | null | undefined,
  nowMs = Date.now(),
): string | null {
  const campaign = schedule?.campaign;
  if (!campaign) {
    return null;
  }
  if (campaign.state === "applying") {
    return t("updates.campaign.applying");
  }
  if (campaign.holdUntilMs !== undefined && campaign.holdUntilMs > nowMs) {
    return t("updates.campaign.held", {
      time: formatCountdown(campaign.holdUntilMs, nowMs),
    });
  }
  if (campaign.state === "waiting-for-idle") {
    return t("updates.campaign.waitingForIdle", {
      time: formatCountdown(campaign.forceAtMs, nowMs),
    });
  }
  return t("updates.campaign.countdown", {
    time: formatCountdown(campaign.applyAtMs ?? campaign.forceAtMs, nowMs),
  });
}

export function formatUpdateTargetLabel(
  schedule: UpdateScheduleState | null | undefined,
  updateAvailable: UpdateAvailable | null | undefined,
): string | null {
  const target = schedule?.target;
  const commitsBehind =
    target?.kind === "git" ? target.commitsBehind : updateAvailable?.commitsBehind;
  if (commitsBehind !== undefined) {
    return t(commitsBehind === 1 ? "updates.target.commitBehind" : "updates.target.commitsBehind", {
      count: String(commitsBehind),
    });
  }
  const version = target?.kind === "package" ? target.version : updateAvailable?.latestVersion;
  return version ? t("updates.target.version", { version }) : null;
}

export function isUpdateActionable(
  updateAvailable: UpdateAvailable | null | undefined,
  updateSchedule: UpdateScheduleState | null | undefined,
  updateBusy: boolean,
): boolean {
  const target = updateSchedule?.target;
  return Boolean(
    updateBusy ||
    updateSchedule?.campaign ||
    (updateAvailable && updateAvailable.latestVersion !== updateAvailable.currentVersion) ||
    (updateAvailable?.commitsBehind !== undefined && updateAvailable.commitsBehind > 0) ||
    (target?.kind === "git" && target.commitsBehind > 0),
  );
}
