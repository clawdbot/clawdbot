// Control UI component renders the command palette.
import { consume } from "@lit/context";
import { html, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import { ref } from "lit/directives/ref.js";
import type { RouteId } from "../app-route-paths.ts";
import { applicationContext, type ApplicationContext } from "../app/context.ts";
import { t } from "../i18n/index.ts";
import { formatRelativeTimestamp } from "../lib/format.ts";
import { resolveSessionDisplayName } from "../lib/session-display.ts";
import { getVisibleSessionRows } from "../lib/sessions/index.ts";
import { normalizeLowercaseStringOrEmpty, normalizeOptionalString } from "../lib/string-coerce.ts";
import { OpenClawLightDomContentsElement } from "../lit/openclaw-element.ts";
import { SubscriptionsController } from "../lit/subscriptions-controller.ts";
import { icons, type IconName } from "./icons.ts";

type PaletteItem = {
  id: string;
  label: string;
  icon: IconName;
  category: "search" | "navigation" | "skills" | "chats";
  action: string;
  description?: string;
};

const SESSION_ACTION_PREFIX = "session:";
const SESSION_SEARCH_DEBOUNCE_MS = 250;
const SESSION_SEARCH_LIMIT = 10;
const SESSION_SEARCH_MAX_PAGES = 4;
const SESSION_SEARCH_PAGE_SIZE = 50;

export const COMMAND_PALETTE_TARGET_EVENT = "openclaw-command-palette-target";

export type CommandPaletteTargetDetail = {
  owner: Element;
  onSlashCommand: ((command: string) => void) | null;
};

function getPaletteBaseItems(): PaletteItem[] {
  return [
    {
      id: "nav-new-session",
      label: t("newSession.title"),
      icon: "plus",
      category: "navigation",
      action: "nav:new-session",
    },
    {
      id: "nav-sessions",
      label: t("palette.items.sessions"),
      icon: "fileText",
      category: "navigation",
      action: "nav:sessions",
    },
    {
      id: "nav-cron",
      label: t("palette.items.scheduled"),
      icon: "scrollText",
      category: "navigation",
      action: "nav:cron",
    },
    {
      id: "nav-skills",
      label: t("palette.items.skills"),
      icon: "zap",
      category: "navigation",
      action: "nav:skills",
    },
    {
      id: "nav-plugins",
      label: t("palette.items.plugins"),
      icon: "puzzle",
      category: "navigation",
      action: "nav:plugins",
    },
    {
      id: "nav-config",
      label: t("palette.items.settings"),
      icon: "settings",
      category: "navigation",
      action: "nav:config",
    },
    {
      id: "nav-agents",
      label: t("palette.items.agents"),
      icon: "folder",
      category: "navigation",
      action: "nav:agents",
    },
    {
      id: "slash:verbose",
      label: "/verbose",
      icon: "terminal",
      category: "search",
      action: "/verbose full",
      description: "Toggle verbose mode.",
    },
  ];
}

function getPaletteItemsInternal(): PaletteItem[] {
  return getPaletteBaseItems();
}

type CommandPaletteProps = {
  open: boolean;
  query: string;
  activeIndex: number;
  sessionItems: readonly PaletteItem[];
  onToggle: () => void;
  onQueryChange: (query: string) => void;
  onActiveIndexChange: (index: number) => void;
  onNavigate: (routeId: RouteId) => void;
  onSelectSession?: (sessionKey: string) => void;
  onSlashCommand?: (command: string) => void;
  onDialogRef: (element: Element | undefined) => void;
  onInputRef: (element: Element | undefined) => void;
};

function filteredItems(
  query: string,
  includeSlashCommands = true,
  sessionItems: readonly PaletteItem[] = [],
): PaletteItem[] {
  const items = getPaletteItemsInternal().filter(
    (item) => includeSlashCommands || item.category !== "search",
  );
  if (!query) {
    return items;
  }
  const q = normalizeLowercaseStringOrEmpty(query);
  const matches = items.filter(
    (item) =>
      normalizeLowercaseStringOrEmpty(item.label).includes(q) ||
      normalizeLowercaseStringOrEmpty(item.description).includes(q),
  );
  // Gateway search already matched the chat rows, so lead with those before
  // local navigation and slash-command matches.
  return [...sessionItems, ...matches];
}

function groupItems(items: PaletteItem[]): Array<[string, PaletteItem[]]> {
  const map = new Map<string, PaletteItem[]>();
  for (const item of items) {
    const group = map.get(item.category) ?? [];
    group.push(item);
    map.set(item.category, group);
  }
  return [...map.entries()];
}

let previouslyFocused: Element | null = null;
let activeDialog: HTMLDialogElement | null = null;

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "summary",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

const paletteDialogLabelId = "cmd-palette-label";
const paletteInputId = "cmd-palette-input";
const paletteListboxId = "cmd-palette-listbox";

function saveFocus() {
  if (previouslyFocused) {
    return;
  }
  previouslyFocused = document.activeElement;
}

function restoreFocus() {
  const target = previouslyFocused;
  previouslyFocused = null;
  activeDialog = null;
  if (target instanceof HTMLElement && target.isConnected) {
    requestAnimationFrame(() => {
      if (target.isConnected) {
        target.focus();
      }
    });
  }
}

function selectItem(item: PaletteItem, props: CommandPaletteProps) {
  if (item.action.startsWith("nav:")) {
    props.onNavigate(item.action.slice(4) as RouteId);
  } else if (item.action.startsWith(SESSION_ACTION_PREFIX)) {
    props.onSelectSession?.(item.action.slice(SESSION_ACTION_PREFIX.length));
  } else {
    props.onSlashCommand?.(item.action);
  }
  props.onToggle();
  restoreFocus();
}

function closePalette(props: CommandPaletteProps) {
  if (!activeDialog) {
    return;
  }
  props.onToggle();
  restoreFocus();
}

function scrollActiveIntoView() {
  requestAnimationFrame(() => {
    const el = document.querySelector(".cmd-palette__item--active");
    el?.scrollIntoView({ block: "nearest" });
  });
}

function trapFocus(event: KeyboardEvent, root: HTMLElement) {
  const focusable = [...root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)].filter(
    (element) => element.isConnected && element.tabIndex >= 0 && !element.closest("[hidden]"),
  );
  if (focusable.length === 0) {
    event.preventDefault();
    root.focus();
    return;
  }

  const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  const focusInside = active ? focusable.includes(active) : false;

  if (event.shiftKey && (!focusInside || active === first)) {
    event.preventDefault();
    last.focus();
    return;
  }
  if (!event.shiftKey && (!focusInside || active === last)) {
    event.preventDefault();
    first.focus();
  }
}

