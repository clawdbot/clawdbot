import "./styles.css";
import "./ui/app.ts";

type ViteImportMeta = ImportMeta & {
  readonly env?: {
    readonly PROD?: boolean;
  };
};

declare const __OPENCLAW_CONTROL_UI_BUILD_ID__: string | undefined;

const isProd = (import.meta as ViteImportMeta).env?.PROD === true;

if (isProd && "serviceWorker" in navigator) {
  const swUrl = new URL("./sw.js", window.location.href);
  swUrl.searchParams.set("v", __OPENCLAW_CONTROL_UI_BUILD_ID__ || "dev");
  void navigator.serviceWorker.register(swUrl, { updateViaCache: "none" });
} else if (!isProd && "serviceWorker" in navigator) {
  // Unregister any leftover dev SW to avoid stale cache issues.
  void navigator.serviceWorker.getRegistrations().then((registrations) => {
    for (const r of registrations) {
      void r.unregister();
    }
  });
}
