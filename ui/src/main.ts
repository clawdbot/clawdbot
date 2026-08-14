// Control UI module implements main behavior.
import "./styles.css";
import "./app/app-host.ts";
import { inferControlUiPublicAssetPath } from "./app/public-assets.ts";
import { installControlUiServiceWorker } from "./app/service-worker-lifecycle.ts";
import {
  installMissingStylesheetRecovery,
  installStaleChunkReloadListener,
} from "./app/stale-chunk-reload.ts";

type ViteImportMeta = ImportMeta & {
  readonly env?: {
    readonly PROD?: boolean;
  };
};

const isProd = (import.meta as ViteImportMeta).env?.PROD === true;

syncDocumentPublicAssetLinks();
installStaleChunkReloadListener();
installMissingStylesheetRecovery();
installControlUiServiceWorker(isProd);

function syncDocumentPublicAssetLinks() {
  setDocumentLinkHref('link[rel="icon"][type="image/svg+xml"]', "favicon.svg");
  setDocumentLinkHref('link[rel="icon"][type="image/png"]', "favicon-32.png");
  setDocumentLinkHref('link[rel="apple-touch-icon"]', "apple-touch-icon.png");
  setDocumentLinkHref('link[rel="manifest"]', "manifest.webmanifest");
}

function setDocumentLinkHref(
  selector: string,
  asset: Parameters<typeof inferControlUiPublicAssetPath>[0],
) {
  const link = document.querySelector<HTMLLinkElement>(selector);
  if (!link) {
    return;
  }
  link.href = inferControlUiPublicAssetPath(asset);
}
