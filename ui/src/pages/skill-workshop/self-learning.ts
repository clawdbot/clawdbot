// Self-learning (skills.workshop.autonomous.enabled) surface for the Workshop
// tab: config read/patch plumbing plus the toggle, pitch, and error renderers.
import { asNullableRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import { html, nothing } from "lit";
import { t } from "../../i18n/index.ts";
import {
  resolveEditableSnapshotConfig,
  type RuntimeConfigCapability,
} from "../../lib/config/index.ts";

export type SkillWorkshopSelfLearning = {
  enabled: boolean;
  busy: boolean;
  error: string | null;
};

const CONFIG_CHANGED_SINCE_LOAD = "config changed since last load";

// Mirrors the gateway default for skills.workshop.autonomous.enabled: absent
// config means self-learning is off. Snapshot sourceConfig/resolved are both
// $include-resolved (src/config/io.ts), so the editable read is display-safe.
function isSelfLearningEnabled(config: Record<string, unknown>): boolean {
  const workshop = asRecord(asRecord(config.skills)?.workshop);
  return asRecord(workshop?.autonomous)?.enabled === true;
}

export function resolveSelfLearning(
  runtimeConfig: RuntimeConfigCapability | undefined,
  busy: boolean,
  error: string | null,
): SkillWorkshopSelfLearning | null {
  const config = resolveEditableSnapshotConfig(runtimeConfig?.state.configSnapshot);
  return config ? { enabled: isSelfLearningEnabled(config), busy, error } : null;
}

/** Patch the canonical config key; returns an error message or null on success. */
export async function setSelfLearningEnabled(
  runtimeConfig: RuntimeConfigCapability,
  enabled: boolean,
): Promise<string | null> {
  const patch = {
    raw: { skills: { workshop: { autonomous: { enabled } } } },
    note: enabled ? "Enable Skill Workshop self-learning" : "Disable Skill Workshop self-learning",
  };
  let patched = await runtimeConfig.patch(patch);
  if (!patched && runtimeConfig.state.lastError?.includes(CONFIG_CHANGED_SINCE_LOAD)) {
    // This scalar toggle is safe to replay after refreshing the optimistic-lock hash.
    // Keep arbitrary merge patches fail-closed: arrays and derived objects may need rebuilding.
    await runtimeConfig.refresh();
    if (runtimeConfig.state.lastError) {
      return runtimeConfig.state.lastError;
    }
    patched = await runtimeConfig.patch(patch);
  }
  if (!patched) {
    return runtimeConfig.state.lastError ?? t("skillWorkshop.selfLearning.updateError");
  }
  await runtimeConfig.refresh();
  return null;
}

export function renderSelfLearningToggle(
  selfLearning: SkillWorkshopSelfLearning | null,
  onToggle: (enabled: boolean) => void,
) {
  if (!selfLearning) {
    return nothing;
  }
  return html`
    <label
      class="sw-revision-session-toggle"
      title=${t("skillWorkshop.header.selfLearningTooltip")}
    >
      <input
        type="checkbox"
        aria-label=${t("skillWorkshop.header.selfLearningAria")}
        .checked=${selfLearning.enabled}
        ?disabled=${selfLearning.busy}
        @change=${(event: Event) => onToggle((event.currentTarget as HTMLInputElement).checked)}
      />
      <span class="sw-revision-session-toggle__track" aria-hidden="true"></span>
      <span class="sw-revision-session-toggle__label"
        >${t("skillWorkshop.header.selfLearning")}</span
      >
    </label>
  `;
}

export function renderSelfLearningPitch(
  selfLearning: SkillWorkshopSelfLearning | null,
  onToggle: (enabled: boolean) => void,
) {
  if (!selfLearning || selfLearning.enabled) {
    return nothing;
  }
  return html`
    <div class="sw-empty-state__selflearn">
      <h3>${t("skillWorkshop.selfLearning.pitchTitle")}</h3>
      <p>${t("skillWorkshop.selfLearning.pitchBody")}</p>
      <button
        type="button"
        class="sw-btn sw-btn--primary ${selfLearning.busy ? "is-busy" : ""}"
        ?disabled=${selfLearning.busy}
        @click=${() => onToggle(true)}
      >
        ${selfLearning.busy
          ? t("skillWorkshop.selfLearning.enabling")
          : t("skillWorkshop.selfLearning.enable")}
      </button>
    </div>
  `;
}

export function renderSelfLearningError(selfLearning: SkillWorkshopSelfLearning | null) {
  if (!selfLearning?.error) {
    return nothing;
  }
  return html`<div class="sw-error" role="status"><span>${selfLearning.error}</span></div>`;
}
