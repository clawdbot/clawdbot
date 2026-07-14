import type { AgentsListResult } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { currentConfigObject } from "../../lib/config/index.ts";
import {
  getCronJobPayload,
  resolveConfiguredCronModelSuggestions,
  type CronState,
} from "../../lib/cron/index.ts";
import { sortUniqueStrings } from "../../lib/string-coerce.ts";

export const THINKING_SUGGESTIONS = ["off", "minimal", "low", "medium", "high"];
export const TIMEZONE_SUGGESTIONS = [
  "UTC",
  "America/Los_Angeles",
  "America/Denver",
  "America/Chicago",
  "America/New_York",
  "Europe/London",
  "Europe/Berlin",
  "Asia/Tokyo",
];

function unique(values: string[]): string[] {
  return sortUniqueStrings(values.map((value) => value.trim()).filter(Boolean));
}

export function buildCronSuggestions(params: {
  channels: ApplicationContext["channels"]["state"];
  runtimeConfig: ApplicationContext["runtimeConfig"]["state"];
  cron: CronState;
  agentsList: AgentsListResult | null;
  modelSuggestions: string[];
}) {
  const configValue = currentConfigObject(params.runtimeConfig);
  const channel = params.cron.cronForm.deliveryChannel.trim() || "last";
  const agentSuggestions = unique([
    ...(params.agentsList?.agents.map((entry) => entry.id.trim()) ?? []),
    ...params.cron.cronJobs.map((job) =>
      typeof job.agentId === "string" ? job.agentId.trim() : "",
    ),
  ]);
  const modelSuggestions = unique([
    ...params.modelSuggestions,
    ...resolveConfiguredCronModelSuggestions(configValue),
    ...params.cron.cronJobs.map((job) => {
      const payload = getCronJobPayload(job);
      return payload?.kind === "agentTurn" && typeof payload.model === "string"
        ? payload.model.trim()
        : "";
    }),
  ]);
  const jobTargets = params.cron.cronJobs
    .map((job) => (typeof job.delivery?.to === "string" ? job.delivery.to.trim() : ""))
    .filter(Boolean);
  const accountTargets = (
    channel === "last"
      ? Object.values(params.channels.channelsSnapshot?.channelAccounts ?? {}).flat()
      : (params.channels.channelsSnapshot?.channelAccounts?.[channel] ?? [])
  )
    .flatMap((account) => [account.accountId, account.name])
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter(Boolean);
  const deliveryTargets = unique([...jobTargets, ...accountTargets]);
  return {
    agentSuggestions,
    modelSuggestions,
    accountTargets,
    deliveryToSuggestions:
      params.cron.cronForm.deliveryMode === "webhook"
        ? deliveryTargets.filter((value) => /^https?:\/\//i.test(value))
        : deliveryTargets,
  };
}
