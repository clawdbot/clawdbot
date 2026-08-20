import { t } from "../../i18n/index.ts";
import type { DraftEnvironment } from "./discovery.ts";
import { environmentMenuFacts } from "./place-facts.ts";
import { disambiguate } from "./place-labels.ts";

export type DevicePlacementOption = Readonly<{
  deviceId: string;
  label: string;
  subtitle?: string;
  facts: readonly string[];
  selectable: boolean;
  disabledReason?: string;
}>;

function unavailableReason(environment: DraftEnvironment): string | undefined {
  const updateIssue = environment.issues?.find((issue) => issue.code === "update-required");
  if (updateIssue) {
    return t("newSession.nodeUpdateRequired", {
      updateCommand: updateIssue.updateCommand,
      restartCommand: updateIssue.headlessReconnectCommand,
    });
  }
  if (environment.status !== "available") {
    return t("newSession.deviceUnavailable");
  }
  if (environment.sessionHost !== true) {
    return t("newSession.sessionHostingDisabled");
  }
  if (!environment.workerSlots) {
    return t("newSession.deviceCapacityUnavailable");
  }
  return environment.workerSlots.available === 0 ? t("newSession.deviceNoSlots") : undefined;
}

/** One projection owns device presentation, restore eligibility, and submit eligibility. */
export function projectDevicePlacements(
  environments: readonly DraftEnvironment[] | null,
): DevicePlacementOption[] {
  const devices = (environments ?? [])
    .flatMap<DevicePlacementOption>((environment) => {
      if (environment.type !== "node" || !environment.id.startsWith("node:")) {
        return [];
      }
      const deviceId = environment.id.slice("node:".length).trim();
      if (!deviceId) {
        return [];
      }
      const disabledReason = unavailableReason(environment);
      const facts = environmentMenuFacts(environment, {
        connected: environment.status === "available",
      });
      const priorityFacts =
        (environment.issues?.length ?? 0) > 0 || environment.status !== "available" ? 1 : 0;
      const slotFacts = environment.workerSlots ? 1 : 0;
      const insertion = priorityFacts + slotFacts;
      const visibleFacts =
        disabledReason && !facts.includes(disabledReason)
          ? [...facts.slice(0, insertion), disabledReason, ...facts.slice(insertion)].slice(0, 4)
          : facts;
      return [
        {
          deviceId,
          label: environment.label ?? deviceId,
          facts: visibleFacts,
          selectable: disabledReason === undefined,
          ...(disabledReason ? { disabledReason } : {}),
        },
      ];
    })
    .toSorted(
      (left, right) =>
        left.label.localeCompare(right.label) || left.deviceId.localeCompare(right.deviceId),
    );
  const subtitles = disambiguate(devices, (device) => device.label, [
    (device) => device.deviceId.slice(0, 8),
  ]);
  const projected: DevicePlacementOption[] = [];
  for (const [index, device] of devices.entries()) {
    const subtitle = subtitles[index];
    projected.push(subtitle ? { ...device, subtitle } : device);
  }
  return projected;
}

export function findDevicePlacement(
  environments: readonly DraftEnvironment[] | null,
  deviceId: string,
): DevicePlacementOption | undefined {
  return projectDevicePlacements(environments).find((device) => device.deviceId === deviceId);
}
