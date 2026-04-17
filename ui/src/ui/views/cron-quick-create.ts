/**
 * Simplified automation creation flow — Routines-style guided wizard.
 *
 * "What should it do?" → "When should it run?" → "How should it deliver?"
 *
 * Maps to the existing CronFormState fields under the hood.
 */

import { html, nothing } from "lit";
import { icons } from "../icons.ts";
import type { CronFormState } from "../ui-types.ts";

// ── Types ──

export type CronQuickCreateProps = {
  open: boolean;
  step: CronQuickCreateStep;
  draft: CronQuickCreateDraft;
  onDraftChange: (patch: Partial<CronQuickCreateDraft>) => void;
  onStepChange: (step: CronQuickCreateStep) => void;
  onCreate: () => void;
  onCancel: () => void;
};

export type CronQuickCreateStep = "what" | "when" | "how";

export type CronQuickCreateDraft = {
  prompt: string;
  name: string;
  schedulePreset: SchedulePresetId | "custom";
  deliveryPreset: DeliveryPresetId;
};

type SchedulePresetId =
  | "every-morning"
  | "every-evening"
  | "hourly"
  | "weekdays"
  | "weekly"
  | "once";

type DeliveryPresetId = "notify" | "silent" | "isolated";

// ── Presets ──

type SchedulePreset = {
  id: SchedulePresetId;
  label: string;
  icon: string;
  description: string;
};

const SCHEDULE_PRESETS: SchedulePreset[] = [
  { id: "every-morning", label: "Every morning", icon: "🌅", description: "Daily at 8:00 AM" },
  { id: "every-evening", label: "Every evening", icon: "🌙", description: "Daily at 6:00 PM" },
  { id: "hourly", label: "Hourly", icon: "🔄", description: "Every hour" },
  { id: "weekdays", label: "Weekdays", icon: "📅", description: "Mon–Fri at 9:00 AM" },
  { id: "weekly", label: "Weekly", icon: "📆", description: "Every Monday at 9:00 AM" },
  { id: "once", label: "Run once", icon: "⚡", description: "One-time, delete after run" },
];

type DeliveryPreset = {
  id: DeliveryPresetId;
  label: string;
  description: string;
};

const DELIVERY_PRESETS: DeliveryPreset[] = [
  { id: "notify", label: "Notify me", description: "Deliver results to chat" },
  { id: "silent", label: "Silent", description: "Run without notification" },
  { id: "isolated", label: "Independent session", description: "Run in its own session" },
];

// ── Default draft ──

export function createDefaultDraft(): CronQuickCreateDraft {
  return {
    prompt: "",
    name: "",
    schedulePreset: "every-morning",
    deliveryPreset: "notify",
  };
}

function buildDefaultScheduleAt(now = new Date()): string {
  const next = new Date(now);
  next.setHours(next.getHours() + 1, 0, 0, 0);
  const year = next.getFullYear();
  const month = String(next.getMonth() + 1).padStart(2, "0");
  const day = String(next.getDate()).padStart(2, "0");
  const hour = String(next.getHours()).padStart(2, "0");
  const minute = String(next.getMinutes()).padStart(2, "0");
  return `${year}-${month}-${day}T${hour}:${minute}`;
}

// ── Convert draft to CronFormState patch ──

export function draftToCronFormPatch(draft: CronQuickCreateDraft): Partial<CronFormState> {
  const patch: Partial<CronFormState> = {
    name: draft.name || "Automation",
    payloadKind: "agentTurn",
    deleteAfterRun: false,
    scheduleAt: "",
    payloadText: draft.prompt,
    enabled: true,
  };

  // Schedule
  switch (draft.schedulePreset) {
    case "every-morning":
      patch.scheduleKind = "cron";
      patch.cronExpr = "0 8 * * *";
      break;
    case "every-evening":
      patch.scheduleKind = "cron";
      patch.cronExpr = "0 18 * * *";
      break;
    case "hourly":
      patch.scheduleKind = "every";
      patch.everyAmount = "1";
      patch.everyUnit = "hours";
      break;
    case "weekdays":
      patch.scheduleKind = "cron";
      patch.cronExpr = "0 9 * * 1-5";
      break;
    case "weekly":
      patch.scheduleKind = "cron";
      patch.cronExpr = "0 9 * * 1";
      break;
    case "once":
      patch.scheduleKind = "at";
      patch.scheduleAt = buildDefaultScheduleAt();
      patch.deleteAfterRun = true;
      break;
    default:
      break;
  }

  // Delivery
  switch (draft.deliveryPreset) {
    case "notify":
      patch.sessionTarget = "isolated";
      patch.deliveryMode = "announce";
      patch.wakeMode = "now";
      break;
    case "silent":
      patch.sessionTarget = "main";
      patch.deliveryMode = "none";
      patch.wakeMode = "now";
      break;
    case "isolated":
      patch.sessionTarget = "isolated";
      patch.deliveryMode = "none";
      patch.wakeMode = "now";
      break;
  }

  return patch;
}

// ── Step indicators ──

