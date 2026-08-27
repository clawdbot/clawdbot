import type { ReactiveController } from "lit";
import { t } from "../i18n/index.ts";
import { showToast } from "../lib/toast.ts";
import type { AppSidebarSessionNavigationElement } from "./app-sidebar-session-navigation.ts";
import type { SidebarPeopleRuntime } from "./sidebar-people.runtime.ts";

const EVENTS = ["pointerover", "pointerout", "focusin", "focusout", "click", "keydown"] as const;

/** One lazy interaction owner per sidebar; the data stays in SessionDataController. */
export class SidebarPeopleController implements ReactiveController {
  private runtime: SidebarPeopleRuntime | null = null;
  private loading: Promise<typeof import("./sidebar-people.runtime.ts")> | null = null;
  private generation = 0;
  private pendingTarget: HTMLElement | null = null;

  constructor(private readonly host: AppSidebarSessionNavigationElement) {
    host.addController(this);
  }

  hostConnected(): void {
    for (const event of EVENTS) {
      this.host.addEventListener(event, this.handleEvent);
    }
  }

  hostUpdated(): void {
    this.runtime?.sync();
  }

  dismiss(): boolean {
    this.generation += 1;
    this.clearPending();
    return this.runtime?.dismiss() ?? false;
  }

  hostDisconnected(): void {
    for (const event of EVENTS) {
      this.host.removeEventListener(event, this.handleEvent);
    }
    this.generation += 1;
    this.clearPending();
    this.runtime?.dispose();
    this.runtime = null;
  }

  private clearPending(): void {
    this.pendingTarget = null;
    document.removeEventListener("pointerdown", this.cancelPending, true);
    document.removeEventListener("keydown", this.cancelPending, true);
  }

  private readonly cancelPending = (event: Event) => {
    if (
      event instanceof KeyboardEvent
        ? event.key === "Escape"
        : event.target instanceof Node && !this.pendingTarget?.contains(event.target)
    ) {
      this.generation += 1;
      this.clearPending();
    }
  };

  private readonly handleEvent = (event: Event): void => {
    if (this.runtime) {
      this.runtime.handleEvent(event);
      return;
    }
    const target =
      event.target instanceof Element
        ? event.target.closest<HTMLElement>(".sidebar-online__row")
        : null;
    if (!target || !["pointerover", "focusin", "click"].includes(event.type)) {
      return;
    }
    // Input modality belongs to the runtime; row intent only warms its lazy code.
    if (
      event.type === "click" &&
      !(event.target instanceof Element && event.target.closest(".sidebar-online__details"))
    ) {
      return;
    }
    const generation = ++this.generation;
    this.pendingTarget = target;
    document.addEventListener("pointerdown", this.cancelPending, true);
    document.addEventListener("keydown", this.cancelPending, true);
    const client = this.host.sessionDataContext?.gateway.snapshot.client;
    const gateway = this.host.sessionDataContext?.gateway;
    const hello = gateway?.snapshot.hello;
    const route = this.host.activeRouteId;
    const sessionKey = this.host.sessionKey;
    const startedAt = performance.now();
    this.loading ??= import("./sidebar-people.runtime.ts");
    void this.loading.then(
      (module) => {
        if (generation === this.generation) {
          this.clearPending();
        }
        if (
          generation !== this.generation ||
          !this.host.isConnected ||
          !target.isConnected ||
          gateway !== this.host.sessionDataContext?.gateway ||
          client !== gateway?.snapshot.client ||
          hello !== gateway?.snapshot.hello ||
          route !== this.host.activeRouteId ||
          sessionKey !== this.host.sessionKey
        ) {
          return;
        }
        this.runtime ??= new module.SidebarPeopleRuntime(this.host);
        this.runtime.handleEvent(event, startedAt);
      },
      () => {
        this.loading = null;
        if (generation === this.generation && this.host.isConnected) {
          this.clearPending();
          showToast({ message: t("presence.card.loadFailed") });
        }
      },
    );
  };
}
