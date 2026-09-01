import { css, html, nothing, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import { t } from "../i18n/index.ts";
import { copyToClipboard } from "../lib/clipboard.ts";
import { resolveThemeColor } from "../lib/theme-color.ts";
import { OpenClawLitElement } from "../lit/openclaw-element.ts";
import { renderMermaidSvg, type MermaidTheme } from "./markdown-mermaid.runtime.ts";
import "./image-lightbox.ts";

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
      min-width: 0;
      margin: 12px 0;
      border: 1px solid var(--border);
      border-radius: var(--radius-md, 10px);
      overflow: hidden;
      background: var(--card);
      color: var(--text);
      font-family: var(--font-body);
    }
    .toolbar {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 4px;
      padding: 6px 8px;
      border-bottom: 1px solid var(--border);
    }
    .spacer {
      flex: 1;
    }
    button {
      padding: 5px 8px;
      min-height: 32px;
      border: 0;
      border-radius: var(--radius-sm, 6px);
      background: transparent;
      color: var(--muted);
      font: inherit;
      font-size: 12px;
      cursor: default;
    }
    button:hover,
    button[aria-pressed="true"] {
      background: var(--bg-hover);
      color: var(--text);
    }
    button:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: -2px;
    }
    button:disabled {
      opacity: 0.5;
      cursor: default;
    }
    .preview {
      padding: 16px;
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
      padding: 16px;
      overflow: auto;
      max-height: 480px;
      font: 12px/1.6 var(--font-mono, monospace);
      tab-size: 2;
    }
    .status {
      margin: 0;
      padding: 12px 16px;
      font-size: 12px;
      color: var(--muted);
    }
    @media (max-width: 640px) {
      button {
        min-height: 40px;
      }
      .preview {
        padding: 8px;
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
    return html`
      <div class="toolbar" role="group" aria-label=${t("chat.mermaid.title")}>
        <button
          type="button"
          aria-pressed=${!this.showSource}
          @click=${() => {
            this.showSource = false;
          }}
        >
          ${t("chat.mermaid.diagram")}
        </button>
        <button
          type="button"
          aria-pressed=${this.showSource}
          @click=${() => {
            this.showSource = true;
          }}
        >
          ${t("chat.mermaid.source")}
        </button>
        <span class="spacer"></span>
        <button type="button" @click=${this.copySource}>
          ${t(
            this.copyResult === undefined
              ? "chat.mermaid.copySource"
              : this.copyResult
                ? "common.copied"
                : "common.copyFailed",
          )}
        </button>
        <button
          type="button"
          ?disabled=${!this.imageUrl}
          @click=${() => {
            this.expanded = true;
          }}
        >
          ${t("chat.mermaid.expand")}
        </button>
      </div>
      ${this.failed
        ? html`<p class="status" role="status">${t("chat.mermaid.error")}</p>`
        : this.pending && !this.imageUrl
          ? html`<p class="status" role="status">${t("chat.mermaid.rendering")}</p>`
          : nothing}
      ${sourceVisible
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
          : nothing}
      ${this.expanded && this.imageUrl
        ? html`<openclaw-image-lightbox
            src=${this.imageUrl}
            .imageTitle=${t("chat.mermaid.title")}
            @image-lightbox-close=${() => {
              this.expanded = false;
            }}
          ></openclaw-image-lightbox>`
        : nothing}
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
