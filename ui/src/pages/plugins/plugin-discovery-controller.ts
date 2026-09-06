import { initialState, Task, TaskStatus } from "@lit/task";
import type { ReactiveControllerHost } from "lit";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { formatUiError } from "../../lib/format-error.ts";
import type { GatewayConnectionScope } from "../../lib/gateway-connection-lifecycle.ts";
import type {
  PluginDiscoveryCategoriesResult,
  PluginDiscoveryCategory,
  PluginDiscoveryEntry,
  PluginDiscoveryResult,
} from "../../lib/plugins/index.ts";
import type { PluginDiscoveryIntent } from "./catalog-results.ts";
import type { PluginCardAttribution } from "./plugin-card.ts";

const CATALOG_PAGE_SIZE = 25;

type CatalogPageLoad = {
  items: PluginDiscoveryEntry[];
  overflow: PluginDiscoveryEntry[];
  nextCursor?: string;
  observed: PluginDiscoveryEntry[];
};

type PluginDiscoveryGateway = {
  getClient: () => GatewayBrowserClient | null;
  isConnected: () => boolean;
  capture: () => GatewayConnectionScope | null;
  isCurrent: (scope: GatewayConnectionScope) => boolean;
};

export class PluginDiscoveryController {
  result: PluginDiscoveryResult | null = null;
  error: string | null = null;
  categories: PluginDiscoveryCategory[] = [];
  categoriesError: string | null = null;
  featured: PluginDiscoveryEntry[] = [];
  featuredError: string | null = null;
  intent: PluginDiscoveryIntent = "all";
  category: string | null = null;
  query = "";
  paging = false;

  private committedQuery = "";
  private searchTimer: ReturnType<typeof setTimeout> | null = null;
  private pageIndex = 0;
  private pages: PluginDiscoveryEntry[][] = [];
  private overflow: PluginDiscoveryEntry[] = [];
  private nextCursor: string | undefined;
  private pageRequestEpoch = 0;
  private readonly entriesById = new Map<string, PluginDiscoveryEntry>();
  private readonly browseTask: Task;
  private readonly categoriesTask: Task;
  private readonly featuredTask: Task;

  constructor(
    private readonly host: ReactiveControllerHost,
    private readonly gateway: PluginDiscoveryGateway,
  ) {
    this.browseTask = new Task(host, {
      // Scope changes call refresh(), which invalidates manual pagination before this task runs.
      autoRun: false,
      args: () =>
        [
          this.gateway.isConnected() ? this.gateway.getClient() : null,
          this.intent,
          this.category,
          this.committedQuery,
        ] as const,
      task: ([client, intent, category, query], { signal }) =>
        client
          ? this.fetchAvailablePage({ client, intent, category, query, signal })
          : initialState, // Lit returns to INITIAL without invoking onComplete.
      onComplete: (page) => {
        this.pages = [page.items];
        this.overflow = page.overflow;
        this.nextCursor = page.nextCursor;
        this.result = { items: page.items };
        this.rememberEntries(page.observed);
      },
      onError: (error) => {
        this.error = formatUiError(error);
      },
    });
    this.categoriesTask = new Task(host, {
      autoRun: false,
      args: () => [this.gateway.isConnected() ? this.gateway.getClient() : null] as const,
      task: ([client], { signal }) =>
        client
          ? client.request<PluginDiscoveryCategoriesResult>(
              "plugins.catalog.categories",
              {},
              { signal },
            )
          : initialState,
      onComplete: (result) => {
        this.categories = result.categories;
      },
      onError: (error) => {
        this.categoriesError = formatUiError(error);
      },
    });
    this.featuredTask = new Task(host, {
      autoRun: false,
      args: () => [this.gateway.isConnected() ? this.gateway.getClient() : null] as const,
      task: ([client], { signal }) =>
        client
          ? client.request<PluginDiscoveryResult>(
              "plugins.catalog.browse",
              { intent: "featured", pageSize: 9 },
              { signal },
            )
          : initialState,
      onComplete: (result) => {
        this.featured = result.items.filter((plugin) => !plugin.local.enabled).slice(0, 9);
        this.rememberEntries(result.items);
      },
      onError: (error) => {
        this.featuredError = formatUiError(error);
      },
    });
  }

