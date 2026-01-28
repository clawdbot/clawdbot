import { html, css, LitElement, unsafeCSS } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { ContextProvider } from "@lit/context";

import { v0_8 } from "@a2ui/lit";
import "@a2ui/lit/ui";
import { themeContext } from "@moltbot/a2ui-theme-context";

const modalStyles = css`
  dialog {
    position: fixed;
    inset: 0;
    width: 100%;
    height: 100%;
    margin: 0;
    padding: 24px;
    border: none;
    background: rgba(5, 8, 16, 0.65);
    backdrop-filter: blur(6px);
    display: grid;
    place-items: center;
  }

  dialog::backdrop {
    background: rgba(5, 8, 16, 0.65);
    backdrop-filter: blur(6px);
  }
`;

const modalElement = customElements.get("a2ui-modal");
if (modalElement && Array.isArray(modalElement.styles)) {
  modalElement.styles = [...modalElement.styles, modalStyles];
}

const empty = Object.freeze({});
const emptyClasses = () => ({});
const textHintStyles = () => ({ h1: {}, h2: {}, h3: {}, h4: {}, h5: {}, body: {}, caption: {} });

const isAndroid = /Android/i.test(globalThis.navigator?.userAgent ?? "");
const cardShadow = isAndroid ? "0 2px 10px rgba(0,0,0,.18)" : "0 10px 30px rgba(0,0,0,.35)";
const buttonShadow = isAndroid ? "0 2px 10px rgba(6, 182, 212, 0.14)" : "0 10px 25px rgba(6, 182, 212, 0.18)";
const statusShadow = isAndroid ? "0 2px 10px rgba(0, 0, 0, 0.18)" : "0 10px 24px rgba(0, 0, 0, 0.25)";
const statusBlur = isAndroid ? "10px" : "14px";

const moltbotTheme = {
  components: {
    AudioPlayer: emptyClasses(),
    Button: emptyClasses(),
    Card: emptyClasses(),
    Column: emptyClasses(),
    CheckBox: { container: emptyClasses(), element: emptyClasses(), label: emptyClasses() },
    DateTimeInput: { container: emptyClasses(), element: emptyClasses(), label: emptyClasses() },
    Divider: emptyClasses(),
    Image: {
      all: emptyClasses(),
      icon: emptyClasses(),
      avatar: emptyClasses(),
      smallFeature: emptyClasses(),
      mediumFeature: emptyClasses(),
      largeFeature: emptyClasses(),
      header: emptyClasses(),
    },
    Icon: emptyClasses(),
    List: emptyClasses(),
    Modal: { backdrop: emptyClasses(), element: emptyClasses() },
    MultipleChoice: { container: emptyClasses(), element: emptyClasses(), label: emptyClasses() },
    Row: emptyClasses(),
    Slider: { container: emptyClasses(), element: emptyClasses(), label: emptyClasses() },
    Tabs: { container: emptyClasses(), element: emptyClasses(), controls: { all: emptyClasses(), selected: emptyClasses() } },
    Text: {
      all: emptyClasses(),
      h1: emptyClasses(),
      h2: emptyClasses(),
      h3: emptyClasses(),
      h4: emptyClasses(),
      h5: emptyClasses(),
      caption: emptyClasses(),
      body: emptyClasses(),
    },
    TextField: { container: emptyClasses(), element: emptyClasses(), label: emptyClasses() },
    Video: emptyClasses(),
  },
  elements: {
    a: emptyClasses(),
    audio: emptyClasses(),
    body: emptyClasses(),
    button: emptyClasses(),
    h1: emptyClasses(),
    h2: emptyClasses(),
    h3: emptyClasses(),
    h4: emptyClasses(),
    h5: emptyClasses(),
    iframe: emptyClasses(),
    input: emptyClasses(),
    p: emptyClasses(),
    pre: emptyClasses(),
    textarea: emptyClasses(),
    video: emptyClasses(),
  },
  markdown: {
    p: [],
    h1: [],
    h2: [],
    h3: [],
    h4: [],
    h5: [],
    ul: [],
    ol: [],
    li: [],
    a: [],
    strong: [],
    em: [],
  },
  additionalStyles: {
    Card: {
      background: "linear-gradient(180deg, rgba(255,255,255,.06), rgba(255,255,255,.03))",
      border: "1px solid rgba(255,255,255,.09)",
      borderRadius: "14px",
      padding: "14px",
      boxShadow: cardShadow,
    },
    Modal: {
      background: "rgba(12, 16, 24, 0.92)",
      border: "1px solid rgba(255,255,255,.12)",
      borderRadius: "16px",
      padding: "16px",
      boxShadow: "0 30px 80px rgba(0,0,0,.6)",
      width: "min(520px, calc(100vw - 48px))",
    },
    Column: { gap: "10px" },
    Row: { gap: "10px", alignItems: "center" },
    Divider: { opacity: "0.25" },
    Button: {
      background: "linear-gradient(135deg, #22c55e 0%, #06b6d4 100%)",
      border: "0",
      borderRadius: "12px",
      padding: "10px 14px",
      color: "#071016",
      fontWeight: "650",
      cursor: "pointer",
      boxShadow: buttonShadow,
    },
    Text: {
      ...textHintStyles(),
      h1: { fontSize: "20px", fontWeight: "750", margin: "0 0 6px 0" },
      h2: { fontSize: "16px", fontWeight: "700", margin: "0 0 6px 0" },
      body: { fontSize: "13px", lineHeight: "1.4" },
      caption: { opacity: "0.8" },
    },
    TextField: { display: "grid", gap: "6px" },
    Image: { borderRadius: "12px" },
  },
};

