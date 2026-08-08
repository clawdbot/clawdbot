import { html, nothing, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import type { AgentsWorkspaceGetResult } from "../../../../packages/gateway-protocol/src/index.js";
import type { MemorySearchResponse } from "../../../../src/gateway/server-methods/memory-search.ts";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { t } from "../../i18n/index.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import "../../styles/memory-memories.css";

type SearchResult = MemorySearchResponse["results"][number];
type SearchState =
  | { kind: "idle" }
  | { kind: "loading"; query: string }
  | ({ kind: "ready"; query: string } & MemorySearchResponse)
  | { kind: "error"; query: string; message: string };
type DetailState =
  | { kind: "loading" }
  | { kind: "ready"; content: string }
  | { kind: "error"; message: string };

function resultKey(result: SearchResult, index: number): string {
  return `${index}:${result.path}:${result.startLine}:${result.endLine}`;
}

function isExpandableWorkspaceResult(result: SearchResult): boolean {
  const normalizedPath = result.path.replaceAll("\\", "/");
  const safeRelativePath =
    !normalizedPath.startsWith("/") &&
    !normalizedPath.startsWith("sessions/") &&
    !/^[a-zA-Z]:\//.test(normalizedPath) &&
    normalizedPath.split("/").every((segment) => segment && segment !== "." && segment !== "..");
  const workspaceMemoryPath =
    normalizedPath === "MEMORY.md" || normalizedPath.startsWith("memory/");
  // workspace.get is workspace-contained; sessions/* and qmd/* are logical manager paths.
  return result.source === "memory" && safeRelativePath && workspaceMemoryPath;
}

function renderFileContent(content: string, result: SearchResult) {
  const lines = content.split(/\r?\n/);
  const start = Math.max(0, result.startLine - 1);
  const end = Math.min(lines.length, result.endLine);
  const before = lines.slice(0, start);
  const matched = lines.slice(start, end);
  const after = lines.slice(end);
  return html`<pre class="memory-memories__file" tabindex="0"><span
      >${before.join("\n")}${before.length ? "\n" : ""}</span
    ><mark data-memory-match="true">${matched.join("\n")}</mark
    ><span>${after.length ? `\n${after.join("\n")}` : ""}</span></pre>`;
}

class MemoryMemoriesElement extends OpenClawLightDomElement {
  @property({ attribute: false }) client: GatewayBrowserClient | null = null;
  @property({ type: Boolean }) connected = false;
  @property({ type: Boolean }) methodAdvertised = true;
  @property() agentId: string | null = null;

  @state() private query = "";
  @state() private searchState: SearchState = { kind: "idle" };
  @state() private openResultKey: string | null = null;
  @state() private details = new Map<string, DetailState>();

  private searchRequest: object | null = null;
  private detailRequests = new Map<string, object>();

  protected override updated(changed: PropertyValues<this>) {
    if (
      changed.has("agentId") ||
      changed.has("client") ||
      changed.has("connected") ||
      changed.has("methodAdvertised")
    ) {
      this.resetSearch();
    }
  }

  private resetSearch() {
    this.searchRequest = null;
    this.detailRequests.clear();
    this.query = "";
    this.searchState = { kind: "idle" };
    this.openResultKey = null;
    this.details = new Map();
  }

  private async search(query: string) {
    const normalizedQuery = query.trim();
    const client = this.connected ? this.client : null;
    const agentId = this.agentId;
    if (!normalizedQuery || !client || !agentId || !this.methodAdvertised) {
      return;
    }
    const request = { client, agentId, query: normalizedQuery };
    this.searchRequest = request;
    this.query = normalizedQuery;
    this.searchState = { kind: "loading", query: normalizedQuery };
    this.openResultKey = null;
    this.details = new Map();
    this.detailRequests.clear();
    try {
      const result = await client.request<MemorySearchResponse>("memory.search", {
        query: normalizedQuery,
        agentId,
      });
      if (this.searchRequest !== request || this.agentId !== agentId || this.client !== client) {
        return;
      }
      this.searchState = { kind: "ready", query: normalizedQuery, ...result };
    } catch (error) {
      if (this.searchRequest !== request || this.agentId !== agentId || this.client !== client) {
        return;
      }
      this.searchState = {
        kind: "error",
        query: normalizedQuery,
        message: formatUiError(error),
      };
    }
  }

  private toggleResult(result: SearchResult, index: number) {
    const key = resultKey(result, index);
    if (this.openResultKey === key) {
      this.openResultKey = null;
      return;
    }
    this.openResultKey = key;
    if (!this.details.has(key)) {
      void this.loadDetail(key, result);
    }
  }

  private async loadDetail(key: string, result: SearchResult) {
    const client = this.connected ? this.client : null;
    const agentId = this.agentId;
    if (!client || !agentId) {
      return;
    }
    const request = { client, agentId, path: result.path };
    this.detailRequests.set(key, request);
    this.details = new Map(this.details).set(key, { kind: "loading" });
    try {
      const response = await client.request<AgentsWorkspaceGetResult>("agents.workspace.get", {
        agentId,
        path: result.path,
      });
      if (this.detailRequests.get(key) !== request || this.agentId !== agentId) {
        return;
      }
      const detail: DetailState =
        response.file.encoding === "utf8"
          ? { kind: "ready", content: response.file.content }
          : { kind: "error", message: t("memoryPage.memories.fileUnsupported") };
      this.details = new Map(this.details).set(key, detail);
    } catch (error) {
      if (this.detailRequests.get(key) !== request || this.agentId !== agentId) {
        return;
      }
      this.details = new Map(this.details).set(key, {
        kind: "error",
        message: formatUiError(error),
      });
    } finally {
      if (this.detailRequests.get(key) === request) {
        this.detailRequests.delete(key);
      }
    }
  }

  private renderDetail(key: string, panelId: string, result: SearchResult) {
    if (this.openResultKey !== key) {
      return nothing;
    }
    const detail = this.details.get(key);
    return html`<div id=${panelId} class="memory-memories__detail">
      ${!detail || detail.kind === "loading"
        ? html`<p role="status">${t("memoryPage.memories.fileLoading")}</p>`
        : detail.kind === "error"
          ? html`<p class="memory-memories__detail-error" role="alert">
              ${t("memoryPage.memories.fileError", { message: detail.message })}
            </p>`
          : renderFileContent(detail.content, result)}
    </div>`;
  }

  private renderResults(ready: Extract<SearchState, { kind: "ready" }>) {
    const mode =
      ready.searchMode === "hybrid"
        ? t("memoryPage.memories.hybridSearch")
        : t("memoryPage.memories.keywordSearch");
    return html`
      <div class="memory-memories__results-heading">
        <span>${t("memoryPage.memories.results", { count: String(ready.results.length) })}</span>
        <span class="memory-memories__mode">${mode}</span>
      </div>
      ${ready.results.length === 0
        ? html`<p class="memory-memories__state">
            ${t("memoryPage.memories.empty", {
              query: ready.query,
            })}
          </p>`
        : html`<div class="settings-group memory-memories__results">
            ${ready.results.map((result, index) => {
              const key = resultKey(result, index);
              const open = this.openResultKey === key;
              const expandable = isExpandableWorkspaceResult(result);
              const panelId = `memory-detail-${index}`;
              const summary = html`
                <span class="settings-row__text">
                  <span class="settings-row__title">${result.snippet}</span>
                  <span class="settings-row__desc memory-memories__path"
                    >${result.path} ·
                    ${t("memoryPage.memories.lineRange", {
                      start: String(result.startLine),
                      end: String(result.endLine),
                    })}</span
                  >
                </span>
                <span class="settings-row__control memory-memories__meta">
                  <span class="memory-memories__source"
                    >${t(
                      result.source === "sessions"
                        ? "memoryPage.memories.sourceSessions"
                        : "memoryPage.memories.sourceMemory",
                    )}</span
                  >
                  <span
                    >${t("memoryPage.memories.score", {
                      score: result.score.toFixed(2),
                    })}</span
                  >
                </span>
              `;
              return html`<article class="memory-memories__result">
                ${expandable
                  ? html`<button
                      type="button"
                      class="settings-row settings-row--nav"
                      aria-expanded=${String(open)}
                      aria-controls=${panelId}
                      @click=${() => this.toggleResult(result, index)}
                    >
                      ${summary}
                    </button>`
                  : html`<div class="settings-row">${summary}</div>`}
                ${expandable ? this.renderDetail(key, panelId, result) : nothing}
              </article>`;
            })}
          </div>`}
    `;
  }

  private renderSearchState() {
    switch (this.searchState.kind) {
      case "loading":
        return html`<p class="memory-memories__state" role="status">
          ${t("memoryPage.memories.searching")}
        </p>`;
      case "error": {
        const failed = this.searchState;
        return html`<div class="memory-memories__state" role="alert">
          <p>${t("memoryPage.memories.error", { message: failed.message })}</p>
          <button class="btn btn--sm" @click=${() => void this.search(failed.query)}>
            ${t("memoryPage.memories.retry")}
          </button>
        </div>`;
      }
      case "ready":
        return this.renderResults(this.searchState);
      default:
        return html`<p class="memory-memories__state">${t("memoryPage.memories.idle")}</p>`;
    }
  }

  override render() {
    return html`<div class="settings-page memory-memories">
      ${!this.methodAdvertised
        ? html`<p class="memory-memories__unavailable">
            ${t("memoryPage.memories.gatewayUpdateRequired")}
          </p>`
        : html`<form
              class="memory-memories__search"
              role="search"
              @submit=${(event: SubmitEvent) => {
                event.preventDefault();
                void this.search(this.query);
              }}
            >
              <label class="settings-control__sr-label" for="memory-search-input"
                >${t("memoryPage.memories.searchLabel")}</label
              >
              <input
                id="memory-search-input"
                type="search"
                class="settings-input"
                .value=${this.query}
                placeholder=${t("memoryPage.memories.searchPlaceholder")}
                @input=${(event: InputEvent) => {
                  this.query = (event.currentTarget as HTMLInputElement).value;
                }}
              />
              <button
                class="btn btn--sm primary"
                type="submit"
                ?disabled=${!this.connected ||
                !this.agentId ||
                !this.query.trim() ||
                this.searchState.kind === "loading"}
              >
                ${t("memoryPage.memories.searchButton")}
              </button>
            </form>
            ${this.renderSearchState()}`}
    </div>`;
  }
}

if (!customElements.get("openclaw-memory-memories")) {
  customElements.define("openclaw-memory-memories", MemoryMemoriesElement);
}