const STEPS: CronQuickCreateStep[] = ["what", "when", "how"];
const STEP_LABELS: Record<CronQuickCreateStep, string> = {
  what: "What",
  when: "When",
  how: "How",
};

function renderStepIndicator(current: CronQuickCreateStep) {
  const currentIdx = STEPS.indexOf(current);
  return html`
    <div class="cqc-steps">
      ${STEPS.map((step, idx) => {
        const state = idx < currentIdx ? "done" : idx === currentIdx ? "active" : "pending";
        return html`
          <div class="cqc-step cqc-step--${state}">
            <span class="cqc-step__dot">${state === "done" ? "✓" : idx + 1}</span>
            <span class="cqc-step__label">${STEP_LABELS[step]}</span>
          </div>
          ${idx < STEPS.length - 1
            ? html`<div class="cqc-step__line cqc-step__line--${state}"></div>`
            : nothing}
        `;
      })}
    </div>
  `;
}

// ── Step renderers ──

function renderWhatStep(props: CronQuickCreateProps) {
  return html`
    <div class="cqc-body">
      <h3 class="cqc-body__heading">What should it do?</h3>
      <p class="cqc-body__hint muted">
        Describe the task in natural language. The agent will run this prompt each time.
      </p>
      <textarea
        class="cqc-textarea"
        placeholder="e.g., Check my inbox for urgent emails and summarize them..."
        rows="4"
        .value=${props.draft.prompt}
        @input=${(e: Event) =>
          props.onDraftChange({ prompt: (e.target as HTMLTextAreaElement).value })}
      ></textarea>
      <div class="cqc-field">
        <label class="cqc-field__label">Name (optional)</label>
        <input
          class="cqc-input"
          type="text"
          placeholder="e.g., Morning inbox check"
          .value=${props.draft.name}
          @input=${(e: Event) =>
            props.onDraftChange({ name: (e.target as HTMLInputElement).value })}
        />
      </div>
    </div>
    <div class="cqc-actions">
      <button class="btn" @click=${props.onCancel}>Cancel</button>
      <button
        class="btn primary"
        ?disabled=${!props.draft.prompt.trim()}
        @click=${() => props.onStepChange("when")}
      >
        Next ${icons.chevronRight}
      </button>
    </div>
  `;
}

function renderWhenStep(props: CronQuickCreateProps) {
  return html`
    <div class="cqc-body">
      <h3 class="cqc-body__heading">When should it run?</h3>
      <p class="cqc-body__hint muted">Pick a schedule. You can fine-tune it later.</p>
      <div class="cqc-preset-grid">
        ${SCHEDULE_PRESETS.map(
          (preset) => html`
            <button
              class="cqc-preset-card ${props.draft.schedulePreset === preset.id
                ? "cqc-preset-card--active"
                : ""}"
              @click=${() => props.onDraftChange({ schedulePreset: preset.id })}
            >
              <span class="cqc-preset-card__icon">${preset.icon}</span>
              <span class="cqc-preset-card__label">${preset.label}</span>
              <span class="cqc-preset-card__desc muted">${preset.description}</span>
            </button>
          `,
        )}
      </div>
    </div>
    <div class="cqc-actions">
      <button class="btn" @click=${() => props.onStepChange("what")}>Back</button>
      <button class="btn primary" @click=${() => props.onStepChange("how")}>
        Next ${icons.chevronRight}
      </button>
    </div>
  `;
}

function renderHowStep(props: CronQuickCreateProps) {
  return html`
    <div class="cqc-body">
      <h3 class="cqc-body__heading">How should it work?</h3>
      <p class="cqc-body__hint muted">Choose how results are delivered.</p>
      <div class="cqc-delivery-options">
        ${DELIVERY_PRESETS.map(
          (preset) => html`
            <label
              class="cqc-radio-card ${props.draft.deliveryPreset === preset.id
                ? "cqc-radio-card--active"
                : ""}"
            >
              <input
                type="radio"
                name="delivery"
                .checked=${props.draft.deliveryPreset === preset.id}
                @change=${() => props.onDraftChange({ deliveryPreset: preset.id })}
              />
              <span class="cqc-radio-card__label">${preset.label}</span>
              <span class="cqc-radio-card__desc muted">${preset.description}</span>
            </label>
          `,
        )}
      </div>
    </div>
    <div class="cqc-actions">
      <button class="btn" @click=${() => props.onStepChange("when")}>Back</button>
      <button class="btn primary" @click=${props.onCreate}>Create ${icons.check}</button>
    </div>
  `;
}

// ── Main render ──

export function renderCronQuickCreate(props: CronQuickCreateProps) {
  if (!props.open) {
    return nothing;
  }

  return html`
    <div class="cqc-container">
      <div class="cqc-header">
        <h2 class="cqc-header__title">${icons.zap} New Automation</h2>
        <button class="cqc-header__close" @click=${props.onCancel}>${icons.x}</button>
      </div>

      ${renderStepIndicator(props.step)}
      ${props.step === "what"
        ? renderWhatStep(props)
        : props.step === "when"
          ? renderWhenStep(props)
          : renderHowStep(props)}
    </div>
  `;
}
