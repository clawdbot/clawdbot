// Control UI i18n module implements lit controller behavior.
import type { ReactiveController, ReactiveControllerHost } from "lit";
import { i18n } from "./translate.ts";

export class I18nController implements ReactiveController {
  private host: ReactiveControllerHost;
  private unsubscribe?: () => void;

  constructor(host: ReactiveControllerHost) {
    this.host = host;
    this.host.addController(this);
  }

  hostConnected() {
    this.unsubscribe?.();
    this.unsubscribe = i18n.subscribe(() => {
      this.host.requestUpdate();
    });
    // The locale may have changed while the host was disconnected.
    this.host.requestUpdate();
  }

  hostDisconnected() {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }
}
