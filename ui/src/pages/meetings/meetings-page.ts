import "./meetings.css";
import { consume } from "@lit/context";
import { initialState, Task, TaskStatus } from "@lit/task";
import type {
  TranscriptsExportParams,
  TranscriptsExportResult,
  TranscriptsGetResult,
  TranscriptsListResult,
} from "@openclaw/gateway-protocol";
import { html, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import { hasOperatorReadAccess } from "../../app/operator-access.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { isArchiveAccessDeniedError } from "../../lib/gateway-errors.ts";
import { GatewayPageController } from "../../lit/gateway-page-controller.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import {
  transcriptListParams,
  transcriptRouteSearch,
  TRANSCRIPT_PAGE_SIZE,
  TRANSCRIPT_QUERY_LIMIT,
  TRANSCRIPT_FILTER_KEYS,
} from "./route-state.ts";
import { renderTranscripts, type TranscriptReadState } from "./view.ts";

type GatewayClient = NonNullable<ApplicationContext["gateway"]["snapshot"]["client"]>;
type ArchiveReadResults = {
  "transcripts.list": TranscriptsListResult;
  "transcripts.get": TranscriptsGetResult;
  "transcripts.export": TranscriptsExportResult;
};
// Keep a bounded reading window even when a room has stayed subscribed for days.
const READER_WINDOW_PAGES = 5;

