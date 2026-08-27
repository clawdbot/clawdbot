import type { RouteId } from "../app-routes.ts";
import {
  EMPTY_SIDEBAR_WORKBOARD_SNAPSHOT,
  type SidebarWorkboardRenderers,
  type SidebarWorkboardRuntime,
  type SidebarWorkboardRuntimeFactory,
  type SidebarWorkboardSnapshot,
} from "../components/app-sidebar-workboard.ts";
import { isWorkboardEnabledInConfigSnapshot } from "../lib/plugin-activation.ts";
import type { ApplicationContext } from "./context.ts";

export interface ShellWorkboardHost {
  readonly context: ApplicationContext<RouteId> | undefined;
  sidebarWorkboardSnapshot: SidebarWorkboardSnapshot;
  sidebarWorkboardRuntime: SidebarWorkboardRuntime | null;
  sidebarWorkboardHost: ApplicationContext["workboard"] | null;
  sidebarWorkboardRenderers: SidebarWorkboardRenderers | undefined;
  sidebarWorkboardRuntimeLoad: Promise<SidebarWorkboardRuntimeFactory> | null;
  sidebarWorkboardEpoch: number;
  requestUpdate(): void;
}

export class ShellWorkboardOwner {
  constructor(private readonly host: ShellWorkboardHost) {}

  syncSidebarWorkboard(): void {
    const host = this.host;
    const context = host.context;
    const snapshot = context?.gateway.snapshot;
    const configSnapshot = context?.runtimeConfig.state.configSnapshot;
    if (!context || !snapshot || !configSnapshot) {
      return;
    }
    if (!isWorkboardEnabledInConfigSnapshot(configSnapshot)) {
      this.disposeSidebarWorkboard();
      return;
    }
    const runtime = host.sidebarWorkboardRuntime;
    if (runtime) {
      if (host.sidebarWorkboardHost !== context.workboard) {
        this.disposeSidebarWorkboard();
        this.syncSidebarWorkboard();
        return;
      }
      runtime.sync(snapshot.client, snapshot.phase === "connected");
      return;
    }
    if (host.sidebarWorkboardRuntimeLoad) {
      return;
    }
    // Disposal advances the epoch so a stale lazy import cannot revive its retired owner.
    const epoch = host.sidebarWorkboardEpoch;
    const load = import("../components/app-sidebar-workboard.runtime.ts");
    host.sidebarWorkboardRuntimeLoad = load;
    void load
      .then((module) => {
        if (host.sidebarWorkboardEpoch !== epoch || host.sidebarWorkboardRuntime) {
          return;
        }
        const current = host.context;
        if (!current) {
          return;
        }
        const loadedRuntime = module.createSidebarWorkboardRuntime((nextSnapshot) => {
          if (host.sidebarWorkboardRuntime === loadedRuntime) {
            host.sidebarWorkboardSnapshot = nextSnapshot;
            host.requestUpdate();
          }
        }, current.workboard);
        host.sidebarWorkboardRuntime = loadedRuntime;
        host.sidebarWorkboardHost = current.workboard;
        host.sidebarWorkboardRenderers = {
          renderEntry: module.renderSidebarWorkboardEntry,
          renderCustomize: module.renderSidebarWorkboardCustomize,
        };
        const gateway = current?.gateway.snapshot;
        if (
          current &&
          gateway &&
          isWorkboardEnabledInConfigSnapshot(current.runtimeConfig.state.configSnapshot)
        ) {
          loadedRuntime.sync(gateway.client, gateway.phase === "connected");
        }
      })
      .catch(() => {
        if (host.sidebarWorkboardEpoch === epoch && host.sidebarWorkboardRuntimeLoad === load) {
          host.sidebarWorkboardRuntimeLoad = null;
        }
      });
  }

  disposeSidebarWorkboard(): void {
    const host = this.host;
    host.sidebarWorkboardEpoch += 1;
    const runtime = host.sidebarWorkboardRuntime;
    runtime?.dispose();
    if (!runtime) {
      // The capability can retain boards before its lazy runtime has materialized.
      host.context?.workboard.clearBoards();
    }
    host.sidebarWorkboardRuntime = null;
    host.sidebarWorkboardHost = null;
    host.sidebarWorkboardRenderers = undefined;
    host.sidebarWorkboardRuntimeLoad = null;
    if (host.sidebarWorkboardSnapshot !== EMPTY_SIDEBAR_WORKBOARD_SNAPSHOT) {
      host.sidebarWorkboardSnapshot = EMPTY_SIDEBAR_WORKBOARD_SNAPSHOT;
      host.requestUpdate();
    }
  }
}
