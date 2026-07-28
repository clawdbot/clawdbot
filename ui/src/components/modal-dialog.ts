// Control UI adapter for Web Awesome's accessible modal dialog.
import "@awesome.me/webawesome/dist/components/dialog/dialog.js";
import type WaDialog from "@awesome.me/webawesome/dist/components/dialog/dialog.js";
import { css, html } from "lit";
import { property, query } from "lit/decorators.js";
import { OpenClawLitElement } from "../lit/openclaw-element.ts";

export class OpenClawModalDialog extends OpenClawLitElement {
  @property({ type: Boolean }) open = true;
  @property({ type: Boolean, reflect: true }) manual = false;
  @property() label = "";
  @property() description = "";

  @query("wa-dialog") private webAwesomeDialog?: WaDialog;

  private returnFocus: HTMLElement | null = null;
  private syncGeneration = 0;
  private suppressNextCancel = false;

  static override styles = css`
    :host {
      display: contents;
    }

    wa-dialog {
      --width: min(var(--openclaw-modal-width, 540px), calc(100vw - 48px));
      --spacing: 0;
      --backdrop-filter: blur(4px);
    }

    wa-dialog::part(dialog) {
      max-width: var(--openclaw-modal-max-width, calc(100vw - 48px));
      max-height: var(--openclaw-modal-max-height, calc(100dvh - 48px));
      padding: 0;
      border: 0;
      background: transparent;
      color: var(--text);
      overflow: visible;
    }

    wa-dialog::part(body) {
      padding: 0;
      overflow: visible;
    }

    :host(.fullscreen) wa-dialog {
      --width: calc(100vw - 20px);
    }

    :host(.fullscreen) wa-dialog::part(dialog) {
      max-height: calc(100dvh - 20px);
    }

    :host(.palette) wa-dialog::part(dialog) {
      margin-block-start: min(20dvh, 160px);
      margin-block-end: auto;
    }

    :host(.drawer) wa-dialog::part(dialog) {
      height: 100dvh;
      max-height: 100dvh;
      margin: 0 0 0 auto;
      border-radius: 0;
    }

    @media (max-width: 640px) {
      wa-dialog {
        --width: calc(100vw - 24px);
      }

      wa-dialog::part(dialog) {
        max-height: 90dvh;
      }
    }
  `;

  override connectedCallback() {
    if (this.manual) {
      this.open = false;
    }
    super.connectedCallback();
    void this.updateComplete.then(() => this.syncDialogOpen());
  }

  override disconnectedCallback() {
    this.syncGeneration += 1;
    const webAwesomeDialog = this.webAwesomeDialog;
    const dialog = webAwesomeDialog?.shadowRoot?.querySelector("dialog");
    if (dialog?.open) {
      dialog.close();
    }
    if (webAwesomeDialog) {
      webAwesomeDialog.open = false;
    }
    const returnFocus = this.returnFocus;
    this.returnFocus = null;
    if (returnFocus?.isConnected) {
      returnFocus.focus({ preventScroll: true });
    }
    super.disconnectedCallback();
  }

  override render() {
    return html`
      <wa-dialog
        without-header
        light-dismiss
        .label=${this.label}
        @wa-show=${this.handleShow}
        @wa-after-show=${this.handleAfterShow}
        @wa-after-hide=${this.handleAfterHide}
        @wa-hide=${this.handleHide}
      >
        <slot></slot>
      </wa-dialog>
    `;
  }

  protected override updated() {
    void this.syncAccessibility();
    void this.syncDialogOpen();
  }

  private async syncDialogOpen() {
    const generation = ++this.syncGeneration;
    const webAwesomeDialog = this.webAwesomeDialog;
    if (!webAwesomeDialog) {
      return;
    }
    await webAwesomeDialog.updateComplete;
    if (generation !== this.syncGeneration || !this.isConnected) {
      return;
    }
    const dialog = webAwesomeDialog.shadowRoot?.querySelector("dialog");
    if (this.open) {
      if (dialog?.open) {
        return;
      }
      this.returnFocus =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      webAwesomeDialog.open = true;
      return;
    }
    if (webAwesomeDialog.open || dialog?.open) {
      this.suppressNextCancel = true;
      webAwesomeDialog.open = false;
    }
  }

  private async syncAccessibility() {
    const webAwesomeDialog = this.webAwesomeDialog;
    if (!webAwesomeDialog) {
      return;
    }
    await webAwesomeDialog.updateComplete;
    const dialog = webAwesomeDialog.shadowRoot?.querySelector("dialog");
    if (!dialog) {
      return;
    }
    if (this.label) {
      dialog.setAttribute("aria-label", this.label);
    } else {
      dialog.removeAttribute("aria-label");
    }
    if (this.description) {
      dialog.setAttribute("aria-description", this.description);
    } else {
      dialog.removeAttribute("aria-description");
    }
  }

  private handleAfterShow = () => {
    if (!this.isConnected) {
      return;
    }
    const autofocusTarget = this.querySelector<HTMLElement>("[autofocus]");
    autofocusTarget?.focus({ preventScroll: true });
  };

  private handleShow = () => {
    // Web Awesome cannot see autofocus targets through this adapter's slot.
    queueMicrotask(() => requestAnimationFrame(() => this.handleAfterShow()));
  };

  private handleAfterHide = () => {
    this.open = false;
    this.returnFocus = null;
  };

  private handleHide = (event: Event) => {
    if (this.suppressNextCancel) {
      this.suppressNextCancel = false;
      return;
    }
    const cancelEvent = new CustomEvent("modal-cancel", {
      bubbles: true,
      composed: true,
      cancelable: true,
    });
    this.dispatchEvent(cancelEvent);
    if (cancelEvent.defaultPrevented) {
      event.preventDefault();
    }
  };

  show() {
    this.open = true;
  }

  hide() {
    this.open = false;
  }
}

if (!customElements.get("openclaw-modal-dialog")) {
  customElements.define("openclaw-modal-dialog", OpenClawModalDialog);
}

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-modal-dialog": OpenClawModalDialog;
  }
}
