import { html, type ReactiveController, type TemplateResult } from "lit";
import type { OpenClawLitElement } from "../lit/openclaw-element.ts";
import { icons } from "./icons.ts";

type FullscreenControllerOptions = {
  section: () => HTMLElement | null;
  onChange: () => void;
  onError?: (message: string) => void;
  enterLabel: () => string;
  exitLabel: () => string;
  unavailableLabel: () => string;
  errorMessage: (error: unknown) => string;
  buttonClass: string;
  buttonSelector: string;
  iconClass: string;
};

export class FullscreenController implements ReactiveController {
  active = false;
  errorText: string | null = null;

  private restoreFocus = false;
  private readonly onFullscreenChange = () => this.handleFullscreenChange();

  constructor(
    private readonly host: OpenClawLitElement,
    private readonly options: FullscreenControllerOptions,
  ) {
    host.addController(this);
  }

  hostConnected(): void {
    document.addEventListener("fullscreenchange", this.onFullscreenChange);
  }

  hostDisconnected(): void {
    document.removeEventListener("fullscreenchange", this.onFullscreenChange);
    this.restoreFocus = false;
    if (this.fullscreenElement() === this.options.section()) {
      void document.exitFullscreen().catch(() => {});
    }
  }

  renderButton(): TemplateResult {
    const supported = this.supported();
    const label = this.active
      ? this.options.exitLabel()
      : supported
        ? this.options.enterLabel()
        : this.options.unavailableLabel();
    return html`<openclaw-tooltip .content=${label}>
      <button
        class=${this.options.buttonClass}
        type="button"
        aria-label=${label}
        aria-pressed=${this.active ? "true" : "false"}
        aria-disabled=${supported ? "false" : "true"}
        @click=${() => void this.toggle()}
      >
        <span class=${this.options.iconClass} aria-hidden="true">
          ${this.active ? icons.minimize : icons.maximize}
        </span>
      </button>
    </openclaw-tooltip>`;
  }

  async exit(): Promise<void> {
    if (!this.active) {
      return;
    }
    try {
      await document.exitFullscreen();
    } catch (error) {
      this.setError(this.options.errorMessage(error));
    }
  }

  private fullscreenElement(): Element | null {
    const shadowFullscreen =
      this.host.renderRoot instanceof ShadowRoot ? this.host.renderRoot.fullscreenElement : null;
    return shadowFullscreen ?? document.fullscreenElement;
  }

  private supported(): boolean {
    return document.fullscreenEnabled && typeof Element.prototype.requestFullscreen === "function";
  }

  private handleFullscreenChange(): void {
    const wasActive = this.active;
    this.active = this.fullscreenElement() === this.options.section();
    this.options.onChange();
    this.host.requestUpdate();
    if (wasActive && !this.active && this.restoreFocus) {
      // Escape and browser controls exit outside the component. Restore focus so
      // keyboard operators return to the control that changed the viewport.
      void this.host.updateComplete.then(() => {
        this.host.renderRoot.querySelector<HTMLButtonElement>(this.options.buttonSelector)?.focus();
        this.restoreFocus = false;
      });
    }
  }

  private async toggle(): Promise<void> {
    this.setError(null);
    if (this.active) {
      await this.exit();
      return;
    }
    const section = this.options.section();
    if (!section || !this.supported()) {
      this.setError(this.options.unavailableLabel());
      return;
    }
    this.restoreFocus = true;
    try {
      await section.requestFullscreen();
    } catch (error) {
      this.restoreFocus = false;
      this.setError(this.options.errorMessage(error));
    }
  }

  private setError(errorText: string | null): void {
    this.errorText = errorText;
    if (errorText) {
      this.options.onError?.(errorText);
    }
    this.host.requestUpdate();
  }
}
