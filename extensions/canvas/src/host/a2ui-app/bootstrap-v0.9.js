import { basicCatalog } from "@a2ui/lit/v0_9";
/** A2UI v0.9 Lit host used by sandboxed board documents. */
import { MessageProcessor } from "@a2ui/web_core/v0_9";
import "@a2ui/lit/v0_9";
import { css, html, LitElement } from "lit";
import { repeat } from "lit/directives/repeat.js";

const actionText = (action) => {
  const context =
    action?.context && Object.keys(action.context).length ? action.context : undefined;
  return context
    ? `A2UI action ${action.name}: ${JSON.stringify(context)}`
    : `A2UI action ${action?.name ?? "selected"}`;
};

const routeBoardAction = async (action) => {
  const api = globalThis.openclaw;
  if (!api?.state?.emit) {
    return false;
  }
  if (globalThis.__openclawA2UIBoot?.actionTier === "prompt" && api.prompt?.send) {
    await api.prompt.send(actionText(action));
  } else {
    await api.state.emit({ eventType: "a2ui.action", action });
  }
  return true;
};

class OpenClawA2UIV09Host extends LitElement {
  static properties = { surfaces: { state: true }, error: { state: true } };

  static styles = css`
    :host {
      display: block;
      min-height: 100%;
      color: var(--text);
      background: transparent;
    }
    #surfaces {
      display: grid;
      gap: 12px;
      min-height: 100%;
    }
    .error {
      color: var(--danger);
      padding: 12px;
    }
  `;

  surfaces = [];
  error = "";
  #processor;
  #subscriptions = [];

  constructor() {
    super();
    this.#processor = this.#createProcessor();
  }

  #createProcessor() {
    const processor = new MessageProcessor([basicCatalog], async (action) => {
      try {
        await routeBoardAction(action);
      } catch (error) {
        this.error = String(error?.message ?? error);
      }
    });
    this.#subscriptions = [
      processor.onSurfaceCreated(() => this.#syncSurfaces()),
      processor.onSurfaceDeleted(() => this.#syncSurfaces()),
    ];
    return processor;
  }

  connectedCallback() {
    super.connectedCallback();
    globalThis.openclawA2UI = {
      applyMessages: (messages) => this.applyMessages(messages),
      reset: () => this.reset(),
      getSurfaces: () => this.surfaces.map(([id]) => id),
    };
    const bootMessages = globalThis.__openclawA2UIBoot?.messages;
    if (Array.isArray(bootMessages)) {
      this.applyMessages(bootMessages);
    }
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    for (const subscription of this.#subscriptions) {
      subscription.unsubscribe();
    }
    this.#subscriptions = [];
  }

  applyMessages(messages) {
    if (!Array.isArray(messages)) {
      throw new Error("A2UI: expected messages array");
    }
    this.#processor.processMessages(messages);
    this.#syncSurfaces();
    return { ok: true, surfaces: this.surfaces.map(([id]) => id) };
  }

  reset() {
    this.#processor.model.dispose();
    for (const subscription of this.#subscriptions) {
      subscription.unsubscribe();
    }
    this.#processor = this.#createProcessor();
    this.surfaces = [];
    this.error = "";
    return { ok: true };
  }

  #syncSurfaces() {
    this.surfaces = Array.from(this.#processor.model.surfacesMap.entries());
    this.requestUpdate();
  }

  render() {
    return html`${this.error ? html`<div class="error" role="alert">${this.error}</div>` : ""}
      <section id="surfaces">
        ${repeat(
          this.surfaces,
          ([surfaceId]) => surfaceId,
          ([, surface]) => html`<a2ui-surface .surface=${surface}></a2ui-surface>`,
        )}
      </section>`;
  }
}

if (!customElements.get("openclaw-a2ui-host")) {
  customElements.define("openclaw-a2ui-host", OpenClawA2UIV09Host);
}
