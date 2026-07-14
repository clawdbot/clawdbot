// Session diff panel: renders the sessions.diff RPC result (branch +
// working-tree changes per file) inside the chat detail sidebar.
import { html, nothing, type TemplateResult } from "lit";
import { property, state } from "lit/decorators.js";
import type {
  SessionDiffFile,
  SessionsDiffResult,
} from "../../../../../packages/gateway-protocol/src/index.js";
import { icons } from "../../../components/icons.ts";
import "../../../components/tooltip.ts";
import { t } from "../../../i18n/index.ts";
import { parseSessionDiffPatch, type ParsedFilePatch } from "../../../lib/chat/session-diff.ts";
import { OpenClawLightDomElement } from "../../../lit/openclaw-element.ts";
import { renderDiffBlock, renderDiffStatChips } from "./chat-diff-render.ts";

export type SessionDiffLoader = () => Promise<SessionsDiffResult>;

type FileView = {
  file: SessionDiffFile;
  parsed: ParsedFilePatch | null;
};

function statusLabel(file: SessionDiffFile): string {
  switch (file.status) {
    case "added":
      return t("chat.sessionDiff.statusAdded");
    case "deleted":
      return t("chat.sessionDiff.statusDeleted");
    case "renamed":
      return t("chat.sessionDiff.statusRenamed");
    default:
      return t("chat.sessionDiff.statusModified");
  }
}

class SessionDiffPanel extends OpenClawLightDomElement {
  @property({ attribute: false }) loader: SessionDiffLoader | null = null;

  @state() private result: SessionsDiffResult | null = null;
  @state() private views: FileView[] = [];
  @state() private loading = false;
  @state() private error: string | null = null;
  @state() private collapsedPaths = new Set<string>();

  private requestVersion = 0;

  protected override updated(changed: Map<string, unknown>) {
    if (changed.has("loader")) {
      void this.refresh();
    }
  }

  private async refresh(): Promise<void> {
    const loader = this.loader;
    const version = ++this.requestVersion;
    if (!loader) {
      this.result = null;
      this.views = [];
      return;
    }
    this.loading = true;
    this.error = null;
    try {
      const result = await loader();
      if (version !== this.requestVersion) {
        return;
      }
      this.result = result;
      this.views = result.files.map((file) => ({
        file,
        parsed: file.patch
          ? parseSessionDiffPatch(file.patch, (count) =>
              t("chat.sessionDiff.unmodifiedLines", { count: String(count) }),
            )
          : null,
      }));
      this.collapsedPaths = new Set<string>();
    } catch (error) {
      if (version !== this.requestVersion) {
        return;
      }
      this.error = error instanceof Error ? error.message : String(error);
    } finally {
      if (version === this.requestVersion) {
        this.loading = false;
      }
    }
  }

  private toggleFile(path: string): void {
    const next = new Set(this.collapsedPaths);
    if (next.has(path)) {
      next.delete(path);
    } else {
      next.add(path);
    }
    this.collapsedPaths = next;
  }

  private renderSummary(result: SessionsDiffResult): TemplateResult {
    const branchLabel =
      result.baseRef && result.branch && result.baseRef !== result.branch
        ? `${result.baseRef} → ${result.branch}`
        : (result.branch ?? result.baseRef ?? "");
    return html`
      <div class="session-diff__summary">
        <span class="session-diff__branch" title=${result.root ?? ""}>
          ${icons.gitBranch}
          <span class="session-diff__branch-label">${branchLabel}</span>
        </span>
        ${renderDiffStatChips({ added: result.additions, removed: result.deletions })}
        <openclaw-tooltip .content=${t("chat.sessionDiff.refresh")}>
          <button
            class="btn btn--ghost btn--icon session-diff__refresh"
            type="button"
            aria-label=${t("chat.sessionDiff.refresh")}
            ?disabled=${this.loading}
            @click=${() => void this.refresh()}
          >
            ${icons.refresh}
          </button>
        </openclaw-tooltip>
      </div>
    `;
  }

  private renderFileBody(view: FileView): TemplateResult {
    const { file, parsed } = view;
    if (file.binary === true) {
      return html`<div class="session-diff__note">${t("chat.sessionDiff.binaryFile")}</div>`;
    }
    if (!parsed) {
      return html`<div class="session-diff__note">${t("chat.sessionDiff.tooLarge")}</div>`;
    }
    return html`
      ${renderDiffBlock(parsed.lines)}
      ${parsed.truncated
        ? html`<div class="session-diff__note">${t("chat.sessionDiff.truncatedFile")}</div>`
        : nothing}
    `;
  }

  private renderFile(view: FileView): TemplateResult {
    const { file } = view;
    const collapsed = this.collapsedPaths.has(file.path);
    return html`
      <section class="session-diff__file" data-status=${file.status}>
        <button
          class="session-diff__file-header"
          type="button"
          aria-expanded=${String(!collapsed)}
          @click=${() => this.toggleFile(file.path)}
        >
          <span class="session-diff__chevron ${collapsed ? "" : "session-diff__chevron--open"}">
            ${icons.chevronRight}
          </span>
          <span
            class="session-diff__status session-diff__status--${file.status}"
            title=${statusLabel(file)}
          ></span>
          <span class="session-diff__path">
            ${file.oldPath
              ? html`<span class="session-diff__old-path">${file.oldPath}</span> → `
              : nothing}${file.path}
          </span>
          ${file.untracked === true
            ? html`<span class="session-diff__badge">${t("chat.sessionDiff.untracked")}</span>`
            : nothing}
          ${renderDiffStatChips({ added: file.additions, removed: file.deletions })}
        </button>
        ${collapsed ? nothing : this.renderFileBody(view)}
      </section>
    `;
  }

  private renderBody(): TemplateResult {
    if (this.error) {
      return html`<div class="callout danger">${this.error}</div>`;
    }
    const result = this.result;
    if (!result) {
      return html`<div class="session-diff__note">${t("chat.sessionDiff.loading")}</div>`;
    }
    if (result.unavailableReason === "not_git") {
      return html`<div class="session-diff__note">${t("chat.sessionDiff.notGit")}</div>`;
    }
    if (result.unavailableReason === "unknown_session") {
      return html`<div class="session-diff__note">${t("chat.sessionDiff.unknownSession")}</div>`;
    }
    return html`
      ${this.renderSummary(result)}
      ${result.files.length === 0
        ? html`<div class="session-diff__note">${t("chat.sessionDiff.empty")}</div>`
        : this.views.map((view) => this.renderFile(view))}
      ${result.truncated === true
        ? html`<div class="session-diff__note">${t("chat.sessionDiff.truncatedResult")}</div>`
        : nothing}
    `;
  }

  override render() {
    return html`
      <div class="session-diff" aria-busy=${String(this.loading)}>${this.renderBody()}</div>
    `;
  }
}

if (!customElements.get("openclaw-session-diff")) {
  customElements.define("openclaw-session-diff", SessionDiffPanel);
}

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-session-diff": SessionDiffPanel;
  }
}