  get loading(): boolean {
    return this.gateway.isConnected() && this.browseTask.status === TaskStatus.PENDING;
  }

  get featuredLoading(): boolean {
    return this.gateway.isConnected() && this.featuredTask.status === TaskStatus.PENDING;
  }

  get pageNumber(): number {
    return this.pageIndex + 1;
  }

  get canGoPrevious(): boolean {
    return !this.committedQuery && this.pageIndex > 0;
  }

  get canGoNext(): boolean {
    return (
      !this.committedQuery &&
      (this.pageIndex + 1 < this.pages.length ||
        this.overflow.length > 0 ||
        Boolean(this.nextCursor))
    );
  }

  get attributions(): ReadonlyMap<string, PluginCardAttribution> {
    const attributions = new Map<string, PluginCardAttribution>();
    for (const entry of this.entriesById.values()) {
      if (!entry.local.pluginId) {
        continue;
      }
      attributions.set(entry.local.pluginId, {
        ...(entry.catalog.author ? { author: entry.catalog.author } : {}),
        official: entry.catalog.official,
      });
    }
    return attributions;
  }

  private rememberEntries(entries: readonly PluginDiscoveryEntry[]): void {
    for (const entry of entries) {
      this.entriesById.set(entry.id, entry);
    }
  }

  private async fetchAvailablePage(params: {
    client: GatewayBrowserClient;
    intent: PluginDiscoveryIntent;
    category: string | null;
    query: string;
    overflow?: readonly PluginDiscoveryEntry[];
    cursor?: string;
    signal?: AbortSignal;
  }): Promise<CatalogPageLoad> {
    const available = [...(params.overflow ?? [])];
    const observed: PluginDiscoveryEntry[] = [];
    let cursor = params.cursor;
    let shouldFetch = true;

    while (available.length < CATALOG_PAGE_SIZE && shouldFetch) {
      const page = await params.client.request<PluginDiscoveryResult>(
        "plugins.catalog.browse",
        {
          intent: params.intent,
          ...(params.category ? { category: params.category } : {}),
          ...(params.query ? { query: params.query } : {}),
          ...(cursor ? { cursor } : {}),
          pageSize: CATALOG_PAGE_SIZE,
        },
        params.signal ? { signal: params.signal } : undefined,
      );
      observed.push(...page.items);
      available.push(...page.items.filter((plugin) => !plugin.local.installed));
      cursor = page.nextCursor;
      shouldFetch = !params.query && Boolean(cursor);
    }

    return {
      items: available.slice(0, CATALOG_PAGE_SIZE),
      overflow: available.slice(CATALOG_PAGE_SIZE),
      ...(cursor ? { nextCursor: cursor } : {}),
      observed,
    };
  }

  ensureInitial(): void {
    if (!this.gateway.isConnected() || !this.gateway.getClient()) {
      return;
    }
    if (this.browseTask.status === TaskStatus.INITIAL && !this.result && !this.error) {
      void this.refresh();
    }
    if (
      this.categoriesTask.status === TaskStatus.INITIAL &&
      this.categories.length === 0 &&
      !this.categoriesError
    ) {
      void this.refreshCategories();
    }
    if (
      this.featuredTask.status === TaskStatus.INITIAL &&
      this.featured.length === 0 &&
      !this.featuredError
    ) {
      void this.refreshFeatured();
    }
  }