function handleKeydown(e: KeyboardEvent, props: CommandPaletteProps) {
  if (e.key === "Tab") {
    const dialog = (e.currentTarget as HTMLElement | null)?.closest("dialog");
    if (dialog instanceof HTMLElement) {
      trapFocus(e, dialog);
    }
    return;
  }

  const items = filteredItems(props.query, Boolean(props.onSlashCommand), props.sessionItems);
  if (items.length === 0 && (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter")) {
    return;
  }
  switch (e.key) {
    case "ArrowDown":
      e.preventDefault();
      props.onActiveIndexChange((props.activeIndex + 1) % items.length);
      scrollActiveIntoView();
      break;
    case "ArrowUp":
      e.preventDefault();
      props.onActiveIndexChange((props.activeIndex - 1 + items.length) % items.length);
      scrollActiveIntoView();
      break;
    case "Enter":
      e.preventDefault();
      if (items[props.activeIndex]) {
        selectItem(items[props.activeIndex], props);
      }
      break;
    case "Escape":
      e.preventDefault();
      e.stopPropagation();
      closePalette(props);
      break;
  }
}

function getCategoryLabel(category: string): string {
  switch (category) {
    case "search":
      return t("palette.categories.search");
    case "navigation":
      return t("palette.categories.navigation");
    case "skills":
      return t("palette.categories.skills");
    case "chats":
      return t("sessionsView.title");
    default:
      return category;
  }
}

function getOptionId(item: PaletteItem): string {
  return `cmd-palette-option-${item.id.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
}

function syncDialog(el: Element | undefined) {
  if (!(el instanceof HTMLDialogElement)) {
    if (activeDialog) {
      restoreFocus();
    }
    return;
  }
  if (activeDialog !== el) {
    saveFocus();
    activeDialog = el;
  }
  if (el.open) {
    return;
  }
  if (typeof el.showModal === "function") {
    try {
      el.removeAttribute("aria-modal");
      el.showModal();
      return;
    } catch {
      // Fall through to the open attribute fallback below.
    }
  }
  el.setAttribute("aria-modal", "true");
  el.setAttribute("open", "");
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
  const items = filteredItems(props.query, Boolean(props.onSlashCommand), props.sessionItems);
  const grouped = groupItems(items);
  const activeItem = items[props.activeIndex];
  const activeOptionId = activeItem ? getOptionId(activeItem) : nothing;
  const paletteLabel = t("palette.placeholder");

  return html`
    <dialog
      ${ref(props.onDialogRef)}
      class="cmd-palette-overlay"
      aria-labelledby=${paletteDialogLabelId}
      @cancel=${(e: Event) => {
        e.preventDefault();
        closePalette(props);
      }}
      @click=${(e: Event) => {
        if (e.target === e.currentTarget) {
          closePalette(props);
        }
      }}
    >
      <div
        class="cmd-palette"
        @click=${(e: Event) => e.stopPropagation()}
        @keydown=${(e: KeyboardEvent) => handleKeydown(e, props)}
      >
        <label id=${paletteDialogLabelId} class="cmd-palette__label" for=${paletteInputId}
          >${paletteLabel}</label
        >
        <input
          ${ref(props.onInputRef)}
          id=${paletteInputId}
          class="cmd-palette__input"
          role="combobox"
          aria-autocomplete="list"
          aria-controls=${paletteListboxId}
          aria-activedescendant=${activeOptionId}
          aria-expanded="true"
          placeholder=${paletteLabel}
          .value=${props.query}
          @input=${(e: Event) => {
            props.onQueryChange((e.target as HTMLInputElement).value);
            props.onActiveIndexChange(0);
          }}
        />
        <div id=${paletteListboxId} class="cmd-palette__results" role="listbox">
          ${grouped.length === 0
            ? html`<div class="cmd-palette__empty">
                <span class="nav-item__icon" style="opacity:0.3;width:20px;height:20px"
                  >${icons.search}</span
                >
                <span>${t("palette.noResults")}</span>
              </div>`
            : grouped.map(
                ([category, groupedItems]) => html`
                  <div class="cmd-palette__group-label">${getCategoryLabel(category)}</div>
                  ${groupedItems.map((item) => {
                    const globalIndex = items.indexOf(item);
                    const isActive = globalIndex === props.activeIndex;
                    return html`
                      <div
                        id=${getOptionId(item)}
                        class="cmd-palette__item ${isActive ? "cmd-palette__item--active" : ""}"
                        role="option"
                        aria-selected=${isActive ? "true" : "false"}
                        @click=${(e: Event) => {
                          e.stopPropagation();
                          selectItem(item, props);
                        }}
                        @mouseenter=${() => props.onActiveIndexChange(globalIndex)}
                      >
                        <span class="nav-item__icon">${icons[item.icon]}</span>
                        <span>${item.label}</span>
                        ${item.description
                          ? html`<span class="cmd-palette__item-desc muted"
                              >${item.description}</span
                            >`
                          : nothing}
                      </div>
                    `;
                  })}
                `,
              )}
        </div>
        <div class="cmd-palette__footer">
          <span><kbd>↑↓</kbd> ${t("palette.footer.navigate")}</span>
          <span><kbd>↵</kbd> ${t("palette.footer.select")}</span>
          <span><kbd>esc</kbd> ${t("palette.footer.close")}</span>
        </div>
      </div>
    </dialog>
  `;
}

export class CommandPalette extends OpenClawLightDomContentsElement {
  @property({ attribute: false }) onNavigate?: (routeId: RouteId) => void;
  @property({ attribute: false }) onSelectSession?: (sessionKey: string) => void;
  @property({ attribute: false }) onSlashCommand?: (command: string) => void;
  @consume({ context: applicationContext, subscribe: true })
  private context?: ApplicationContext<RouteId>;
  @state() private open = false;
  @state() private query = "";
  @state() private activeIndex = 0;
  @state() private sessionItems: readonly PaletteItem[] = [];

  private readonly subscriptions = new SubscriptionsController(this);
  private sessionSearchTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  private sessionSearchId = 0;
  private sessionSearchSource?: {
    gateway: ApplicationContext<RouteId>["gateway"];
    client: ApplicationContext<RouteId>["gateway"]["snapshot"]["client"];
    connected: boolean;
  };

  constructor() {
    super();
    this.subscriptions.watch(
      () => this.context?.gateway,
      (gateway, notify) => gateway.subscribe(notify),
      (gateway) => this.synchronizeGateway(gateway),
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
    this.activeIndex = 0;
    this.clearSessionSearch();
    this.sessionSearchSource = undefined;
    if (activeDialog) {
      activeDialog.close();
      restoreFocus();
    }
    super.disconnectedCallback();
  }

  openPalette() {
    this.open = true;
    this.query = "";
    this.activeIndex = 0;
    this.clearSessionSearch();
  }

  get isOpen(): boolean {
    return this.open;
  }

  private readonly togglePalette = () => {
    if (this.open) {
      this.open = false;
      this.clearSessionSearch();
      restoreFocus();
      return;
    }
    this.openPalette();
  };

  private readonly handleDialogRef = (element: Element | undefined) => {
    if (!this.open) {
      syncDialog(undefined);
      return;
    }
    syncDialog(element);
  };

  private readonly handleInputRef = (element: Element | undefined) => {
    if (this.open) {
      focusInput(element);
    }
  };

  private synchronizeGateway(gateway: ApplicationContext<RouteId>["gateway"]) {
    const snapshot = gateway.snapshot;
    const previous = this.sessionSearchSource;
    const sourceChanged = previous?.gateway !== gateway;
    const clientChanged = previous?.client !== snapshot.client;
    const reconnected = previous?.connected === false && snapshot.connected;
    this.sessionSearchSource = {
      gateway,
      client: snapshot.client,
      connected: snapshot.connected,
    };

    if (sourceChanged || clientChanged || !snapshot.connected) {
      // Query results belong to one runtime/client connection. Discard them as
      // soon as that owner changes so detached or reconnecting rows stay inert.
      this.clearSessionSearch();
    }
    if (snapshot.connected && (sourceChanged || clientChanged || reconnected)) {
      this.scheduleSessionSearch(this.query);
    }
  }

  private clearSessionSearch() {
    if (this.sessionSearchTimer !== null) {
      globalThis.clearTimeout(this.sessionSearchTimer);
      this.sessionSearchTimer = null;
    }
    this.sessionSearchId += 1;
    this.sessionItems = [];
  }

  private scheduleSessionSearch(query: string) {
    if (this.sessionSearchTimer !== null) {
      globalThis.clearTimeout(this.sessionSearchTimer);
      this.sessionSearchTimer = null;
    }
    // Invalidate the previous query immediately so late responses cannot
    // repopulate selectable stale rows during the debounce window.
    this.sessionSearchId += 1;
    this.sessionItems = [];
    const search = normalizeOptionalString(query);
    if (!this.open || !search || !this.onSelectSession) {
      return;
    }
    this.sessionSearchTimer = globalThis.setTimeout(() => {
      this.sessionSearchTimer = null;
      void this.searchSessions(search);
    }, SESSION_SEARCH_DEBOUNCE_MS);
  }

  private async searchSessions(search: string) {
    const context = this.context;
    const sessions = context?.sessions;
    const gateway = context?.gateway;
    const client = gateway?.snapshot.client;
    if (!sessions || !gateway?.snapshot.connected || !client) {
      return;
    }
    const requestId = ++this.sessionSearchId;
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
        if (
          requestId !== this.sessionSearchId ||
          !this.open ||
          this.context?.sessions !== sessions ||
          this.context?.gateway !== gateway ||
          gateway.snapshot.client !== client ||
          !gateway.snapshot.connected ||
          !result
        ) {
          return;
        }
        const pageRows = getVisibleSessionRows(result, {
          agentId: "",
          defaultAgentId: "",
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
      this.sessionItems = visibleRows.slice(0, SESSION_SEARCH_LIMIT).map((row) => ({
        id: `session-${row.key}`,
        label: resolveSessionDisplayName(row.key, row),
        icon: "messageSquare" as const,
        category: "chats" as const,
        action: `${SESSION_ACTION_PREFIX}${row.key}`,
        description: formatRelativeTimestamp(row.updatedAt, { fallback: "" }),
      }));
      this.activeIndex = 0;
    } catch {
      // Session search is best-effort; navigation commands stay usable.
    }
  }

  private readonly handleGlobalKeydown = (event: KeyboardEvent) => {
    if (!event.defaultPrevented && event.key === "Escape" && this.open) {
      event.preventDefault();
      this.togglePalette();
      return;
    }
    if ((event.metaKey || event.ctrlKey) && !event.shiftKey && event.key.toLowerCase() === "k") {
      event.preventDefault();
      this.togglePalette();
    }
  };

  override render() {
    return renderCommandPalette({
      open: this.open,
      query: this.query,
      activeIndex: this.activeIndex,
      sessionItems: this.sessionItems,
      onToggle: this.togglePalette,
      onQueryChange: (query) => {
        this.query = query;
        this.activeIndex = 0;
        this.scheduleSessionSearch(query);
      },
      onActiveIndexChange: (index) => {
        this.activeIndex = index;
      },
      onNavigate: (routeId) => this.onNavigate?.(routeId),
      onSelectSession: this.onSelectSession,
      onSlashCommand: this.onSlashCommand,
      onDialogRef: this.handleDialogRef,
      onInputRef: this.handleInputRef,
    });
  }
}

if (!customElements.get("openclaw-command-palette")) {
  customElements.define("openclaw-command-palette", CommandPalette);
}
