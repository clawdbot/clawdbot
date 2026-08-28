import { consume } from "@lit/context";
import { html, nothing } from "lit";
import { state as litState } from "lit/decorators.js";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import { t } from "../../i18n/index.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { PollController } from "../../lit/poll-controller.ts";
import "../../styles/debug.css";
import {
  DEBUG_OVERLAY_SECTIONS,
  type DebugOverlaySectionDescriptor,
  type DebugOverlayStatusSample,
  type DebugOverlayStatusSnapshot,
} from "./debug-overlay-sections.ts";

const DEBUG_OVERLAY_POLL_INTERVAL_MS = 2000;
const DEBUG_OVERLAY_HISTORY_LIMIT = 90;

type SectionState =
  | { status: "loading" }
  | { status: "ready"; value: unknown }
  | { status: "unavailable" };

export class DebugOverlay extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  private context?: ApplicationContext;

  @litState() private open = false;
  @litState() private sections = new Map<string, SectionState>();

  private requestController: AbortController | null = null;
  private requestActive = false;
  private requestGeneration = 0;
  private statusHistory: DebugOverlayStatusSample[] = [];
  private eventLogSource: ApplicationContext["gateway"] | null = null;
  private unsubscribeEventLog: (() => void) | null = null;
  private readonly polling = new PollController(
    this,
    DEBUG_OVERLAY_POLL_INTERVAL_MS,
    () => void this.refreshSections(),
    false,
  );

  override disconnectedCallback(): void {
    this.close();
    super.disconnectedCallback();
  }

  protected override updated(): void {
    if (this.open) {
      this.syncEventLogSubscription();
    }
  }

  toggle(): void {
    if (this.open) {
      this.close();
      return;
    }
    this.open = true;
    this.statusHistory = [];
    document.addEventListener("keydown", this.handleKeydown, true);
    this.syncEventLogSubscription();
    this.sections = new Map(
      DEBUG_OVERLAY_SECTIONS.map((section) => [section.id, { status: "loading" }]),
    );
    void this.refreshSections();
    this.polling.start();
  }

  private readonly handleKeydown = (event: KeyboardEvent): void => {
    if (event.key !== "Escape" || event.defaultPrevented) {
      return;
    }
    event.preventDefault();
    this.close();
  };

  private readonly close = (): void => {
    if (!this.open && !this.requestController && !this.unsubscribeEventLog) {
      return;
    }
    this.open = false;
    this.polling.stop();
    document.removeEventListener("keydown", this.handleKeydown, true);
    this.requestGeneration += 1;
    this.requestController?.abort();
    this.requestController = null;
    this.requestActive = false;
    this.unsubscribeEventLog?.();
    this.unsubscribeEventLog = null;
    this.eventLogSource = null;
  };

  private syncEventLogSubscription(): void {
    const gateway = this.context?.gateway ?? null;
    if (!this.open || gateway === this.eventLogSource) {
      return;
    }
    this.unsubscribeEventLog?.();
    this.eventLogSource = gateway;
    this.unsubscribeEventLog = gateway?.subscribeEventLog(() => this.requestUpdate()) ?? null;
  }

  private async refreshSections(): Promise<void> {
    const gateway = this.context?.gateway;
    const client = gateway?.snapshot.phase === "connected" ? gateway.snapshot.client : null;
    if (!this.open || this.requestActive) {
      return;
    }
    if (!gateway || !client) {
      this.sections = new Map(
        DEBUG_OVERLAY_SECTIONS.map((section) => [section.id, { status: "unavailable" }]),
      );
      return;
    }
    this.requestActive = true;
    const generation = ++this.requestGeneration;
    const controller = new AbortController();
    this.requestController?.abort();
    this.requestController = controller;
    const requests = DEBUG_OVERLAY_SECTIONS.map(async (section): Promise<void> => {
      try {
        const value = await section.load({ client, gateway }, controller.signal);
        this.updateSection(generation, section.id, { status: "ready", value });
      } catch {
        this.updateSection(generation, section.id, { status: "unavailable" });
      }
    });
    await Promise.allSettled(requests);
    if (!this.open || generation !== this.requestGeneration) {
      return;
    }
    this.requestController = null;
    this.requestActive = false;
  }

  private updateSection(generation: number, id: string, state: SectionState): void {
    if (!this.open || generation !== this.requestGeneration) {
      return;
    }
    if (id === "status" && state.status === "ready") {
      // SAFETY: The status descriptor owns this section id and always returns a status snapshot.
      const snapshot = state.value as DebugOverlayStatusSnapshot;
      this.statusHistory = [
        ...this.statusHistory.slice(-(DEBUG_OVERLAY_HISTORY_LIMIT - 1)),
        { at: Date.now(), status: snapshot },
      ];
    }
    const next = new Map(this.sections);
    next.set(id, state);
    this.sections = next;
  }

  private renderSection(section: DebugOverlaySectionDescriptor) {
    const state = this.sections.get(section.id) ?? { status: "loading" };
    return html`
      <section class="debug-overlay__section">
        <h3>${t(section.titleKey)}</h3>
        ${state.status === "loading"
          ? html`<div class="debug-overlay__empty">${t("common.loading")}</div>`
          : state.status === "unavailable"
            ? html`<div class="debug-overlay__empty">${t("debug.overlay.unavailable")}</div>`
            : section.render(state.value, this.statusHistory)}
      </section>
    `;
  }

  override render() {
    if (!this.open) {
      return nothing;
    }
    return html`
      <aside class="debug-overlay" aria-label=${t("debug.overlay.title")}>
        <header class="debug-overlay__header">
          <div>
            <div class="debug-overlay__eyebrow">${t("debug.overlay.eyebrow")}</div>
            <h2>${t("debug.overlay.title")}</h2>
          </div>
          <button
            type="button"
            class="debug-overlay__close"
            aria-label=${t("common.close")}
            @click=${this.close}
          >
            ×
          </button>
        </header>
        <div class="debug-overlay__body">
          ${DEBUG_OVERLAY_SECTIONS.map((section) => this.renderSection(section))}
        </div>
      </aside>
    `;
  }
}

if (!customElements.get("openclaw-debug-overlay")) {
  customElements.define("openclaw-debug-overlay", DebugOverlay);
}
