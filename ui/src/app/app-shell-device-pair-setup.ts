import { html, nothing } from "lit";
import { t } from "../i18n/index.ts";

type DevicePairSetupModule = typeof import("../pages/devices/view-pairing.runtime.ts");
type DevicePairSetupProps = Parameters<DevicePairSetupModule["renderDevicePairSetup"]>[0];

export interface DevicePairSetupHost {
  readonly devicePairSetupRenderer: DevicePairSetupModule["renderDevicePairSetup"] | null;
  readonly devicePairSetupLoadFailed: boolean;
  loadDevicePairSetupRenderer(): void;
  retryDevicePairSetupRenderer(): void;
}

// Lazy: the pairing modal stays out of the startup chunk (perf budget); it is
// fetched the first time an operator opens Pair mobile device. The eager shell
// stays visible during that import so the action never appears to do nothing.
export function renderLazyDevicePairSetup(host: DevicePairSetupHost, props: DevicePairSetupProps) {
  if (!props.open) {
    return nothing;
  }
  const renderer = host.devicePairSetupRenderer;
  if (renderer) {
    return renderer(props);
  }
  const failed = host.devicePairSetupLoadFailed;
  if (!failed) {
    host.loadDevicePairSetupRenderer();
  }
  // Loading and failure share the eager modal; a failed chunk remains dismissible and retryable.
  const title = t("devices.pairing.title");
  const message = t(failed ? "devices.pairing.loadFailed" : "common.loading");
  return html`<openclaw-modal-dialog
    label=${title}
    description=${message}
    @modal-cancel=${props.onClose}
  >
    <section class="device-pair-setup" aria-busy=${failed ? nothing : "true"}>
      <header class="device-pair-setup__header">
        <div>
          <h2>${title}</h2>
          <p role=${failed ? nothing : "status"}>${message}</p>
        </div>
      </header>
      <footer class="device-pair-setup__footer">
        ${
          failed
            ? html`<button
                class="btn btn--primary"
                type="button"
                @click=${() => host.retryDevicePairSetupRenderer()}
              >
                ${t("common.retry")}
              </button>`
            : nothing
        }
        <button class="btn btn--ghost" type="button" @click=${props.onClose}>
          ${t("common.close")}
        </button>
      </footer>
    </section>
  </openclaw-modal-dialog>`;
}
