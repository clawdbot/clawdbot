import { renderMermaidSvg, type MermaidTheme } from "@openclaw/mermaid-renderer";
import { css, html, nothing, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import { t } from "../i18n/index.ts";
import { copyToClipboard } from "../lib/clipboard.ts";
import { resolveThemeColor } from "../lib/theme-color.ts";
import { OpenClawLitElement } from "../lit/openclaw-element.ts";
import { icons } from "./icons.ts";
import "./image-lightbox.ts";
import "./web-awesome.ts";

const CACHE_LIMIT = 16;
const diagrams = new Map<string, Promise<string>>();

function currentTheme(): MermaidTheme {
  const root = document.documentElement;
  const styles = getComputedStyle(root);
  const darkMode = root.dataset.themeMode === "dark";
  return {
    background: resolveThemeColor(styles, "--card") || (darkMode ? "#181818" : "#ffffff"),
    foreground: resolveThemeColor(styles, "--text") || (darkMode ? "#eeeeee" : "#171717"),
    muted: resolveThemeColor(styles, "--muted") || "#888888",
    border: resolveThemeColor(styles, "--border-hover") || "#888888",
    accent: resolveThemeColor(styles, "--accent") || "#888888",
    fontFamily: styles.getPropertyValue("--font-body").trim() || "system-ui, sans-serif",
    darkMode,
  };
}

function cachedDiagram(key: string, source: string, theme: MermaidTheme): Promise<string> {
  let result = diagrams.get(key);
  if (result) {
    diagrams.delete(key);
  } else {
    result = renderMermaidSvg(source, theme);
    void result.catch(() => {
      if (diagrams.get(key) === result) {
        diagrams.delete(key);
      }
    });
  }
  diagrams.set(key, result);
  if (diagrams.size > CACHE_LIMIT) {
    diagrams.delete(diagrams.keys().next().value!);
  }
  return result;
}

class OpenClawMermaid extends OpenClawLitElement {
  @property({ attribute: false }) source = "";
  @state() private imageUrl = "";
  @state() private showSource = false;
  @state() private expanded = false;
  @state() private pending = false;
  @state() private failed = false;
  @state() private copyResult: boolean | undefined;
  private renderKey = "";
  private generation = 0;
  private copyAttempt = 0;
  private readonly themeObserver = new MutationObserver(() => void this.renderDiagram());

  static override styles = css`
    :host {
      display: block;
      position: relative;
      min-width: 0;
      margin: 12px 0;
      border: 1px solid var(--border);
      border-radius: var(--radius-md, 10px);
      overflow: hidden;
      background: var(--card);
      color: var(--text);
      font-family: var(--font-body);
    }
    .actions {
      position: absolute;
      inset-block-start: 6px;
      inset-inline-end: 6px;
      z-index: 1;
      display: flex;
      align-items: center;
      gap: 2px;
    }
    button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 28px;
      height: 28px;
      padding: 0;
      border: 0;
      border-radius: var(--radius-sm, 6px);
      background: transparent;
      color: var(--muted);
      font: inherit;
      cursor: default;
    }
    button:hover,
    button[aria-expanded="true"] {
      background: var(--bg-hover);
      color: var(--text);
    }
    button:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: -2px;
    }
    button svg {
      width: 15px;
      height: 15px;
    }
    .copy-button {
      opacity: 0;
      pointer-events: none;
    }
    :host(:hover) .copy-button,
    :host(:focus-within) .copy-button {
      opacity: 1;
      pointer-events: auto;
    }
    .copy-feedback {
      position: absolute;
      width: 1px;
      height: 1px;
      overflow: hidden;
      clip-path: inset(50%);
      white-space: nowrap;
    }
    wa-dropdown::part(menu) {
      min-width: 160px;
      padding: var(--menu-padding);
      border: 1px solid var(--overlay-border);
      border-radius: var(--menu-radius);
      background: var(--bg-elevated);
      box-shadow: var(--overlay-shadow);
    }
    wa-dropdown-item {
      min-height: var(--menu-item-height);
      padding: 0 8px;
      border-radius: var(--menu-item-radius);
      color: var(--text);
      font: 12px var(--font-body);
      cursor: default;
    }
    wa-dropdown-item:hover,
    wa-dropdown-item:focus-visible {
      background: var(--bg-hover);
    }
    .preview {
      padding: 36px 16px 16px;
      overflow: auto;
    }
    img {
      display: block;
      width: 100%;
      max-height: 480px;
      object-fit: contain;
    }
    pre {
      margin: 0;
      padding: 36px 16px 16px;
      overflow: auto;
      max-height: 480px;
      font: 12px/1.6 var(--mono);
      tab-size: 2;
    }
    .status {
      margin: 0;
      padding: 36px 16px 12px;
      font-size: 12px;
      color: var(--muted);
    }
    @media (hover: none), (pointer: coarse) {
      button {
        width: 36px;
        height: 36px;
      }
      .copy-button {
        opacity: 1;
        pointer-events: auto;
      }
      .preview,
      pre,
      .status {
        padding-top: 44px;
      }
    }
  `;

  override connectedCallback() {
    super.connectedCallback();
    this.themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme", "data-theme-mode", "style"],
    });
    if (this.hasUpdated) {
      void this.renderDiagram();
    }
  }

  override disconnectedCallback() {
    this.themeObserver.disconnect();
    this.generation += 1;
    this.copyAttempt += 1;
    this.renderKey = "";
    this.expanded = false;
    this.releaseImage();
    super.disconnectedCallback();
  }

  protected override updated(changed: PropertyValues<this>) {
    if (changed.has("source")) {
      this.copyResult = undefined;
      this.copyAttempt += 1;
      this.releaseImage();
      void this.renderDiagram();
    }
  }

  private releaseImage() {
    if (this.imageUrl) {
      URL.revokeObjectURL(this.imageUrl);
      this.imageUrl = "";
    }
  }

  private async renderDiagram() {
    if (!this.isConnected) {
      return;
    }
    const theme = currentTheme();
    const key = JSON.stringify([this.source, theme]);
    if (key === this.renderKey) {
      return;
    }
    this.renderKey = key;
    const generation = ++this.generation;
    this.pending = true;
    this.failed = false;
    try {
      const svg = await cachedDiagram(key, this.source, theme);
      // Remounts, edits and theme switches can overtake asynchronous layout.
      // Only the current connected owner may acquire a new blob URL.
      if (!this.isConnected || generation !== this.generation) {
        return;
      }
      this.releaseImage();
      this.imageUrl = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
    } catch {
      if (this.isConnected && generation === this.generation) {
        this.releaseImage();
        this.failed = true;
      }
    } finally {
      if (this.isConnected && generation === this.generation) {
        this.pending = false;
      }
    }
  }

  private async copySource() {
    const attempt = ++this.copyAttempt;
    const copied = await copyToClipboard(this.source);
    if (this.isConnected && attempt === this.copyAttempt) {
      this.copyResult = copied;
    }
  }

  override render() {
    const sourceVisible = this.showSource || this.failed;
    const copyLabel = t(
      this.copyResult === undefined
        ? "chat.mermaid.copySource"
        : this.copyResult
          ? "common.copied"
          : "common.copyFailed",
    );
    return html`
      <div class="actions">
        <button
          class="copy-button"
          type="button"
          aria-label=${copyLabel}
          title=${copyLabel}
          @click=${() => void this.copySource()}
        >
          <span aria-hidden="true"
            >${
              this.copyResult === undefined ? icons.copy : this.copyResult ? icons.check : icons.x
            }</span
          >
        </button>
        <wa-dropdown
          placement="bottom-end"
          size="s"
          .distance=${4}
          aria-label=${t("chat.mermaid.options")}
          @wa-select=${(event: CustomEvent<{ item: { value?: string } }>) => {
            const action = event.detail.item.value;
            if (action === "expand") {
              this.expanded = true;
            } else if (action === "source" || action === "diagram") {
              this.showSource = action === "source";
            }
          }}
        >
          <button
            slot="trigger"
            type="button"
            aria-label=${t("chat.mermaid.options")}
            title=${t("chat.mermaid.options")}
          >
            <span aria-hidden="true">${icons.moreHorizontal}</span>
          </button>
          <wa-dropdown-item
            value=${sourceVisible ? "diagram" : "source"}
            ?disabled=${sourceVisible && !this.imageUrl}
            >${t(sourceVisible ? "chat.mermaid.diagram" : "chat.mermaid.source")}</wa-dropdown-item
          >
          <wa-dropdown-item value="expand" ?disabled=${!this.imageUrl}
            >${t("chat.mermaid.expand")}</wa-dropdown-item
          >
        </wa-dropdown>
      </div>
      <span class="copy-feedback" aria-live="polite"
        >${this.copyResult === undefined ? nothing : copyLabel}</span
      >
      ${
        this.failed
          ? html`<p class="status" role="status">${t("chat.mermaid.error")}</p>`
          : this.pending && !this.imageUrl
            ? html`<p class="status" role="status">${t("chat.mermaid.rendering")}</p>`
            : nothing
      }
      ${
        sourceVisible
          ? html`<pre><code>${this.source}</code></pre>`
          : this.imageUrl
            ? html`<div class="preview">
                <img
                  src=${this.imageUrl}
                  alt=${t("chat.mermaid.title")}
                  @error=${() => {
                    this.failed = true;
                    this.releaseImage();
                  }}
                />
              </div>`
            : nothing
      }
      ${
        this.expanded && this.imageUrl
          ? html`<openclaw-image-lightbox
              src=${this.imageUrl}
              .imageTitle=${t("chat.mermaid.title")}
              @image-lightbox-close=${() => {
                this.expanded = false;
              }}
            ></openclaw-image-lightbox>`
          : nothing
      }
    `;
  }
}

if (!customElements.get("openclaw-mermaid")) {
  customElements.define("openclaw-mermaid", OpenClawMermaid);
}

export function mountMermaidBlocks(root: Element): boolean {
  let mounted = false;
  for (const block of root.querySelectorAll(".markdown-mermaid")) {
    const code = block.querySelector("pre code");
    if (!code) {
      continue;
    }
    const diagram = document.createElement("openclaw-mermaid");
    diagram.source = code.textContent ?? "";
    block.replaceChildren(diagram);
    mounted = true;
  }
  return mounted;
}

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-mermaid": OpenClawMermaid;
  }
}
