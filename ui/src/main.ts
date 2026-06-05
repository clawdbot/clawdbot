// Control UI module implements main behavior.
import "./styles.css";
import "./ui/app.ts";
import { inferControlUiPublicAssetPath } from "./ui/public-assets.ts";

type ViteImportMeta = ImportMeta & {
  readonly env?: {
    readonly PROD?: boolean;
  };
};

declare const OPENCLAW_CONTROL_UI_BUILD_ID: string | undefined;

const isProd = (import.meta as ViteImportMeta).env?.PROD === true;

syncDocumentPublicAssetLinks();

if (isProd && "serviceWorker" in navigator) {
  const swUrl = new URL(inferControlUiPublicAssetPath("sw.js"), window.location.origin);
  swUrl.searchParams.set("v", OPENCLAW_CONTROL_UI_BUILD_ID || "dev");
  void navigator.serviceWorker.register(swUrl, { updateViaCache: "none" });
} else if (!isProd && "serviceWorker" in navigator) {
  // Unregister any leftover dev SW to avoid stale cache issues.
  void navigator.serviceWorker.getRegistrations().then((registrations) => {
    for (const r of registrations) {
      void r.unregister();
    }
  });
}

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