class MoltbotA2UIHost extends LitElement {
  static properties = {
    surfaces: { state: true },
    pendingAction: { state: true },
    toast: { state: true },
  };

  #processor = v0_8.Data.createSignalA2uiMessageProcessor();
  #themeProvider = new ContextProvider(this, {
    context: themeContext,
    initialValue: moltbotTheme,
  });

  surfaces = [];
  pendingAction = null;
  toast = null;
  #statusListener = null;

  static styles = css`
    :host {
      display: block;
      height: 100%;
      position: relative;
      box-sizing: border-box;
      padding:
        var(--moltbot-a2ui-inset-top, 0px)
        var(--moltbot-a2ui-inset-right, 0px)
        var(--moltbot-a2ui-inset-bottom, 0px)
        var(--moltbot-a2ui-inset-left, 0px);
    }

    #surfaces {
      display: grid;
      grid-template-columns: 1fr;
      gap: 12px;
      height: 100%;
      overflow: auto;
      padding-bottom: var(--moltbot-a2ui-scroll-pad-bottom, 0px);
    }

    .status {
      position: absolute;
      left: 50%;
      transform: translateX(-50%);
      top: var(--moltbot-a2ui-status-top, 12px);
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 8px 10px;
      border-radius: 12px;
      background: rgba(0, 0, 0, 0.45);
      border: 1px solid rgba(255, 255, 255, 0.18);
      color: rgba(255, 255, 255, 0.92);
      font: 13px/1.2 system-ui, -apple-system, BlinkMacSystemFont, "Roboto", sans-serif;
      pointer-events: none;
      backdrop-filter: blur(${unsafeCSS(statusBlur)});
      -webkit-backdrop-filter: blur(${unsafeCSS(statusBlur)});
      box-shadow: ${unsafeCSS(statusShadow)};
      z-index: 5;
    }

    .toast {
      position: absolute;
      left: 50%;
      transform: translateX(-50%);
      bottom: var(--moltbot-a2ui-toast-bottom, 12px);
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 8px 10px;
      border-radius: 12px;
      background: rgba(0, 0, 0, 0.45);
      border: 1px solid rgba(255, 255, 255, 0.18);
      color: rgba(255, 255, 255, 0.92);
      font: 13px/1.2 system-ui, -apple-system, BlinkMacSystemFont, "Roboto", sans-serif;
      pointer-events: none;
      backdrop-filter: blur(${unsafeCSS(statusBlur)});
      -webkit-backdrop-filter: blur(${unsafeCSS(statusBlur)});
      box-shadow: ${unsafeCSS(statusShadow)};
      z-index: 5;
    }

    .toast.error {
      border-color: rgba(255, 109, 109, 0.35);
      color: rgba(255, 223, 223, 0.98);
    }

    .empty {
      position: absolute;
      left: 50%;
      transform: translateX(-50%);
      top: var(--moltbot-a2ui-empty-top, var(--moltbot-a2ui-status-top, 12px));
      text-align: center;
      opacity: 0.8;
      padding: 10px 12px;
      pointer-events: none;
    }

    .empty-title {
      font-weight: 700;
      margin-bottom: 6px;
    }

    .spinner {
      width: 12px;
      height: 12px;
      border-radius: 999px;
      border: 2px solid rgba(255, 255, 255, 0.25);
      border-top-color: rgba(255, 255, 255, 0.92);
      animation: spin 0.75s linear infinite;
    }

    @keyframes spin {
      from {
        transform: rotate(0deg);
      }
      to {
        transform: rotate(360deg);
      }
    }
  `;

  connectedCallback() {
    super.connectedCallback();
    const api = {
      applyMessages: (messages) => this.applyMessages(messages),
      reset: () => this.reset(),
      getSurfaces: () => Array.from(this.#processor.getSurfaces().keys()),
    };
    globalThis.moltbotA2UI = api;
    globalThis.clawdbotA2UI = api;
    this.addEventListener("a2uiaction", (evt) => this.#handleA2UIAction(evt));
    this.#statusListener = (evt) => this.#handleActionStatus(evt);
    globalThis.addEventListener("moltbot:a2ui-action-status", this.#statusListener);
    this.#syncSurfaces();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    if (this.#statusListener) {
      globalThis.removeEventListener("moltbot:a2ui-action-status", this.#statusListener);
      this.#statusListener = null;
    }
  }

  #makeActionId() {
    return globalThis.crypto?.randomUUID?.() ?? `a2ui_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  }

  #setToast(text, kind = "ok", timeoutMs = 1400) {
    const toast = { text, kind, expiresAt: Date.now() + timeoutMs };
    this.toast = toast;
    this.requestUpdate();
    setTimeout(() => {
      if (this.toast === toast) {
        this.toast = null;
        this.requestUpdate();
      }
    }, timeoutMs + 30);
  }

  #handleActionStatus(evt) {
    const detail = evt?.detail ?? null;
    if (!detail || typeof detail.id !== "string") return;
    if (!this.pendingAction || this.pendingAction.id !== detail.id) return;

    if (detail.ok) {
      this.pendingAction = { ...this.pendingAction, phase: "sent", sentAt: Date.now() };
    } else {
      const msg = typeof detail.error === "string" && detail.error ? detail.error : "send failed";
      this.pendingAction = { ...this.pendingAction, phase: "error", error: msg };
      this.#setToast(`Failed: ${msg}`, "error", 4500);
    }
    this.requestUpdate();
  }

  #handleA2UIAction(evt) {
    const payload = evt?.detail ?? evt?.payload ?? null;
    if (!payload || payload.eventType !== "a2ui.action") {
      return;
    }

    const action = payload.action;
    const name = action?.name;
    if (!name) {
      return;
    }

    const sourceComponentId = payload.sourceComponentId ?? "";
    const surfaces = this.#processor.getSurfaces();

    let surfaceId = null;
    let sourceNode = null;
    for (const [sid, surface] of surfaces.entries()) {
      const node = surface?.components?.get?.(sourceComponentId) ?? null;
      if (node) {
        surfaceId = sid;
        sourceNode = node;
        break;
      }
    }

    const context = {};
    const ctxItems = Array.isArray(action?.context) ? action.context : [];
    for (const item of ctxItems) {
      const key = item?.key;
      const value = item?.value ?? null;
      if (!key || !value) continue;

      if (typeof value.path === "string") {
        const resolved = sourceNode
          ? this.#processor.getData(sourceNode, value.path, surfaceId ?? undefined)
          : null;
        context[key] = resolved;
        continue;
      }
      if (Object.prototype.hasOwnProperty.call(value, "literalString")) {
        context[key] = value.literalString ?? "";
        continue;
      }
      if (Object.prototype.hasOwnProperty.call(value, "literalNumber")) {
        context[key] = value.literalNumber ?? 0;
        continue;
      }
      if (Object.prototype.hasOwnProperty.call(value, "literalBoolean")) {
        context[key] = value.literalBoolean ?? false;
        continue;
      }
    }

    const actionId = this.#makeActionId();
    this.pendingAction = { id: actionId, name, phase: "sending", startedAt: Date.now() };
    this.requestUpdate();

    const userAction = {
      id: actionId,
      name,
      surfaceId: surfaceId ?? "main",
      sourceComponentId,
      timestamp: new Date().toISOString(),
      ...(Object.keys(context).length ? { context } : {}),
    };

    globalThis.__moltbotLastA2UIAction = userAction;

    const handler =
      globalThis.webkit?.messageHandlers?.moltbotCanvasA2UIAction ??
      globalThis.webkit?.messageHandlers?.clawdbotCanvasA2UIAction ??
      globalThis.moltbotCanvasA2UIAction ??
      globalThis.clawdbotCanvasA2UIAction;
    if (handler?.postMessage) {
      try {
        // WebKit message handlers support structured objects; Android's JS interface expects strings.
        if (
          handler === globalThis.moltbotCanvasA2UIAction ||
          handler === globalThis.clawdbotCanvasA2UIAction
        ) {
          handler.postMessage(JSON.stringify({ userAction }));
        } else {
          handler.postMessage({ userAction });
        }
      } catch (e) {
        const msg = String(e?.message ?? e);
        this.pendingAction = { id: actionId, name, phase: "error", startedAt: Date.now(), error: msg };
        this.#setToast(`Failed: ${msg}`, "error", 4500);
      }
    } else {
      this.pendingAction = { id: actionId, name, phase: "error", startedAt: Date.now(), error: "missing native bridge" };
      this.#setToast("Failed: missing native bridge", "error", 4500);
    }
  }

  applyMessages(messages) {
    if (!Array.isArray(messages)) {
      throw new Error("A2UI: expected messages array");
    }
    this.#processor.processMessages(messages);
    this.#syncSurfaces();
    if (this.pendingAction?.phase === "sent") {
      this.#setToast(`Updated: ${this.pendingAction.name}`, "ok", 1100);
      this.pendingAction = null;
    }
    this.requestUpdate();
    return { ok: true, surfaces: this.surfaces.map(([id]) => id) };
  }

  reset() {
    this.#processor.clearSurfaces();
    this.#syncSurfaces();
    this.pendingAction = null;
    this.requestUpdate();
    return { ok: true };
  }

  #syncSurfaces() {
    this.surfaces = Array.from(this.#processor.getSurfaces().entries());
  }

  render() {
    if (this.surfaces.length === 0) {
      return html`<div class="empty">
        <div class="empty-title">Canvas (A2UI)</div>
        <div>Waiting for A2UI messages…</div>
      </div>`;
    }

    const statusText =
      this.pendingAction?.phase === "sent"
        ? `Working: ${this.pendingAction.name}`
        : this.pendingAction?.phase === "sending"
          ? `Sending: ${this.pendingAction.name}`
          : this.pendingAction?.phase === "error"
            ? `Failed: ${this.pendingAction.name}`
            : "";

    return html`
      ${this.pendingAction && this.pendingAction.phase !== "error"
        ? html`<div class="status"><div class="spinner"></div><div>${statusText}</div></div>`
        : ""}
      ${this.toast
        ? html`<div class="toast ${this.toast.kind === "error" ? "error" : ""}">${this.toast.text}</div>`
        : ""}
      <section id="surfaces">
      ${repeat(
        this.surfaces,
        ([surfaceId]) => surfaceId,
        ([surfaceId, surface]) => html`<a2ui-surface
          .surfaceId=${surfaceId}
          .surface=${surface}
          .processor=${this.#processor}
        ></a2ui-surface>`
      )}
    </section>`;
  }
}

customElements.define("moltbot-a2ui-host", MoltbotA2UIHost);
