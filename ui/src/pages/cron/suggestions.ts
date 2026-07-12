/**
 * Curated automation ideas for the Automations page.
 *
 * Pure UI data: each idea prefills the inline create form. Nothing here talks
 * to the gateway or adds config surface.
 */

import { t } from "../../i18n/index.ts";
import type { CronFormState } from "../../lib/cron/index.ts";

export type CronSuggestion = {
  id: string;
  emoji: string;
  nameKey: string;
  taglineKey: string;
  promptKey: string;
  scheduleKey: string;
  schedule: Partial<CronFormState>;
};

// Schedule shapes ported from the retired quick-create presets.
const WEEKDAY_MORNINGS: Partial<CronFormState> = {
  scheduleKind: "cron",
  cronExpr: "0 9 * * 1-5",
};
const EVERY_MORNING: Partial<CronFormState> = { scheduleKind: "cron", cronExpr: "0 8 * * *" };
const WEEKLY: Partial<CronFormState> = { scheduleKind: "cron", cronExpr: "0 9 * * 1" };
const HOURLY: Partial<CronFormState> = {
  scheduleKind: "every",
  everyAmount: "1",
  everyUnit: "hours",
};

function suggestion(
  id: string,
  emoji: string,
  scheduleKey: string,
  schedule: Partial<CronFormState>,
): CronSuggestion {
  return {
    id,
    emoji,
    nameKey: `cron.suggestions.ideas.${id}.name`,
    taglineKey: `cron.suggestions.ideas.${id}.tagline`,
    promptKey: `cron.suggestions.ideas.${id}.prompt`,
    scheduleKey,
    schedule,
  };
}

export const CRON_SUGGESTIONS: CronSuggestion[] = [
  suggestion("repoPulse", "🐙", "cron.suggestions.schedules.weekdayMornings", WEEKDAY_MORNINGS),
  suggestion(
    "standupGhostwriter",
    "👻",
    "cron.suggestions.schedules.weekdayMornings",
    WEEKDAY_MORNINGS,
  ),
  suggestion("hackerNewsScout", "🔭", "cron.suggestions.schedules.everyMorning", EVERY_MORNING),
  suggestion("dependencyRadar", "🛰️", "cron.suggestions.schedules.weekly", WEEKLY),
  suggestion("watchdog", "🦉", "cron.suggestions.schedules.hourly", HOURLY),
  suggestion("polyglotMinute", "🗣️", "cron.suggestions.schedules.everyMorning", EVERY_MORNING),
];

export function suggestionFormPatch(idea: CronSuggestion): Partial<CronFormState> {
  return {
    name: t(idea.nameKey),
    payloadText: t(idea.promptKey),
    payloadKind: "agentTurn",
    sessionTarget: "isolated",
    deliveryMode: "announce",
    wakeMode: "now",
    deleteAfterRun: false,
    enabled: true,
    ...idea.schedule,
  };
}
