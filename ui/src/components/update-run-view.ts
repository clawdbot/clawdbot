import { html, nothing, type PropertyValues } from "lit";
import { property } from "lit/decorators.js";
import type { UpdateRunRecord, UpdateRunStep } from "../../../src/infra/update-run-record.ts";
import { projectUpdateRun } from "../app/update-run-projection.ts";
import { t } from "../i18n/index.ts";
import { OpenClawLightDomElement } from "../lit/openclaw-element.ts";
import { StreamAutoFollowController } from "../lit/stream-auto-follow-controller.ts";
import "../styles/update-run-view.css";

const STEP_MARKS = {
  completed: "✓",
  in_progress: "◌",
  pending: "○",
  failed: "×",
  skipped: "−",
} as const;
const ORACLE_MARKS = { pass: "✓", warn: "!", fail: "×", pending: "○" } as const;

class UpdateRunView extends OpenClawLightDomElement {
  @property({ attribute: false }) run: UpdateRunRecord | null = null;
  @property({ type: Boolean }) connected = true;

  private readonly streamFollow = new StreamAutoFollowController(this, {
    selector: ".update-run-view__details",
    isEnabled: () => true,
    captureCurrent: () => {
      const runId = this.run?.runId;
      return () => this.isConnected && this.run?.runId === runId;
    },
  });

  override updated(changed: PropertyValues<this>) {
    super.updated(changed);
    if (changed.has("run")) {
      const previous = changed.get("run");
      this.streamFollow.schedule(previous?.runId !== this.run?.runId);
    }
  }

  private renderStep(step: UpdateRunStep, label = step.step) {
    const status = t(`updates.run.step.${step.status}`);
    return html`<li
      class="update-run-view__step update-run-view__step--${step.status}"
      data-step=${step.step}
      data-status=${step.status}
      aria-label=${`${label}: ${status}`}
    >
      <span class="update-run-view__mark" aria-hidden="true">${STEP_MARKS[step.status]}</span>
      <span>${label}</span><span class="update-run-view__step-status">${status}</span>
    </li>`;
  }

  override render() {
    if (!this.run) {
      return nothing;
    }
    const view = projectUpdateRun(this.run, this.connected);
    return html`<section
      class="update-run-view"
      data-run-id=${this.run.runId}
      data-run-status=${this.run.status}
      aria-label=${t("updates.run.title")}
    >
      <header class="update-run-view__heading">
        <h3 role="status" aria-live="polite">${view.headline}</h3>
        <span class="update-run-view__progress">${view.compactLabel}</span>
      </header>
      ${!this.connected && !view.terminal ? html`<p class="update-run-view__connection">${t("updates.run.reconnecting")}</p>` : nothing}
      <ol class="update-run-view__phases" aria-label=${t("updates.run.phases")}>
        ${view.phases.map((phase) => this.renderStep(phase, phase.label))}
      </ol>
      ${
        view.steps.length
          ? html`<details class="update-run-view__step-list">
              <summary>${t("updates.run.steps")}</summary>
              <ol>
                ${view.steps.map((step) => this.renderStep(step))}
              </ol>
            </details>`
          : nothing
      }
      <div class="update-run-view__detail-heading">
        ${t("updates.run.details")}${view.detailStep ? html`<span>${view.detailStep}</span>` : nothing}
      </div>
      <pre
        class="update-run-view__details"
        tabindex="0"
        aria-label=${t("updates.run.details")}
        @scroll=${(event: Event) => this.streamFollow.handleScroll(event)}
      >
${view.details || t("updates.run.noDetails")}</pre>
      <ul class="update-run-view__oracles" aria-label=${t("updates.run.verification")}>
        ${view.oracles.map((oracle) => html`<li data-oracle=${oracle.name} data-state=${oracle.state} class="update-run-view__oracle update-run-view__oracle--${oracle.state}"><span aria-hidden="true">${ORACLE_MARKS[oracle.state]}</span><span>${t(`updates.run.oracle.${oracle.name}`)}</span><small>${t(`updates.run.oracleState.${oracle.state}`)}</small></li>`)}
      </ul>
      ${
        view.terminal
          ? html`<section
              class="update-run-view__report update-run-view__report--${this.run.status}"
              aria-label=${t("updates.run.report")}
            >
              <h4>${view.report.headline}</h4>
              ${view.report.lines.map((line) => html`<p>${line}</p>`)}
            </section>`
          : nothing
      }
    </section>`;
  }
}

if (!customElements.get("openclaw-update-run-view")) {
  customElements.define("openclaw-update-run-view", UpdateRunView);
}
