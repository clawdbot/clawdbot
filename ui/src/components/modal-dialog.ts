// Control UI adapter for Web Awesome's accessible modal dialog.
import "@awesome.me/webawesome/dist/components/dialog/dialog.js";
import type WaDialog from "@awesome.me/webawesome/dist/components/dialog/dialog.js";
import { css, html, type PropertyValues } from "lit";
import { property, query } from "lit/decorators.js";
import { OpenClawLitElement } from "../lit/openclaw-element.ts";

const modalToastLayers = (document.openClawModalToastLayers ??= new Set<HTMLElement>());

function setModalToastLayer(modal: HTMLElement, open: boolean) {
  modalToastLayers.delete(modal);
  if (open) {
    modalToastLayers.add(modal);
  }
}

export class OpenClawModalDialog extends OpenClawLitElement {
  @property({ type: Boolean }) open = true;
  @property({ type: Boolean, reflect: true }) manual = false;
  @property() label = "";
  @property() description = "";

  @query("wa-dialog") private webAwesomeDialog?: WaDialog;

  private returnFocus: HTMLElement | null = null;
  private returnFocusOverride: HTMLElement | null | undefined;
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
      max-width: calc(100vw - 20px);
      max-height: calc(100dvh - 20px);
    }

    :host(.palette) wa-dialog::part(dialog) {
      margin-block-start: min(20dvh, 160px);
      margin-block-end: auto;
    }

    :host(.drawer) wa-dialog {
      --width: min(var(--openclaw-modal-width, 100vw), 100vw);
    }

    :host(.drawer) wa-dialog::part(dialog) {
      height: 100dvh;
      max-width: 100vw;
      max-height: 100dvh;
      margin: 0 0 0 auto;
      border-radius: 0;
    }

    :host(.nav-drawer) wa-dialog {
      --width: min(86vw, 320px);
    }

    :host(.nav-drawer) wa-dialog::part(dialog) {
      max-width: min(86vw, 320px);
      margin: 0 auto 0 0;
    }

    :host(.nav-drawer) wa-dialog::part(body) {
      display: flex;
      flex-direction: column;
      min-height: 0;
    }

    ::slotted(.shell-nav-modal__content) {
      display: flex;
      flex: 1 1 auto;
      flex-direction: column;
      height: 100%;
      min-height: 0;
      min-width: 0;
    }

    @media (max-width: 640px) {
      wa-dialog {
        --width: min(var(--openclaw-modal-width, 540px), calc(100vw - 24px));
      }

      wa-dialog::part(dialog) {
        max-width: var(--openclaw-modal-max-width, calc(100vw - 24px));
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
    setModalToastLayer(this, false);
    this.syncGeneration += 1;
    const webAwesomeDialog = this.webAwesomeDialog;
    const dialog = webAwesomeDialog?.shadowRoot?.querySelector("dialog");
    if (dialog?.open) {
      dialog.close();
    }
    if (webAwesomeDialog) {
      webAwesomeDialog.open = false;
    }
    const returnFocus =
      this.returnFocusOverride === undefined ? this.returnFocus : this.returnFocusOverride;
    this.returnFocus = null;
    this.returnFocusOverride = undefined;
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

  protected override updated(changed: PropertyValues<this>) {
    if (changed.has("open")) {
      setModalToastLayer(this, this.open);
    }
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

  private handleAfterShow = (event?: Event) => {
    if (event && event.target !== event.currentTarget) {
      return;
    }
    if (!this.isConnected) {
      return;
    }
    // Both the scheduled show hook and wa-after-show land here, and the second
    // arrives after the open animation. If focus already moved to a slotted
    // field (user click, autofill, e2e input), refocusing the autofocus target
    // would steal it mid-typing; `this` means focus sits on dialog chrome.
    const active = document.activeElement;
    if (active instanceof HTMLElement && active !== this && this.contains(active)) {
      return;
    }
    const autofocusTarget = this.querySelector<HTMLElement>("[autofocus]");
    autofocusTarget?.focus({ preventScroll: true });
  };

  private handleShow = (event: Event) => {
    if (event.target !== event.currentTarget) {
      return;
    }
    // Web Awesome cannot see autofocus targets through this adapter's slot.
    queueMicrotask(() => requestAnimationFrame(() => this.handleAfterShow()));
  };

  private handleAfterHide = (event: Event) => {
    if (event.target !== event.currentTarget) {
      return;
    }
    const returnFocus = this.returnFocusOverride;
    const originalReturnFocus = this.returnFocus;
    this.returnFocusOverride = undefined;
    this.open = false;
    this.returnFocus = null;
    if (returnFocus === undefined) {
      return;
    }
    // Web Awesome queues its original-trigger restoration immediately before
    // wa-after-hide; apply the owner's restoration or suppression after it.
    setTimeout(() => {
      if (returnFocus === null) {
        if (originalReturnFocus && document.activeElement === originalReturnFocus) {
          originalReturnFocus.blur();
        }
      } else if (returnFocus.isConnected) {
        returnFocus.focus({ preventScroll: true });
      }
    }, 0);
  };

  private handleHide = (event: Event) => {
    // Nested overlay lifecycle events bubble through the slot; only the
    // dialog's own hide may dismiss or steal focus from its owner.
    if (event.target !== event.currentTarget) {
      return;
    }
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

  setReturnFocusTarget(target: HTMLElement | null) {
    this.returnFocusOverride = target;
  }

  hide() {
    this.open = false;
  }
}

if (!customElements.get("openclaw-modal-dialog")) {
  customElements.define("openclaw-modal-dialog", OpenClawModalDialog);
}

declare global {
  interface Document {
    openClawModalToastLayers?: Set<HTMLElement>;
  }

  interface HTMLElementTagNameMap {
    "openclaw-modal-dialog": OpenClawModalDialog;
  }
}
