import { LitElement, css, html, type PropertyValues } from "lit";
import { property, query } from "lit/decorators.js";
import { icons } from "../icons.ts";

export type FilePreviewModalFile = {
  path: string;
  size: string;
  contents: string;
};

export class OpenClawFilePreviewModal extends LitElement {
  @property({ attribute: false }) files: FilePreviewModalFile[] = [];
  @property() activePath = "";
  @property() query = "";
  @property() label = "Support files";
  @property() listLabel = "Files";
  @property() searchPlaceholder = "Search files...";
  @property() contextLabel = "";
  @property() readOnlyLabel = "read-only";
  @property() emptyTitle = "No files match";
  @property() emptySubtitle = "Try another file name or content search.";
  @query(".search") private searchInput?: HTMLInputElement;

  static override styles = css`
    :host {
      position: fixed;
      inset: 0;
      z-index: 50;
      display: block;
    }

    .backdrop {
      position: absolute;
      inset: 0;
      background: rgba(0, 0, 0, 0.6);
      backdrop-filter: blur(6px);
      animation: fade 140ms ease-out;
    }

    @keyframes fade {
      from {
        opacity: 0;
      }
      to {
        opacity: 1;
      }
    }

    @keyframes pop {
      from {
        transform: translate(-50%, -48%) scale(0.97);
        opacity: 0;
      }
      to {
        transform: translate(-50%, -50%) scale(1);
        opacity: 1;
      }
    }

    .modal {
      position: fixed;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      width: min(1100px, 92vw);
      height: min(780px, 86vh);
      background: var(--bg);
      border: 1px solid var(--border-strong);
      border-radius: var(--radius-lg);
      box-shadow: 0 24px 80px rgba(0, 0, 0, 0.6);
      display: flex;
      flex-direction: column;
      overflow: hidden;
      animation: pop 160ms ease-out;
    }

    .head {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 16px 20px;
      border-bottom: 1px solid var(--border);
      background: var(--bg);
    }

    .search-icon {
      color: var(--muted);
      font-size: 18px;
    }

    .search {
      flex: 1;
      background: transparent;
      border: none;
      outline: none;
      color: var(--text-strong);
      font: inherit;
      font-size: 18px;
      font-weight: 400;
      padding: 4px 0;
    }

    .search:focus,
    .search:focus-visible {
      outline: none;
      border: none;
      box-shadow: none;
    }

    .search::placeholder {
      color: var(--muted);
    }

    .state {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      font-size: 12px;
      color: var(--muted);
      padding: 5px 10px;
      border: 1px solid var(--border);
      border-radius: var(--radius-md);
      background: var(--bg-elevated);
    }

    .esc,
    .kbd {
      font-family: var(--mono);
      border: 1px solid var(--border);
      color: var(--muted);
    }

    .esc {
      font-size: 10px;
      padding: 1px 5px;
      border-radius: 3px;
      background: var(--bg);
    }

    .body {
      flex: 1;
      display: grid;
      grid-template-columns: 360px 1fr;
      min-height: 0;
    }

    .list {
      border-right: 1px solid var(--border);
      padding: 14px 10px;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      gap: 2px;
    }

    .list-section {
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--muted);
      padding: 4px 12px 8px;
    }

    .item {
      display: grid;
      grid-template-columns: 16px 1fr auto;
      gap: 12px;
      align-items: center;
      padding: 12px 14px;
      border-radius: var(--radius-md);
      border: none;
      background: transparent;
      color: var(--text);
      cursor: pointer;
      font: inherit;
      outline: none;
      text-align: left;
    }

    .item:focus-visible {
      box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 55%, transparent);
    }

    .item:hover {
      background: var(--bg-elevated);
    }

    .item.is-active {
      background: var(--accent-subtle);
    }

    .item.is-active .item-name {
      color: var(--text-strong);
    }

    .item-icon {
      width: 16px;
      height: 16px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      color: var(--muted);
      opacity: 0.85;
    }

    .item.is-active .item-icon {
      color: var(--accent);
      opacity: 1;
    }

    .item-icon svg {
      width: 16px;
      height: 16px;
      stroke: currentColor;
      fill: none;
      stroke-width: 1.5px;
      stroke-linecap: round;
      stroke-linejoin: round;
    }

    .item-name {
      font-family: var(--mono);
      font-size: 14px;
      color: var(--text);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .item-meta {
      color: var(--muted);
      font-size: 12px;
    }

    .empty-list {
      color: var(--muted);
      font-size: 13px;
      padding: 12px;
    }

    .detail {
      display: flex;
      flex-direction: column;
      min-width: 0;
      min-height: 0;
    }

    .detail.empty {
      align-items: center;
      justify-content: center;
      text-align: center;
      padding: 24px;
    }

    .detail-head {
      padding: 20px 24px 14px;
      border-bottom: 1px solid var(--border);
    }

    .title {
      margin: 0 0 10px;
      font-family: var(--mono);
      font-size: 22px;
      color: var(--text-strong);
      font-weight: 700;
      letter-spacing: -0.01em;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .chips {
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
    }

    .chip {
      display: inline-flex;
      align-items: center;
      padding: 3px 10px;
      border-radius: 999px;
      font-size: 11.5px;
      background: var(--bg-elevated);
      border: 1px solid var(--border);
      color: var(--muted);
    }

    .chip.accent {
      background: var(--accent-subtle);
      border-color: color-mix(in srgb, var(--accent) 30%, transparent);
      color: var(--accent);
    }

    .chip.ok {
      background: color-mix(in srgb, var(--ok) 12%, transparent);
      border-color: color-mix(in srgb, var(--ok) 30%, transparent);
      color: var(--ok);
    }

    .detail-body {
      flex: 1;
      overflow: auto;
      padding: 20px 24px 24px;
    }

    .pre {
      margin: 0;
      font-family: var(--mono);
      font-size: 13px;
      line-height: 1.7;
      color: var(--text);
      background: transparent;
      border: none;
      white-space: pre-wrap;
      word-break: break-word;
    }

    .foot {
      display: flex;
      align-items: center;
      gap: 18px;
      padding: 12px 20px;
      border-top: 1px solid var(--border);
      background: var(--bg);
      font-size: 12px;
      color: var(--muted);
    }

    .foot-group {
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }

    .kbd {
      font-size: 10.5px;
      padding: 2px 6px;
      border-radius: 4px;
      background: var(--bg-elevated);
      color: var(--text);
    }

    .spacer {
      flex: 1;
    }

    .button {
      height: 36px;
      padding: 0 14px;
      border-radius: var(--radius-md);
      border: 1px solid var(--border);
      background: var(--bg-elevated);
      color: var(--text);
      font-weight: 600;
      cursor: pointer;
    }

    .button:hover {
      border-color: var(--border-strong);
      color: var(--text-strong);
    }

    .empty-title {
      font-size: 16px;
      font-weight: 600;
      color: var(--text-strong);
      margin: 0 0 8px;
    }

    .empty-subtitle {
      margin: 0;
      font-size: 13px;
      color: var(--muted);
      max-width: 380px;
    }
  `;