class MeetingsPage extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  private context!: ApplicationContext;
  @property({ attribute: false }) routeSearch = "";
  private drafts: Record<string, string> = {};
  @state() private list: TranscriptsListResult | null = null;
  @state() private listDenial: unknown = null;
  @state() private readerDenial: unknown = null;
  private accessGeneration = 0;
  @state() private readerCursor: string | null = null;
  @state() private summary: TranscriptsGetResult | null = null;
  @state() private readerPages: TranscriptsGetResult[] = [];
  @state() private trimmed = false;
  @state() private exportState: { kind: "idle" | "loading" | "done" | "error"; message?: string } =
    { kind: "idle" };
  private connectionHello: unknown;
  private connectionAuth: unknown;
  private exportAbort: AbortController | null = null;
  private focusSelection = false;
  private readonly gateway = new GatewayPageController(this, {
    getGateway: () => this.context?.gateway,
    invalidateRequests: () => this.resetConnection(),
    onSnapshot: ({ snapshot: { hello } }) => {
      // A new handshake or authorization can replace a still-connected client.
      if (hello !== this.connectionHello || hello?.auth !== this.connectionAuth) {
        this.gateway.invalidate();
        this.resetConnection();
      }
      this.connectionHello = hello;
      this.connectionAuth = hello?.auth;
    },
  });

  private requestClient() {
    const snapshot = this.context?.gateway.snapshot;
    return this.isConnected &&
      snapshot?.phase === "connected" &&
      hasOperatorReadAccess(snapshot.hello?.auth ?? null)
      ? snapshot.client
      : null;
  }

  private get selection() {
    const query = new URLSearchParams(this.routeSearch);
    return {
      selector: query.get("selector") ?? "",
      query: (query.get("find") ?? "").slice(0, TRANSCRIPT_QUERY_LIMIT),
    };
  }

  private get readerTab(): "text" | "summary" {
    const params = new URLSearchParams(this.routeSearch);
    return params.get("tab") === "transcript" ||
      (!params.has("tab") && Boolean(this.selection.query))
      ? "text"
      : "summary";
  }

  private async readArchive<Method extends keyof ArchiveReadResults>(request: {
    client: GatewayClient;
    method: Method;
    params: unknown;
    signal: AbortSignal;
    current: () => boolean;
    accept: (result: ArchiveReadResults[Method]) => void;
  }) {
    const scope = this.gateway.capture();
    const gateway = this.context.gateway;
    const hello = gateway.snapshot.hello;
    const auth = gateway.snapshot.hello?.auth;
    const generation = this.accessGeneration;
    const current = () =>
      !request.signal.aborted &&
      this.requestClient() === request.client &&
      this.context.gateway === gateway &&
      gateway.snapshot.hello === hello &&
      gateway.snapshot.hello?.auth === auth &&
      scope !== null &&
      this.gateway.isCurrent(scope) &&
      this.accessGeneration === generation &&
      request.current();
    try {
      const result = await request.client.request<ArchiveReadResults[Method]>(
        request.method,
        request.params,
        {
          signal: request.signal,
        },
      );
      if (!current()) {
        return initialState;
      }
      return request.accept(result);
    } catch (error) {
      if (!current()) {
        return initialState;
      }
      if (isArchiveAccessDeniedError(error)) {
        // Archive access is shared across these RPCs. Retire every older request,
        // but leave Task args alone: changing cursors here would auto-retry denial.
        this.accessGeneration++;
        this.listDenial = error;
        this.readerDenial = error;
        this.list = null;
        this.summary = null;
        this.readerPages = [];
        this.trimmed = false;
        this.cancelExport();
      }
      throw error;
    }
  }

  private readonly listTask = new Task(this, {
    args: () =>
      [
        this.requestClient(),
        this.gateway.epoch,
        JSON.stringify(transcriptListParams(this.routeSearch)),
        this.selection.selector,
      ] as const,
    task: async ([client, , params, selector], { signal }) => {
      if (!client) {
        return initialState;
      }
      return this.readArchive({
        client,
        method: "transcripts.list",
        params: transcriptListParams(this.routeSearch),
        signal,
        current: () =>
          this.selection.selector === selector &&
          JSON.stringify(transcriptListParams(this.routeSearch)) === params,
        accept: (result) => {
          this.listDenial = null;
          this.list = result;
        },
      });
    },
  });

  private readonly summaryTask = new Task(this, {
    args: () => [this.requestClient(), this.gateway.epoch, this.selection.selector] as const,
    task: async ([client, , selector], { signal }) => {
      if (!client || !selector) {
        return initialState;
      }
      return this.readArchive({
        client,
        method: "transcripts.get",
        // Stored notes retain the shipped summary-read budget, independent of speech pages.
        params: { selector },
        signal,
        current: () => this.selection.selector === selector,
        accept: (result) => {
          this.readerDenial = null;
          this.summary = result;
        },
      });
    },
  });

  private readonly readerTask = new Task(this, {
    args: () =>
      [
        this.requestClient(),
        this.gateway.epoch,
        this.selection.selector,
        this.selection.query,
        this.readerCursor,
      ] as const,
    task: async ([client, , selector, query, cursor], { signal }) => {
      if (!client || !selector) {
        return initialState;
      }
      return this.readArchive({
        client,
        method: "transcripts.get",
        params: {
          selector,
          includeUtterances: true,
          query: query || undefined,
          cursor: cursor ?? undefined,
          limit: TRANSCRIPT_PAGE_SIZE,
        },
        signal,
        current: () =>
          this.selection.selector === selector &&
          this.selection.query === query &&
          this.readerCursor === cursor,
        accept: (result) => {
          this.readerDenial = null;
          const pages = cursor ? [...this.readerPages, result] : [result];
          this.trimmed ||= pages.length > READER_WINDOW_PAGES;
          this.readerPages = pages.slice(-READER_WINDOW_PAGES);
        },
      });
    },
  });

  override willUpdate(changed: PropertyValues) {
    if (changed.has("routeSearch")) {
      const previous = new URLSearchParams(String(changed.get("routeSearch") ?? ""));
      const next = new URLSearchParams(this.routeSearch);
      if (previous.get("selector") !== next.get("selector")) {
        this.summary = null;
      }
      // Only route-owned changes replace drafts; async reader/list work does not.
      for (const key of [...TRANSCRIPT_FILTER_KEYS, "find"]) {
        if (
          previous.get(key) !== next.get(key) ||
          changed.get("routeSearch") === undefined ||
          (key === "find" && previous.get("selector") !== next.get("selector"))
        ) {
          this.drafts[key] = next.get(key) ?? "";
        }
      }
      if (
        previous.get("selector") !== (this.selection.selector || null) ||
        previous.get("find") !== (this.selection.query || null)
      ) {
        this.resetReader();
        this.cancelExport();
        this.focusSelection = changed.get("routeSearch") !== undefined;
      }
    }
  }

  override updated() {
    if (!this.focusSelection) {
      return;
    }
    const target = this.selection.selector
      ? this.querySelector<HTMLElement>(".transcripts-reader h1, .transcripts-reader [role=alert]")
      : this.querySelector<HTMLElement>('.transcripts-library input[name="query"]');
    if (target) {
      target.focus();
      this.focusSelection = false;
    }
  }

  private resetConnection() {
    this.list = null;
    this.listDenial = null;
    this.readerDenial = null;
    this.summary = null;
    this.listTask.abort();
    this.summaryTask.abort();
    this.readerTask.abort();
    this.cancelExport();
    this.resetReader();
  }

  private resetReader() {
    this.readerCursor = null;
    this.readerPages = [];
    this.trimmed = false;
  }

  private cancelExport() {
    this.exportAbort?.abort();
    this.exportAbort = null;
    this.exportState = { kind: "idle" };
  }

  private navigate(patch: Record<string, string | null>) {
    // Clear/submit must also synchronize when the URL value was already equal.
    for (const [key, value] of Object.entries(patch)) {
      this.drafts[key] = value ?? "";
    }
    this.requestUpdate();
    this.context.navigate("meetings", {
      search: transcriptRouteSearch(this.routeSearch, patch),
    });
  }

  private refresh() {
    this.cancelExport();
    this.summary = null;
    this.resetReader();
    // A refresh starts a new cursor snapshot, rather than reusing an old list page.
    if (new URLSearchParams(this.routeSearch).has("cursor")) {
      this.navigate({ cursor: null });
    } else {
      void this.listTask.run();
    }
    void this.summaryTask.run();
    void this.readerTask.run();
  }

  private async download(format: TranscriptsExportParams["format"]) {
    const client = this.requestClient();
    const { selector } = this.selection;
    if (!client || !selector || this.exportState.kind === "loading") {
      return;
    }
    const abort = new AbortController();
    this.exportAbort = abort;
    this.exportState = { kind: "loading" };
    try {
      await this.readArchive({
        client,
        method: "transcripts.export",
        params: { selector, format },
        signal: abort.signal,
        current: () => this.selection.selector === selector,
        accept: (result) => {
          const bytes = Uint8Array.from(atob(result.data), (character) => character.charCodeAt(0));
          const url = URL.createObjectURL(new Blob([bytes], { type: result.mimeType }));
          const anchor = document.createElement("a");
          try {
            anchor.href = url;
            anchor.download = result.filename;
            document.body.append(anchor);
            anchor.click();
            this.exportState = { kind: "done" };
          } finally {
            anchor.remove();
            // Allow the browser to consume the object URL before releasing the bytes.
            window.setTimeout(() => URL.revokeObjectURL(url), 1000);
          }
        },
      });
    } catch (error) {
      if (this.exportAbort === abort && !abort.signal.aborted) {
        this.exportState = { kind: "error", message: formatUiError(error) };
      }
    } finally {
      if (this.exportAbort === abort) {
        this.exportAbort = null;
      }
    }
  }

  override render() {
    const snapshot = this.context.gateway.snapshot;
    const client = this.requestClient();
    const activeReaderTask = this.readerTab === "summary" ? this.summaryTask : this.readerTask;
    const reader: TranscriptReadState = {
      summary: this.summary,
      pages: this.readerPages,
      loading: activeReaderTask.status === TaskStatus.PENDING,
      error:
        this.readerDenial ??
        (activeReaderTask.status === TaskStatus.ERROR ? activeReaderTask.error : null),
      trimmed: this.trimmed,
    };
    return renderTranscripts({
      basePath: this.context.basePath,
      search: this.routeSearch,
      drafts: this.drafts,
      onDraft: (key, value) => {
        this.drafts[key] = value;
      },
      connected: snapshot.phase === "connected",
      allowed: hasOperatorReadAccess(snapshot.hello?.auth ?? null),
      list: client && this.listTask.status === TaskStatus.COMPLETE ? this.list : null,
      listLoading: !this.listDenial && this.listTask.status === TaskStatus.PENDING,
      listError:
        this.listDenial ?? (this.listTask.status === TaskStatus.ERROR ? this.listTask.error : null),
      reader,
      readerTab: this.readerTab,
      exportState: this.exportState,
      onNavigate: (patch) => this.navigate(patch),
      onRefresh: () => this.refresh(),
      onReaderRetry: () => {
        if (this.readerTab === "summary") {
          void this.summaryTask.run();
          return;
        }
        if (!this.readerPages.length) {
          this.resetReader();
        }
        if (!this.summary) {
          void this.summaryTask.run();
        }
        void this.readerTask.run();
      },
      onReaderTab: (tab) => {
        this.navigate({ tab: tab === "text" ? "transcript" : "summary" });
      },
      onLoadMore: () => {
        this.readerCursor = this.readerPages.at(-1)?.nextCursor ?? null;
      },
      onReaderStart: () => {
        this.resetReader();
        void this.readerTask.run();
      },
      onDownload: (format) => void this.download(format),
    });
  }
}

export const meetingsPageComponent = {
  header: true,
  render: (search: unknown) =>
    html`<openclaw-meetings-page
      .routeSearch=${typeof search === "string" ? search : ""}
    ></openclaw-meetings-page>`,
};

if (!customElements.get("openclaw-meetings-page")) {
  customElements.define("openclaw-meetings-page", MeetingsPage);
}
