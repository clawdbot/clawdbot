import { html } from "lit";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import { pathForWorkboardBoard } from "../app-route-paths.ts";
import { t } from "../i18n/index.ts";
import { workboardBoardLabel } from "../lib/workboard/board-presentation.ts";
import { normalizeBoardsPayload } from "../lib/workboard/normalization.ts";
import { getWorkboardState } from "../lib/workboard/runtime.ts";
import type { WorkboardBoardSummary } from "../lib/workboard/types.ts";
import type {
  SidebarWorkboardRenderers,
  SidebarWorkboardHost,
  SidebarWorkboardRuntime,
  SidebarWorkboardSnapshot,
} from "./app-sidebar-workboard.ts";
import { renderWorkboardBoardGlyph } from "./workboard-board-glyph.ts";

const WORKBOARD_CHANGED_EVENT = "plugin.workboard.changed";
const RETRY_MS = 2_000;

type CatalogLoad = { client: GatewayBrowserClient; promise: Promise<boolean> };

class SidebarWorkboardCatalog implements SidebarWorkboardRuntime {
  private client: GatewayBrowserClient | null = null;
  private connected = false;
  private disposed = false;
  private generation = 0;
  private load: CatalogLoad | null = null;
  private retryTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  private snapshot: SidebarWorkboardSnapshot = { boards: [], ready: false };

  constructor(
    private readonly onSnapshot: (snapshot: SidebarWorkboardSnapshot) => void,
    private readonly host: SidebarWorkboardHost,
  ) {}

  sync(client: GatewayBrowserClient | null, connected: boolean): void {
    if (this.disposed) {
      return;
    }
    const reconnecting = connected && !this.connected && this.snapshot.ready;
    this.connected = connected;
    if (!connected || !client) {
      this.clearRetry();
      return;
    }
    if (this.client !== client) {
      this.client = client;
      this.generation += 1;
      this.load = null;
      this.publishCatalog([], false);
    }
    this.ensureAndRecover(reconnecting);
  }

  handleGatewayEvent(event: string): void {
    if (event === WORKBOARD_CHANGED_EVENT && this.connected && this.client) {
      this.ensureAndRecover(true);
    }
  }

  dispose(): void {
    this.disposed = true;
    this.generation += 1;
    this.load = null;
    this.clearRetry();
    this.host.clearBoards();
  }

  private ensureAndRecover(force: boolean): void {
    const client = this.client;
    if (!client || !this.connected) {
      return;
    }
    void this.ensure(client, force).then((loaded) => {
      if (this.disposed || !this.connected || this.client !== client) {
        return;
      }
      if (loaded) {
        this.clearRetry();
        return;
      }
      if (!force && this.snapshot.ready) {
        return;
      }
      if (this.retryTimer === null) {
        this.retryTimer = globalThis.setTimeout(() => {
          this.retryTimer = null;
          this.ensureAndRecover(true);
        }, RETRY_MS);
      }
    });
  }

  private async ensure(client: GatewayBrowserClient, force: boolean): Promise<boolean> {
    if (this.disposed || this.client !== client) {
      return false;
    }
    if (!force && this.snapshot.ready) {
      return false;
    }
    const currentLoad = this.load;
    if (currentLoad?.client === client) {
      const loaded = await currentLoad.promise;
      if (this.disposed || this.client !== client) {
        return false;
      }
      if (!force) {
        return loaded;
      }
      if (this.load && this.load !== currentLoad) {
        return await this.load.promise;
      }
      if (this.load === currentLoad) {
        this.load = null;
      }
      return await this.ensure(client, true);
    }
    const generation = ++this.generation;
    const pending = (async () => {
      try {
        const boards = normalizeBoardsPayload(await client.request("workboard.boards.list", {}));
        if (!boards || this.disposed || this.client !== client || generation !== this.generation) {
          return false;
        }
        this.publishCatalog(boards, true);
        return true;
      } catch {
        return false;
      }
    })();
    const load = { client, promise: pending };
    this.load = load;
    try {
      return await pending;
    } finally {
      if (this.load === load) {
        this.load = null;
      }
    }
  }

  private publishCatalog(boards: WorkboardBoardSummary[], ready: boolean): void {
    getWorkboardState(this.host).boards = boards;
    this.host.setBoardsReady(ready);
    this.host.notify();
    const snapshot: SidebarWorkboardSnapshot = {
      boards: boards.map(({ id, name, icon, color }) => ({
        id,
        ...(name ? { name } : {}),
        ...(icon ? { icon } : {}),
        ...(color ? { color } : {}),
      })),
      ready,
    };
    this.snapshot = snapshot;
    this.onSnapshot(snapshot);
  }

  private clearRetry(): void {
    if (this.retryTimer !== null) {
      globalThis.clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }
}

export function createSidebarWorkboardRuntime(
  onSnapshot: (snapshot: SidebarWorkboardSnapshot) => void,
  host: SidebarWorkboardHost,
): SidebarWorkboardRuntime {
  return new SidebarWorkboardCatalog(onSnapshot, host);
}

export const renderSidebarWorkboardEntry: SidebarWorkboardRenderers["renderEntry"] = (params) => {
  const pathname = pathForWorkboardBoard(params.board.id, params.basePath);
  return html`
    <a
      href=${pathname}
      class="nav-item nav-item--workboard-board ${params.active ? "nav-item--active" : ""}"
      aria-current=${params.active ? "page" : undefined}
      @click=${(event: MouseEvent) => {
        if (
          event.defaultPrevented ||
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey
        ) {
          return;
        }
        event.preventDefault();
        params.onNavigate(pathname);
      }}
    >
      <span class="nav-item__icon" aria-hidden="true"
        >${renderWorkboardBoardGlyph(params.board, "workboard-board-glyph--sidebar")}</span
      >
      <span class="nav-item__text">${workboardBoardLabel(params.board)}</span>
    </a>
  `;
};

export const renderSidebarWorkboardCustomize: SidebarWorkboardRenderers["renderCustomize"] = (
  boards,
  sidebarEntries,
) => html`
  <div class="sidebar-customize-menu__group-title">${t("nav.workboardGroup")}</div>
  ${boards.map((board) => {
    const entry = `workboard:${board.id}`;
    return html`
      <wa-dropdown-item
        class="sidebar-customize-menu__item"
        type="checkbox"
        value=${entry}
        .checked=${sidebarEntries.includes(entry)}
      >
        <span slot="icon" class="nav-item__icon" aria-hidden="true"
          >${renderWorkboardBoardGlyph(board, "workboard-board-glyph--sidebar")}</span
        >
        <span class="sidebar-customize-menu__text">${workboardBoardLabel(board)}</span>
      </wa-dropdown-item>
    `;
  })}
`;