  override render() {
    const filteredFiles = this.filterFiles();
    const activeFile = this.resolveActiveFile(filteredFiles);
    const fileCount =
      filteredFiles.length === this.files.length
        ? `${this.files.length} files`
        : `${filteredFiles.length}/${this.files.length} files`;

    return html`
      <div class="backdrop" @click=${this.emitClose}></div>
      <div
        class="modal"
        role="dialog"
        aria-label=${this.label}
        aria-modal="true"
        tabindex="-1"
        @keydown=${this.handleKeydown}
      >
        <header class="head">
          <span class="search-icon">⌕</span>
          <input
            class="search"
            placeholder=${this.searchPlaceholder}
            .value=${this.query}
            @input=${this.handleQueryInput}
            autofocus
          />
          <span class="state">${fileCount} <span class="esc">esc</span></span>
        </header>
        <div class="body">
          <aside class="list">
            <div class="list-section">${this.listLabel} · ${filteredFiles.length}</div>
            ${filteredFiles.length === 0
              ? html`<div class="empty-list">No files match.</div>`
              : filteredFiles.map(
                  (file) => html`
                    <button
                      class="item ${file.path === activeFile?.path ? "is-active" : ""}"
                      @pointerdown=${this.preventItemPointerFocus}
                      @mousedown=${this.preventItemPointerFocus}
                      @click=${() => this.emitSelect(file.path)}
                    >
                      <span class="item-icon">${iconForFile(file.path)}</span>
                      <span class="item-name">${file.path}</span>
                      <span class="item-meta">${file.size}</span>
                    </button>
                  `,
                )}
          </aside>
          ${activeFile ? this.renderFile(activeFile) : this.renderEmpty()}
        </div>
        <footer class="foot">
          <span class="foot-group"><span class="kbd">↑↓</span> navigate</span>
          <span class="spacer"></span>
          <button class="button" @click=${this.emitClose}>
            Close <span class="kbd">esc</span>
          </button>
        </footer>
      </div>
    `;
  }

