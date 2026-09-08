// Control UI component renders the command palette.
import { consume } from "@lit/context";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { html, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import { ref } from "lit/directives/ref.js";
import { pathForAgentPanel, type RouteId } from "../app-route-paths.ts";
import { applicationContext, type ApplicationContext } from "../app/context.ts";
import { hasOperatorAdminAccess } from "../app/operator-access.ts";
import { t } from "../i18n/index.ts";
import { isGatewayMethodAdvertised } from "../lib/gateway-methods.ts";
import { filterVisibleSessionRows, getVisibleSessionRows } from "../lib/sessions/index.ts";
import {
  parseAgentSessionKey,
  resolveUiSelectedGlobalAgentId,
} from "../lib/sessions/session-key.ts";
import { searchVisibleSessionTranscripts } from "../lib/sessions/transcript-search.ts";
import { GatewayPageController } from "../lit/gateway-page-controller.ts";
import { OpenClawLightDomContentsElement } from "../lit/openclaw-element.ts";
import { SubscriptionsController } from "../lit/subscriptions-controller.ts";
import {
  commandPaletteCategoryLabel,
  filterCommandPaletteItems,
  getStaticCommandPaletteCatalogItems,
  loadCommandPaletteCatalogItems,
  toCommandPaletteItems,
  type CommandPaletteItem,
} from "./command-palette-catalog-search.ts";
import { isCommandPaletteShortcut } from "./command-palette-contract.ts";
import {
  buildCommandPaletteSessionItems,
  SESSION_ACTION_PREFIX,
  SESSION_SEARCH_LIMIT,
} from "./command-palette-session-search.ts";
import { icons } from "./icons.ts";
import "./modal-dialog.ts";
import {
  CUSTODIAN_PANEL_TOGGLE_EVENT,
  DESKTOP_PANEL_TOGGLE_EVENT,
} from "./panel-toggle-contract.ts";

type PaletteItem = CommandPaletteItem;

const SESSION_SEARCH_DEBOUNCE_MS = 50;
const SESSION_SEARCH_MIN_CHARS = 2;
const SESSION_SEARCH_MAX_PAGES = 4;
const SESSION_SEARCH_PAGE_SIZE = 50;
const SESSION_TRANSCRIPT_MAX_LIST_PAGES = 4;
const SESSION_TRANSCRIPT_MAX_REQUESTS = 4;
const SESSION_TRANSCRIPT_MAX_SESSION_KEYS = 200;
const CATALOG_CACHE_TTL_MS = 30_000;

type CommandPaletteProps = {
  basePath: string;
  open: boolean;
  query: string;
  activeId: string | null;
  sessionItems: readonly PaletteItem[];
  catalogItems: readonly PaletteItem[];
  modelSearchError: string | null;
  sessionSearchFailed: boolean;
  sessionSearchPartial: boolean;
  sessionSearchIncomplete: boolean;
  onToggle: () => void;
  onQueryChange: (query: string) => void;
  onActiveIdChange: (id: string) => void;
  onNavigate?: ApplicationContext<RouteId>["navigate"];
  onSelectSession?: (sessionKey: string) => void;
  onSlashCommand?: (command: string) => void;
  desktopAvailable: boolean;
  custodianAvailable: boolean;
  onInputRef: (element: Element | undefined) => void;
};

function groupItems(items: PaletteItem[]): Array<[string, PaletteItem[]]> {
  const map = new Map<string, PaletteItem[]>();
  for (const item of items) {
    const group = map.get(item.category) ?? [];
    group.push(item);
    map.set(item.category, group);
  }
  return [...map.entries()];
}

const paletteDialogLabelId = "cmd-palette-label";
const paletteInputId = "cmd-palette-input";
const paletteListboxId = "cmd-palette-listbox";

function selectItem(item: PaletteItem, props: CommandPaletteProps) {
  if (item.action.startsWith("nav:")) {
    const routeId = item.action.slice(4) as RouteId;
    if (item.agentId) {
      props.onNavigate?.(routeId, {
        pathname: pathForAgentPanel(item.agentId, null, props.basePath),
      });
    } else if (item.search || item.hash) {
      props.onNavigate?.(routeId, { search: item.search, hash: item.hash });
    } else {
      props.onNavigate?.(routeId);
    }
  } else if (item.action.startsWith(SESSION_ACTION_PREFIX)) {
    props.onSelectSession?.(item.action.slice(SESSION_ACTION_PREFIX.length));
  } else if (item.action === "panel:desktop") {
    window.dispatchEvent(new CustomEvent(DESKTOP_PANEL_TOGGLE_EVENT, { detail: { open: true } }));
  } else if (item.action === "panel:custodian") {
    window.dispatchEvent(new CustomEvent(CUSTODIAN_PANEL_TOGGLE_EVENT, { detail: { open: true } }));
  } else {
    props.onSlashCommand?.(item.action);
  }
  props.onToggle();
}

function closePalette(props: CommandPaletteProps) {
  props.onToggle();
}

function scrollActiveIntoView() {
  requestAnimationFrame(() => {
    const el = document.querySelector(".cmd-palette__item--active");
    el?.scrollIntoView({ block: "nearest" });
  });
}

function handleKeydown(
  e: KeyboardEvent,
  props: CommandPaletteProps,
  items: PaletteItem[],
  activeIndex: number,
) {
  if (items.length === 0 && (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter")) {
    return;
  }
  switch (e.key) {
    case "ArrowDown":
      e.preventDefault();
      props.onActiveIdChange(items[(activeIndex + 1) % items.length]!.id);
      scrollActiveIntoView();
      break;
    case "ArrowUp":
      e.preventDefault();
      props.onActiveIdChange(items[(activeIndex - 1 + items.length) % items.length]!.id);
      scrollActiveIntoView();
      break;
    case "Enter":
      e.preventDefault();
      {
        const item = items[activeIndex];
        if (item) {
          selectItem(item, props);
        }
      }
      break;
    case "Escape":
      e.preventDefault();
      e.stopPropagation();
      closePalette(props);
      break;
  }
}

function getOptionId(index: number): string {
  return `cmd-palette-option-${index}`;
}

function focusInput(el: Element | undefined) {
  if (el instanceof HTMLInputElement) {
    requestAnimationFrame(() => {
      if (el.isConnected) {
        el.focus();
      }
    });
  }
}

function renderCommandPalette(props: CommandPaletteProps) {
  if (!props.open) {
    return nothing;
  }
  const grouped = groupItems(
    filterCommandPaletteItems({ ...props, includeSlashCommands: Boolean(props.onSlashCommand) }),
  );
  const items = grouped.flatMap(([, entries]) => entries);
  // Preserve explicit selection through transient result changes, but only
  // highlight and execute current rows; an absent choice selects the first row.
  const activeIndex = Math.max(
    0,
    items.findIndex((item) => item.id === props.activeId),
  );
  const activeOptionId = items[activeIndex] ? getOptionId(activeIndex) : nothing;
  const paletteLabel = t("palette.placeholder");

  return html`
    <openclaw-modal-dialog
      class="cmd-palette-overlay palette"
      label=${paletteLabel}
      style="--openclaw-modal-width: min(640px, calc(100vw - 32px));"
      @modal-cancel=${() => closePalette(props)}
    >
      <div
        class="cmd-palette"
        @click=${(e: Event) => e.stopPropagation()}
        @keydown=${(e: KeyboardEvent) => handleKeydown(e, props, items, activeIndex)}
      >
        <label id=${paletteDialogLabelId} class="cmd-palette__label" for=${paletteInputId}
          >${paletteLabel}</label
        >
        <input
          ${ref(props.onInputRef)}
          autofocus
          id=${paletteInputId}
          class="cmd-palette__input"
          role="combobox"
          aria-autocomplete="list"
          aria-controls=${paletteListboxId}
          aria-activedescendant=${activeOptionId}
          aria-expanded="true"
          placeholder=${paletteLabel}
          .value=${props.query}
          @input=${(e: Event) => props.onQueryChange((e.target as HTMLInputElement).value)}
        />
        <div id=${paletteListboxId} class="cmd-palette__results" role="listbox">
          ${
            props.modelSearchError
              ? html`<div class="cmd-palette__empty" role="status">${props.modelSearchError}</div>`
              : nothing
          }
          ${
            props.sessionSearchFailed || props.sessionSearchPartial || props.sessionSearchIncomplete
              ? html`<div class="cmd-palette__empty" role="status">
                  ${t(
                    props.sessionSearchFailed
                      ? "palette.searchFailed"
                      : props.sessionSearchIncomplete
                        ? "palette.searchIncomplete"
                        : "palette.searchPartial",
                  )}
                </div>`
              : nothing
          }
          ${
            grouped.length === 0 && !props.sessionSearchFailed
              ? html`<div class="cmd-palette__empty">
                  <span class="nav-item__icon" style="opacity:0.3;width:20px;height:20px"
                    >${icons.search}</span
                  >
                  <span>${t("palette.noResults")}</span>
                </div>`
              : grouped.map(
                  ([category, groupedItems]) => html`
                    <div class="cmd-palette__group-label">
                      ${commandPaletteCategoryLabel(category)}
                    </div>
                    ${groupedItems.map((item) => {
                      const globalIndex = items.indexOf(item);
                      const isActive = globalIndex === activeIndex;
                      return html`
                        <div
                          id=${getOptionId(globalIndex)}
                          class="cmd-palette__item ${isActive ? "cmd-palette__item--active" : ""}"
                          role="option"
                          aria-selected=${isActive ? "true" : "false"}
                          @click=${(e: Event) => {
                            e.stopPropagation();
                            selectItem(item, props);
                          }}
                          @mouseenter=${() => props.onActiveIdChange(item.id)}
                        >
                          <span class="nav-item__icon">${icons[item.icon]}</span>
                          <span>${item.label}</span>
                          ${
                            item.description
                              ? html`<span class="cmd-palette__item-desc muted"
                                  >${item.description}</span
                                >`
                              : nothing
                          }
                        </div>
                      `;
                    })}
                  `,
                )
          }
        </div>
        <div class="cmd-palette__footer">
          <span><kbd>↑↓</kbd> ${t("palette.footer.navigate")}</span>
          <span><kbd>↵</kbd> ${t("palette.footer.select")}</span>
          <span><kbd>esc</kbd> ${t("palette.footer.close")}</span>
        </div>
      </div>
    </openclaw-modal-dialog>
  `;
}

export class CommandPalette extends OpenClawLightDomContentsElement {
  @property({ attribute: false }) onNavigate?: ApplicationContext<RouteId>["navigate"];
  @property({ attribute: false }) onSelectSession?: (sessionKey: string) => void;
  @property({ attribute: false }) onSlashCommand?: (command: string) => void;
  @property({ attribute: false }) desktopAvailable = false;
  @property({ attribute: false }) custodianAvailable = false;
  @consume({ context: applicationContext, subscribe: true })
  private context?: ApplicationContext<RouteId>;
  @state() private open = false;
  @state() private query = "";
  @state() private activeId: string | null = null;
  @state() private sessionItems: readonly PaletteItem[] = [];
  @state() private catalogItems: readonly PaletteItem[] = [];
  @state() private modelSearchError: string | null = null;
  @state() private sessionSearchFailed = false;
  @state() private sessionSearchPartial = false;
  @state() private sessionSearchIncomplete = false;

  private readonly subscriptions = new SubscriptionsController(this);
  private sessionSearchTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  private sessionSearchId = 0;
  private catalogLoad?: {
    client: NonNullable<ApplicationContext<RouteId>["gateway"]["snapshot"]["client"]>;
    agentId: string;
    promise: Promise<void>;
    loadedAt?: number;
  };
  private readonly gateway = new GatewayPageController(this, {
    getGateway: () => this.context?.gateway,
    invalidateRequests: () => {
      this.clearSessionSearch();
      this.clearCatalogSearch();
    },
    ensureInitialData: () => this.scheduleSessionSearch(this.query),
  });

  constructor() {
    super();
    this.subscriptions.effect(
      () => this.context?.gateway,
      (gateway) =>
        gateway.subscribeEvents((event) => {
          if (
            this.context?.gateway === gateway &&
            (event.event === "config.changed" || event.event === "chat.metadata.changed")
          ) {
            if (this.open) {
              void this.ensureCatalogItems(true);
            } else {
              this.clearCatalogSearch();
            }
          }
        }),
    );
    this.subscriptions.watch(
      () => this.context?.agentSelection,
      (selection, notify) => selection.subscribe(notify),
      () => {
        this.clearCatalogSearch();
        this.scheduleSessionSearch(this.query);
      },
    );
  }

  override connectedCallback() {
    super.connectedCallback();
    document.addEventListener("keydown", this.handleGlobalKeydown);
  }

  override disconnectedCallback() {
    document.removeEventListener("keydown", this.handleGlobalKeydown);
    this.open = false;
    this.query = "";
    this.activeId = null;
    this.clearSessionSearch();
    this.clearCatalogSearch();
    super.disconnectedCallback();
  }

  openPalette() {
    this.open = true;
    this.query = "";
    this.activeId = null;
    this.clearSessionSearch();
  }

  get isOpen(): boolean {
    return this.open;
  }

  readonly togglePalette = () => {
    if (this.open) {
      this.open = false;
      this.clearSessionSearch();
      return;
    }
    this.openPalette();
  };

  private readonly handleInputRef = (element: Element | undefined) => {
    if (this.open) {
      focusInput(element);
    }
  };

  private clearSessionSearch() {
    if (this.sessionSearchTimer !== null) {
      globalThis.clearTimeout(this.sessionSearchTimer);
      this.sessionSearchTimer = null;
    }
    this.sessionSearchId += 1;
    this.sessionItems = [];
    this.sessionSearchFailed = false;
    this.sessionSearchPartial = false;
    this.sessionSearchIncomplete = false;
  }

  private clearCatalogSearch() {
    this.catalogLoad = undefined;
    this.catalogItems = [];
    this.modelSearchError = null;
  }

  private ensureCatalogItems(force = false): Promise<void> {
    const context = this.context;
    const gateway = context?.gateway;
    const client = gateway?.snapshot.client;
    if (!context || !this.gateway.connected || !gateway || !client) {
      return Promise.resolve();
    }
    const agentId =
      context.agentSelection.state.selectedId ?? resolveUiSelectedGlobalAgentId(gateway.snapshot);
    const current = this.catalogLoad;
    if (
      !force &&
      current?.client === client &&
      current.agentId === agentId &&
      (current.loadedAt === undefined || Date.now() - current.loadedAt < CATALOG_CACHE_TTL_MS)
    ) {
      return current.promise;
    }
    const snapshot = gateway.snapshot;
    const previousModels =
      current?.client === client && current.agentId === agentId
        ? this.catalogItems.filter((item) => item.category === "models")
        : [];
    const promise = loadCommandPaletteCatalogItems({
      client,
      agentId,
      agents: () => context.agents?.ensureList?.() ?? Promise.resolve(null),
      methodAvailable: (method) => Boolean(isGatewayMethodAdvertised(snapshot, method)),
    }).then(({ items, modelRequestFailed, modelSearchError }) => {
      if (
        this.catalogLoad?.promise === promise &&
        this.context?.gateway === gateway &&
        this.context?.agentSelection === context.agentSelection &&
        gateway.snapshot.client === client
      ) {
        this.catalogItems = [
          ...toCommandPaletteItems(items),
          ...(modelRequestFailed ? previousModels : []),
        ];
        this.modelSearchError = modelSearchError;
        this.catalogLoad.loadedAt = modelRequestFailed ? 0 : Date.now();
      }
    });
    this.catalogLoad = { client, agentId, promise };
    return promise;
  }

  private scheduleSessionSearch(query: string) {
    // Invalidate the previous query immediately so late responses cannot
    // repopulate selectable stale rows during the debounce window.
    this.clearSessionSearch();
    const search = normalizeOptionalString(query);
    if (!this.open || !search || search.length < SESSION_SEARCH_MIN_CHARS) {
      return;
    }
    this.sessionSearchTimer = globalThis.setTimeout(() => {
      this.sessionSearchTimer = null;
      void this.ensureCatalogItems();
      if (this.onSelectSession) {
        void this.searchSessions(search);
      }
    }, SESSION_SEARCH_DEBOUNCE_MS);
  }

  private async searchSessions(search: string) {
    const context = this.context;
    const sessions = context?.sessions;
    const gateway = context?.gateway;
    const client = gateway?.snapshot.client;
    if (!sessions || gateway?.snapshot.phase !== "connected" || !client) {
      return;
    }
    const requestId = ++this.sessionSearchId;
    const isCurrent = () =>
      requestId === this.sessionSearchId &&
      this.open &&
      this.context?.sessions === sessions &&
      this.context?.gateway === gateway &&
      this.context?.agentSelection === context?.agentSelection &&
      gateway.snapshot.client === client &&
      gateway.snapshot.phase === "connected";
    const transcriptSearchAvailable = isGatewayMethodAdvertised(
      gateway.snapshot,
      "sessions.search",
    );
    const defaultAgentId =
      context?.agentSelection.state.selectedId ?? resolveUiSelectedGlobalAgentId(gateway.snapshot);
    const transcriptSearch = transcriptSearchAvailable
      ? searchVisibleSessionTranscripts({
          client,
          query: search,
          result: undefined,
          listSessions: sessions.list,
          listOptions: {
            includeGlobal: false,
            includeUnknown: false,
            configuredAgentsOnly: true,
          },
          resolveAgentId: (sessionKey) =>
            parseAgentSessionKey(sessionKey)?.agentId ?? defaultAgentId,
          isCurrent,
          maxListPages: SESSION_TRANSCRIPT_MAX_LIST_PAGES,
          maxSearchRequests: SESSION_TRANSCRIPT_MAX_REQUESTS,
          maxSessionKeys: SESSION_TRANSCRIPT_MAX_SESSION_KEYS,
          mapPageRows: (rows) =>
            filterVisibleSessionRows(rows, {
              agentId: "",
              defaultAgentId,
              filterByAgent: false,
            }),
        })
          .then((result) => ({ error: false as const, result }))
          .catch(() => ({ error: true as const, result: null }))
      : Promise.resolve(null);
    const visibleRows: ReturnType<typeof getVisibleSessionRows> = [];
    const visibleKeys = new Set<string>();
    const seenOffsets = new Set<number>([0]);
    let pagesLoaded = 0;
    let offset: number | undefined;
    try {
      while (visibleRows.length < SESSION_SEARCH_LIMIT && pagesLoaded < SESSION_SEARCH_MAX_PAGES) {
        const result = await sessions.list({
          search,
          limit: SESSION_SEARCH_PAGE_SIZE,
          ...(offset === undefined ? {} : { offset }),
          includeGlobal: false,
          includeUnknown: false,
        });
        pagesLoaded += 1;
        if (!isCurrent() || !result) {
          return;
        }
        const pageRows = getVisibleSessionRows(result, {
          agentId: "",
          defaultAgentId,
          filterByAgent: false,
        });
        for (const row of pageRows) {
          if (!visibleKeys.has(row.key)) {
            visibleKeys.add(row.key);
            visibleRows.push(row);
          }
        }
        if (visibleRows.length >= SESSION_SEARCH_LIMIT || !result.hasMore) {
          break;
        }
        const nextOffset =
          typeof result.nextOffset === "number" && Number.isFinite(result.nextOffset)
            ? Math.max(0, Math.floor(result.nextOffset))
            : result.sessions.length > 0
              ? (offset ?? 0) + result.sessions.length
              : null;
        // Malformed pagination must not turn a palette query into an RPC loop.
        if (nextOffset === null || seenOffsets.has(nextOffset)) {
          break;
        }
        seenOffsets.add(nextOffset);
        offset = nextOffset;
      }
      const transcriptOutcome = await transcriptSearch;
      if (!isCurrent()) {
        return;
      }
      const transcriptResult = transcriptOutcome?.result ?? null;
      this.sessionSearchPartial = transcriptOutcome?.error === true;
      this.sessionSearchIncomplete =
        transcriptOutcome?.error !== true &&
        (transcriptResult?.indexing === true || transcriptResult?.truncated === true);
      this.sessionItems = buildCommandPaletteSessionItems({
        visibleRows,
        visibleKeys,
        transcriptResult,
        search,
      });
    } catch {
      // Session search is best-effort; navigation commands stay usable. But a
      // failed search must not render as "No results" — that reads as a
      // successful search with zero matches and hides gateway-side failures
      // (e.g. a store needing doctor migration) from the operator.
      if (requestId === this.sessionSearchId && this.open) {
        this.sessionSearchFailed = true;
      }
    }
  }

  private readonly handleGlobalKeydown = (event: KeyboardEvent) => {
    if (!event.defaultPrevented && event.key === "Escape" && this.open) {
      event.preventDefault();
      this.togglePalette();
      return;
    }
    if (isCommandPaletteShortcut(event)) {
      event.preventDefault();
      this.togglePalette();
    }
  };

  override render() {
    return renderCommandPalette({
      basePath: this.context?.basePath ?? "",
      open: this.open,
      query: this.query,
      activeId: this.activeId,
      sessionItems: this.sessionItems,
      modelSearchError: this.modelSearchError,
      catalogItems: [
        ...toCommandPaletteItems(
          getStaticCommandPaletteCatalogItems(
            hasOperatorAdminAccess(this.context?.gateway.snapshot.hello?.auth ?? null),
            this.context?.nativeDeviceSettings,
          ),
        ),
        ...this.catalogItems,
      ],
      sessionSearchFailed: this.sessionSearchFailed,
      sessionSearchPartial: this.sessionSearchPartial,
      sessionSearchIncomplete: this.sessionSearchIncomplete,
      desktopAvailable: this.desktopAvailable,
      custodianAvailable: this.custodianAvailable,
      onToggle: this.togglePalette,
      onQueryChange: (query) => {
        this.query = query;
        this.activeId = null;
        this.scheduleSessionSearch(query);
      },
      onActiveIdChange: (id) => {
        this.activeId = id;
      },
      onNavigate: this.onNavigate,
      onSelectSession: this.onSelectSession,
      onSlashCommand: this.onSlashCommand,
      onInputRef: this.handleInputRef,
    });
  }
}

if (!customElements.get("openclaw-command-palette")) {
  customElements.define("openclaw-command-palette", CommandPalette);
}
