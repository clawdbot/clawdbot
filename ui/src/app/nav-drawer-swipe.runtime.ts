import { isMobileNavLayout } from "./mobile-nav-layout.ts";

const MIN_OPEN_DISTANCE_PX = 44;
const OPEN_RATIO = 0.15;
const LOCK_DISTANCE_PX = 7;
const DIRECTION_RATIO = 1.25;
const FOCUSABLE_SELECTOR =
  "a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])";

type Swipe = {
  identifier: number;
  startX: number;
  startY: number;
  lockedHorizontal: boolean;
  drawerWidth: number;
  drawer: HTMLElement | null;
  backdrop: HTMLElement | null;
};

type NavDrawerHost = HTMLElement & {
  readonly onboardingMode: boolean;
  readonly updateComplete: Promise<boolean>;
  readonly navDrawerOpen: boolean;
};

export class NavDrawerSwipeOwner {
  private swipe: Swipe | null = null;

  constructor(
    private readonly host: NavDrawerHost,
    private readonly requestOpen: () => void,
  ) {}

  private canOpen(): boolean {
    return isMobileNavLayout() && !this.host.navDrawerOpen && !this.host.onboardingMode;
  }

  connect(): void {
    this.host.addEventListener("touchstart", this.handleStart, { passive: true });
    this.host.addEventListener("touchmove", this.handleMove, { passive: false });
    this.host.addEventListener("touchend", this.handleEnd, { passive: true });
    this.host.addEventListener("touchcancel", this.handleCancel, { passive: true });
    if (this.host.navDrawerOpen) {
      this.opened();
    }
  }

  disconnect(): void {
    this.host.removeEventListener("touchstart", this.handleStart);
    this.host.removeEventListener("touchmove", this.handleMove);
    this.host.removeEventListener("touchend", this.handleEnd);
    this.host.removeEventListener("touchcancel", this.handleCancel);
    this.closed();
  }

  reset(): void {
    this.swipe = null;
    const drawer = this.host.querySelector<HTMLElement>(".shell-nav");
    const backdrop = this.host.querySelector<HTMLElement>(".shell-nav-backdrop");
    drawer?.removeAttribute("data-nav-drawer-dragging");
    drawer?.style.removeProperty("transform");
    drawer?.style.removeProperty("opacity");
    backdrop?.removeAttribute("data-nav-drawer-dragging");
    backdrop?.style.removeProperty("visibility");
    backdrop?.style.removeProperty("opacity");
  }

  opened(): void {
    void this.host.updateComplete.then(() => {
      if (!this.host.isConnected || !this.host.navDrawerOpen) {
        return;
      }
      this.reset();
      const drawer = this.host.querySelector<HTMLElement>(".shell-nav");
      (this.focusable()[0] ?? drawer)?.focus({ preventScroll: true });
    });
  }

  closed(): void {
    this.reset();
  }

  private focusable(): HTMLElement[] {
    const drawer = this.host.querySelector<HTMLElement>(".shell-nav");
    return drawer
      ? [...drawer.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)].filter((candidate) =>
          candidate.checkVisibility(),
        )
      : [];
  }

  private paint(swipe: Swipe, deltaX: number): void {
    const drawer = swipe.drawer ?? this.host.querySelector<HTMLElement>(".shell-nav");
    const backdrop = swipe.backdrop ?? this.host.querySelector<HTMLElement>(".shell-nav-backdrop");
    if (!drawer || !backdrop) {
      return;
    }
    swipe.drawer = drawer;
    swipe.backdrop = backdrop;
    if (swipe.drawerWidth === 0) {
      swipe.drawerWidth = drawer.getBoundingClientRect().width;
      drawer.setAttribute("data-nav-drawer-dragging", "");
      backdrop.setAttribute("data-nav-drawer-dragging", "");
    }
    const reveal = Math.min(swipe.drawerWidth, Math.max(0, deltaX));
    drawer.style.transform = `translateX(${reveal - swipe.drawerWidth}px)`;
    drawer.style.opacity = "1";
    backdrop.style.visibility = "visible";
    backdrop.style.opacity = String(swipe.drawerWidth > 0 ? reveal / swipe.drawerWidth : 0);
  }

  private cancel(): void {
    this.swipe = null;
    requestAnimationFrame(() => this.reset());
  }

  private readonly handleStart = (event: TouchEvent): void => {
    this.reset();
    if (!this.canOpen() || event.touches.length !== 1) {
      return;
    }
    const path = event.composedPath();
    const content = path.find(
      (target): target is HTMLElement =>
        target instanceof HTMLElement && target.classList.contains("content"),
    );
    if (!content) {
      return;
    }
    const blocked = path.slice(0, path.indexOf(content)).some((target) => {
      if (!(target instanceof Element)) {
        return false;
      }
      if (
        target.matches(
          "a, button, input, textarea, select, pre, [role='slider'], [contenteditable]:not([contenteditable='false'])",
        )
      ) {
        return true;
      }
      return target instanceof HTMLElement && target.scrollWidth > target.clientWidth + 1;
    });
    const touch = event.touches[0];
    if (blocked || !touch) {
      return;
    }
    this.swipe = {
      identifier: touch.identifier,
      startX: touch.clientX,
      startY: touch.clientY,
      lockedHorizontal: false,
      drawerWidth: 0,
      drawer: null,
      backdrop: null,
    };
  };

  private readonly handleMove = (event: TouchEvent): void => {
    const swipe = this.swipe;
    const touch = swipe
      ? Array.from(event.touches).find((candidate) => candidate.identifier === swipe.identifier)
      : undefined;
    if (!swipe || event.touches.length !== 1 || !touch) {
      this.cancel();
      return;
    }
    const deltaX = touch.clientX - swipe.startX;
    const deltaY = touch.clientY - swipe.startY;
    if (swipe.lockedHorizontal) {
      event.preventDefault();
      this.paint(swipe, deltaX);
      return;
    }
    const distanceX = Math.abs(deltaX);
    const distanceY = Math.abs(deltaY);
    if (Math.max(distanceX, distanceY) < LOCK_DISTANCE_PX) {
      return;
    }
    if (deltaX > 0 && distanceX >= distanceY * DIRECTION_RATIO) {
      swipe.lockedHorizontal = true;
      event.preventDefault();
      this.paint(swipe, deltaX);
    } else if (deltaX <= -LOCK_DISTANCE_PX || distanceY >= distanceX * DIRECTION_RATIO) {
      this.reset();
    }
  };

  private readonly handleEnd = (event: TouchEvent): void => {
    const swipe = this.swipe;
    const touch = swipe
      ? Array.from(event.changedTouches).find(
          (candidate) => candidate.identifier === swipe.identifier,
        )
      : undefined;
    if (!swipe || !touch || !swipe.lockedHorizontal || !this.canOpen()) {
      this.reset();
      return;
    }
    const deltaX = touch.clientX - swipe.startX;
    this.paint(swipe, deltaX);
    const shouldOpen = deltaX >= Math.max(MIN_OPEN_DISTANCE_PX, swipe.drawerWidth * OPEN_RATIO);
    this.swipe = null;
    if (shouldOpen) {
      this.requestOpen();
    } else {
      requestAnimationFrame(() => this.reset());
    }
  };

  private readonly handleCancel = (): void => this.cancel();
}