  private renderFile(file: FilePreviewModalFile) {
    return html`
      <section class="detail">
        <div class="detail-head">
          <h2 class="title">${file.path}</h2>
          <div class="chips">
            <span class="chip accent">${fileKind(file.path)}</span>
            <span class="chip">${file.size}</span>
            <span class="chip">${this.readOnlyLabel}</span>
            ${this.contextLabel ? html`<span class="chip ok">${this.contextLabel}</span>` : ""}
          </div>
        </div>
        <div class="detail-body">
          <pre class="pre">${file.contents}</pre>
        </div>
      </section>
    `;
  }

  private renderEmpty() {
    return html`
      <section class="detail empty">
        <p class="empty-title">${this.emptyTitle}</p>
        <p class="empty-subtitle">${this.emptySubtitle}</p>
      </section>
    `;
  }

  private filterFiles(): FilePreviewModalFile[] {
    const normalizedQuery = this.query.trim().toLowerCase();
    if (!normalizedQuery) {
      return this.files;
    }
    return this.files.filter((file) => {
      const haystack = `${file.path}\n${file.contents}`.toLowerCase();
      return haystack.includes(normalizedQuery);
    });
  }

  private resolveActiveFile(files: FilePreviewModalFile[]): FilePreviewModalFile | undefined {
    return files.find((file) => file.path === this.activePath) ?? files[0];
  }

  protected override firstUpdated() {
    this.focusModal();
  }

  protected override updated(changed: PropertyValues<this>) {
    if (changed.has("activePath") || changed.has("query") || changed.has("files")) {
      this.scrollActiveFileIntoView();
    }
  }

  private handleQueryInput = (event: Event) => {
    const nextQuery = (event.target as HTMLInputElement).value ?? "";
    this.dispatchEvent(
      new CustomEvent<string>("file-preview-query-change", {
        bubbles: true,
        composed: true,
        detail: nextQuery,
      }),
    );
  };

  private preventItemPointerFocus = (event: Event) => {
    event.preventDefault();
  };

  private handleKeydown = (event: KeyboardEvent) => {
    switch (event.key) {
      case "Escape":
        event.preventDefault();
        event.stopPropagation();
        this.emitClose();
        return;
      case "ArrowDown":
        this.moveSelection(1, event);
        return;
      case "ArrowUp":
        this.moveSelection(-1, event);
      default:
    }
  };

  private focusModal() {
    const target = this.searchInput ?? this.shadowRoot?.querySelector<HTMLElement>(".modal");
    target?.focus({ preventScroll: true });
  }

  private moveSelection(offset: number, event: KeyboardEvent) {
    event.preventDefault();
    event.stopPropagation();
    const files = this.filterFiles();
    if (files.length === 0) {
      return;
    }
    const activeFile = this.resolveActiveFile(files);
    const currentIndex = activeFile ? files.findIndex((file) => file.path === activeFile.path) : -1;
    const nextIndex = Math.max(0, Math.min(files.length - 1, currentIndex + offset));
    const nextFile = files[nextIndex];
    if (nextFile && nextFile.path !== activeFile?.path) {
      this.emitSelect(nextFile.path);
    }
  }

  private scrollActiveFileIntoView() {
    this.updateComplete
      .then(() => {
        if (!this.isConnected) {
          return;
        }
        this.shadowRoot
          ?.querySelector<HTMLElement>(".item.is-active")
          ?.scrollIntoView({ block: "nearest" });
      })
      .catch(() => {});
  }

  private emitSelect(path: string) {
    this.dispatchEvent(
      new CustomEvent<string>("file-preview-select", {
        bubbles: true,
        composed: true,
        detail: path,
      }),
    );
    this.focusModal();
  }

  private emitClose = () => {
    this.dispatchEvent(
      new CustomEvent("file-preview-close", {
        bubbles: true,
        composed: true,
      }),
    );
  };
}

function fileKind(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    md: "Markdown",
    txt: "Text",
    json: "JSON",
    yaml: "YAML",
    yml: "YAML",
    ts: "TypeScript",
    js: "JavaScript",
    py: "Python",
    sh: "Shell",
  };
  return map[ext] ?? (ext ? ext.toUpperCase() : "File");
}

if (!customElements.get("openclaw-file-preview-modal")) {
  customElements.define("openclaw-file-preview-modal", OpenClawFilePreviewModal);
}

const CODE_EXTENSIONS = new Set([
  "ts",
  "tsx",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "py",
  "sh",
  "bash",
  "zsh",
  "rb",
  "go",
  "rs",
  "java",
  "kt",
  "swift",
  "c",
  "cc",
  "cpp",
  "h",
  "hpp",
  "json",
  "yaml",
  "yml",
  "toml",
  "xml",
  "html",
  "css",
  "scss",
  "sql",
]);

function iconForFile(path: string) {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return CODE_EXTENSIONS.has(ext) ? icons.fileCode : icons.fileText;
}

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-file-preview-modal": OpenClawFilePreviewModal;
  }
}