  invalidate(): void {
    void this.browseTask.run([null, this.intent, this.category, this.committedQuery]);
    void this.categoriesTask.run([null]);
    void this.featuredTask.run([null]);
    this.result = null;
    this.error = null;
    this.categories = [];
    this.categoriesError = null;
    this.featured = [];
    this.featuredError = null;
    this.entriesById.clear();
    this.resetPagination();
  }

  disconnect(): void {
    if (this.searchTimer) {
      clearTimeout(this.searchTimer);
      this.searchTimer = null;
    }
  }

  async refresh(): Promise<void> {
    const client = this.gateway.getClient();
    if (!client || !this.gateway.isConnected()) {
      return;
    }
    this.error = null;
    this.resetPagination();
    await this.browseTask.run([client, this.intent, this.category, this.committedQuery]);
  }

  async refreshCategories(): Promise<void> {
    const client = this.gateway.getClient();
    if (!client || !this.gateway.isConnected()) {
      return;
    }
    this.categoriesError = null;
    await this.categoriesTask.run([client]);
  }

  async refreshFeatured(): Promise<void> {
    const client = this.gateway.getClient();
    if (!client || !this.gateway.isConnected()) {
      return;
    }
    this.featuredError = null;
    await this.featuredTask.run([client]);
  }

  selectIntent(intent: PluginDiscoveryIntent): void {
    this.intent = intent;
    void this.refresh();
  }

  selectCategory(category: string | null): void {
    this.category = category;
    void this.refresh();
  }

  updateQuery(query: string): void {
    this.query = query;
    this.host.requestUpdate();
    if (this.searchTimer) {
      clearTimeout(this.searchTimer);
    }
    this.searchTimer = setTimeout(() => {
      this.searchTimer = null;
      this.committedQuery = query.trim();
      void this.refresh();
    }, 250);
  }

  async previousPage(): Promise<void> {
    if (!this.canGoPrevious || this.paging) {
      return;
    }
    this.showPage(this.pageIndex - 1);
  }

  async nextPage(): Promise<void> {
    if (!this.canGoNext || this.paging) {
      return;
    }
    const targetIndex = this.pageIndex + 1;
    if (targetIndex < this.pages.length) {
      this.showPage(targetIndex);
      return;
    }
    await this.loadNextPage(targetIndex);
  }

  private resetPagination(): void {
    this.pageRequestEpoch += 1;
    this.pageIndex = 0;
    this.pages = [];
    this.overflow = [];
    this.nextCursor = undefined;
    this.paging = false;
  }

  private showPage(targetIndex: number): void {
    const items = this.pages[targetIndex];
    if (!items) {
      return;
    }
    this.pageIndex = targetIndex;
    this.result = { items };
    this.host.requestUpdate();
  }

  private async loadNextPage(targetIndex: number): Promise<void> {
    const scope = this.gateway.capture();
    if (!scope || this.committedQuery) {
      return;
    }
    const requestEpoch = ++this.pageRequestEpoch;
    this.paging = true;
    this.error = null;
    this.host.requestUpdate();
    try {
      const page = await this.fetchAvailablePage({
        client: scope.client,
        intent: this.intent,
        category: this.category,
        query: "",
        overflow: this.overflow,
        cursor: this.nextCursor,
      });
      if (!this.gateway.isCurrent(scope) || requestEpoch !== this.pageRequestEpoch) {
        return;
      }
      this.overflow = page.overflow;
      this.nextCursor = page.nextCursor;
      this.rememberEntries(page.observed);
      if (page.items.length === 0) {
        return;
      }
      this.pageIndex = targetIndex;
      this.pages.push(page.items);
      this.result = { items: page.items };
    } catch (error) {
      if (this.gateway.isCurrent(scope) && requestEpoch === this.pageRequestEpoch) {
        this.error = formatUiError(error);
      }
    } finally {
      if (this.gateway.isCurrent(scope) && requestEpoch === this.pageRequestEpoch) {
        this.paging = false;
        this.host.requestUpdate();
      }
    }
  }
}
