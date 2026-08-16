import type { DesktopPanelToggleDetail } from "../panel-toggle-contract.ts";

interface EmbeddedDesktopPanelHost {
  readonly available: boolean;
  readonly embedded: boolean;
  readonly isConnected: boolean;
  connectRequestedEnvironment(environmentId: string): Promise<void>;
  refreshEnvironments(): Promise<boolean>;
  returnToPicker(): void;
}

/** Keeps embedded-panel refreshes and toggle requests out of standalone dock state. */
export class DesktopPanelEmbeddedController {
  private refreshTimer: number | null = null;

  constructor(private readonly host: EmbeddedDesktopPanelHost) {}

  clearRefresh(): void {
    if (this.refreshTimer === null) {
      return;
    }
    window.clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
  }

  scheduleRefresh(): void {
    if (this.refreshTimer !== null) {
      return;
    }
    this.refreshTimer = window.setTimeout(() => {
      this.refreshTimer = null;
      if (this.host.isConnected && this.host.embedded && this.host.available) {
        void this.host.refreshEnvironments();
      }
    }, 0);
  }

  handleAvailabilityChange(): void {
    if (!this.host.available) {
      this.clearRefresh();
      this.host.returnToPicker();
    } else {
      this.scheduleRefresh();
    }
  }

  handleToggle(detail: DesktopPanelToggleDetail | null): boolean {
    this.clearRefresh();
    if (!this.host.embedded) {
      return false;
    }
    if (detail?.open === false) {
      this.host.returnToPicker();
      return true;
    }
    if (!this.host.available) {
      return true;
    }
    if (detail?.environmentId) {
      void this.host.connectRequestedEnvironment(detail.environmentId);
    } else {
      void this.host.refreshEnvironments();
    }
    return true;
  }
}
