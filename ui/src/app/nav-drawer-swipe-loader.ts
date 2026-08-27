import type { NavDrawerSwipeOwner } from "./nav-drawer-swipe.runtime.ts";

type NavDrawerSwipeHost = HTMLElement & {
  readonly onboardingMode: boolean;
  readonly updateComplete: Promise<boolean>;
  readonly navDrawerOpen: boolean;
};

export class NavDrawerSwipeLoader {
  private owner?: NavDrawerSwipeOwner;
  private pending = false;

  constructor(
    private readonly host: NavDrawerSwipeHost,
    private readonly requestOpen: () => void,
  ) {}

  load(): void {
    if (this.owner || this.pending) {
      return;
    }
    this.pending = true;
    void import("./nav-drawer-swipe.runtime.ts").then(
      ({ NavDrawerSwipeOwner }) => {
        this.owner = new NavDrawerSwipeOwner(this.host, this.requestOpen);
        this.pending = false;
        if (this.host.isConnected) {
          this.owner.connect();
        }
      },
      () => (this.pending = false),
    );
  }

  connect(): void {
    this.owner?.connect();
  }

  disconnect(): void {
    this.owner?.disconnect();
  }

  opened(): boolean {
    this.owner?.opened();
    return Boolean(this.owner);
  }

  closed(): void {
    this.owner?.closed();
  }
}
