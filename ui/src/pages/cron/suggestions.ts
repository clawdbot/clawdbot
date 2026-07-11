/**
 * Curated automation ideas for the cron page.
 *
 * Pure UI data: each card pre-fills the quick-create wizard draft. Nothing
 * here talks to the gateway or adds config surface.
 */

import { html } from "lit";
import { t } from "../../i18n/index.ts";
import { SCHEDULE_PRESETS } from "./quick-create.ts";
import type { CronQuickCreateDraft, DeliveryPresetId, SchedulePresetId } from "./quick-create.ts";

type CronSuggestion = {
  id: string;
  emoji: string;
  nameKey: string;
  taglineKey: string;
  promptKey: string;
  schedulePreset: SchedulePresetId;
  deliveryPreset: DeliveryPresetId;
};

function suggestion(
  id: string,
  emoji: string,
  schedulePreset: SchedulePresetId,
  deliveryPreset: DeliveryPresetId,
): CronSuggestion {
  return {
    id,
    emoji,
    nameKey: `cron.suggestions.ideas.${id}.name`,
    taglineKey: `cron.suggestions.ideas.${id}.tagline`,
    promptKey: `cron.suggestions.ideas.${id}.prompt`,
    schedulePreset,
    deliveryPreset,
  };
}

export const CRON_SUGGESTIONS: CronSuggestion[] = [
  suggestion("repoPulse", "🐙", "weekdays", "notify"),
  suggestion("standupGhostwriter", "👻", "weekdays", "notify"),
  suggestion("hackerNewsScout", "🔭", "every-morning", "notify"),
  suggestion("dependencyRadar", "🛰️", "weekly", "notify"),
  suggestion("watchdog", "🦉", "hourly", "notify"),
  suggestion("polyglotMinute", "🗣️", "every-morning", "notify"),
];

export function suggestionDraft(idea: CronSuggestion): Partial<CronQuickCreateDraft> {
  return {
    prompt: t(idea.promptKey),
    name: t(idea.nameKey),
    schedulePreset: idea.schedulePreset,
    deliveryPreset: idea.deliveryPreset,
  };
}

function scheduleLabel(preset: SchedulePresetId): string {
  const match = SCHEDULE_PRESETS.find((entry) => entry.id === preset);
  return match ? t(match.labelKey) : preset;
}

type CronSuggestionsProps = {
  expanded: boolean;
  busy: boolean;
  onUse: (draft: Partial<CronQuickCreateDraft>) => void;
};

export function renderCronSuggestions(props: CronSuggestionsProps) {
  return html`
    <details class="card cron-ideas" data-test-id="cron-ideas" ?open=${props.expanded}>
      <summary class="cron-ideas__summary">
        <span class="cron-ideas__spark" aria-hidden="true">✨</span>
        <span class="cron-ideas__copy">
          <span class="cron-ideas__title">${t("cron.suggestions.title")}</span>
          <span class="cron-ideas__hint">${t("cron.suggestions.hint")}</span>
        </span>
      </summary>
      <div class="cron-ideas__grid">
        ${CRON_SUGGESTIONS.map(
          (idea) => html`
            <button
              type="button"
              class="cron-idea"
              data-test-id=${`cron-idea-${idea.id}`}
              ?disabled=${props.busy}
              @click=${() => props.onUse(suggestionDraft(idea))}
            >
              <span class="cron-idea__emoji" aria-hidden="true">${idea.emoji}</span>
              <span class="cron-idea__body">
                <span class="cron-idea__name">${t(idea.nameKey)}</span>
                <span class="cron-idea__tagline">${t(idea.taglineKey)}</span>
              </span>
              <span class="cron-idea__footer">
                <span class="chip">${scheduleLabel(idea.schedulePreset)}</span>
                <span class="cron-idea__cta">${t("cron.suggestions.use")}</span>
              </span>
            </button>
          `,
        )}
      </div>
    </details>
  `;
}
