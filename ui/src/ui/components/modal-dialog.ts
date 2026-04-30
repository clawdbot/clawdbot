import { LitElement, css, html, nothing } from "lit";
import { property, query } from "lit/decorators.js";
import { ifDefined } from "lit/directives/if-defined.js";

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "summary",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

export class OpenClawModalDialog extends LitElement {
  @property() label = "";
  @property() description = "";

  @query("dialog") private dialogElement?: HTMLDialogElement;
  @query("slot") private slotElement?: HTMLSlotElement;

  private previouslyFocused: Element | null = null;
  private opened = false;

  static styles = css`
    :host {
      position: fixed;
      inset: 0;
      z-index: 200;
      display: block;
      padding: 24px;
      box-sizing: border-box;
      background: rgba(0, 0, 0, 0.8);
      backdrop-filter: blur(4px);
      -webkit-backdrop-filter: blur(4px);
    }

    dialog {
      position: fixed;
      top: 50%;
      left: 50%;
      width: min(540px, calc(100vw - 48px));
      max-height: calc(100dvh - 48px);
      margin: 0;
      padding: 0;
      border: 0;
      background: transparent;
      color: var(--text);
      transform: translate(-50%, -50%);
      overflow: visible;
      outline: none;
    }

    dialog::backdrop {
      background: transparent;
    }

    .visually-hidden {
      position: absolute;
      width: 1px;
      height: 1px;
      margin: -1px;
      padding: 0;
      border: 0;
      overflow: hidden;
      clip: rect(0 0 0 0);
      clip-path: inset(50%);
      white-space: nowrap;
    }

    @media (max-width: 640px) {
      :host {
        padding: 12px;
        padding-bottom: calc(12px + env(safe-area-inset-bottom, 0px));
      }

      dialog {
        width: calc(100vw - 24px);
        max-height: 90dvh;
      }
    }
  `;

  override connectedCallback() {
    super.connectedCallback();
    this.previouslyFocused = this.ownerDocument.activeElement;
  }

  override firstUpdated() {
    this.openDialog();
  }

  override disconnectedCallback() {
    this.closeDialog();
    this.restoreFocus();
    super.disconnectedCallback();
  }

  override render() {
    const labelId = this.label ? "openclaw-modal-dialog-label" : "";
    const descriptionId = this.description ? "openclaw-modal-dialog-description" : "";
    return html`
      <dialog
        role="dialog"
        aria-modal="true"
        aria-labelledby=${ifDefined(labelId || undefined)}
        aria-describedby=${ifDefined(descriptionId || undefined)}
        tabindex="-1"
        @cancel=${this.handleCancel}
        @keydown=${this.handleKeydown}
      >
        ${this.label
          ? html`<span id=${labelId} class="visually-hidden">${this.label}</span>`
          : nothing}
        ${this.description
          ? html`<span id=${descriptionId} class="visually-hidden">${this.description}</span>`
          : nothing}
        <slot></slot>
      </dialog>
    `;
  }

  private openDialog() {
    if (this.opened) {
      return;
    }
    const dialog = this.dialogElement;
    if (!dialog) {
      return;
    }
    this.opened = true;
    if (typeof dialog.showModal === "function") {
      try {
        if (!dialog.open) {
          dialog.showModal();
        }
      } catch {
        if (!dialog.open) {
          dialog.setAttribute("open", "");
        }
      }
    } else if (!dialog.open) {
      dialog.setAttribute("open", "");
    }
    requestAnimationFrame(() => {
      if (!this.isConnected || !this.dialogElement?.open) {
        return;
      }
      this.focusDialog();
    });
  }

  private closeDialog() {
    const dialog = this.dialogElement;
    if (!dialog?.open) {
      return;
    }
    if (typeof dialog.close === "function") {
      dialog.close();
      return;
    }
    dialog.removeAttribute("open");
  }

  private restoreFocus() {
    const target = this.previouslyFocused;
    this.previouslyFocused = null;
    if (!(target instanceof HTMLElement) || !target.isConnected) {
      return;
    }
    requestAnimationFrame(() => {
      if (target.isConnected) {
        target.focus();
      }
    });
  }

  private focusDialog() {
    const dialog = this.dialogElement;
    if (!dialog) {
      return;
    }
    try {
      dialog.focus({ preventScroll: true });
    } catch {
      dialog.focus();
    }
  }

  private handleCancel = (event: Event) => {
    event.preventDefault();
    this.dispatchCancel();
  };

  private handleKeydown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      this.dispatchCancel();
      return;
    }
    if (event.key === "Tab") {
      this.trapFocus(event);
    }
  };

  private trapFocus(event: KeyboardEvent) {
    const focusable = this.getFocusableElements();
    if (focusable.length === 0) {
      event.preventDefault();
      this.focusDialog();
      return;
    }
    const active = this.getActiveElement();
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const focusInside = active ? focusable.includes(active) : false;

    if (event.shiftKey && (!focusInside || active === first || active === this.dialogElement)) {
      event.preventDefault();
      last.focus();
      return;
    }
    if (!event.shiftKey && (!focusInside || active === last || active === this.dialogElement)) {
      event.preventDefault();
      first.focus();
    }
  }

  private getActiveElement(): HTMLElement | null {
    const active = this.ownerDocument.activeElement;
    if (active === this && this.shadowRoot?.activeElement instanceof HTMLElement) {
      return this.shadowRoot.activeElement;
    }
    return active instanceof HTMLElement ? active : null;
  }

  private getFocusableElements(): HTMLElement[] {
    const assigned = this.slotElement?.assignedElements({ flatten: true }) ?? [];
    const focusable: HTMLElement[] = [];
    for (const element of assigned) {
      this.collectFocusable(element, focusable);
    }
    return focusable.filter((element) => this.isFocusable(element));
  }

  private collectFocusable(element: Element, output: HTMLElement[]) {
    if (element instanceof HTMLElement && element.matches(FOCUSABLE_SELECTOR)) {
      output.push(element);
    }
    for (const child of element.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)) {
      output.push(child);
    }
  }

  private isFocusable(element: HTMLElement): boolean {
    if (element.closest("[hidden], [inert]")) {
      return false;
    }
    if (element.tabIndex < 0) {
      return false;
    }
    return element.isConnected;
  }

  private dispatchCancel() {
    this.dispatchEvent(new CustomEvent("modal-cancel", { bubbles: true, composed: true }));
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
