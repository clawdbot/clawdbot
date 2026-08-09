import type { bundledCatalogGeneratedAt } from "./bundled-catalog-stamp.js";
import "./remote-overlay.js";
import type { readRemoteModelCatalog } from "./remote-store.js";

type RemoteModelCatalogOverlayTestApi = {
  resetRemoteModelCatalogOverlayForTest(): void;
  setRemoteModelCatalogOverlaySourcesForTest(sources?: {
    bundledGeneratedAt?: typeof bundledCatalogGeneratedAt;
    readStoredCatalog?: typeof readRemoteModelCatalog;
  }): void;
};

function getTestApi(): RemoteModelCatalogOverlayTestApi {
  return (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.remoteModelCatalogOverlayTestApi")
  ] as RemoteModelCatalogOverlayTestApi;
}

export function resetRemoteModelCatalogOverlayForTest(): void {
  getTestApi().resetRemoteModelCatalogOverlayForTest();
}

export function setRemoteModelCatalogOverlaySourcesForTest(
  sources?: Parameters<
    RemoteModelCatalogOverlayTestApi["setRemoteModelCatalogOverlaySourcesForTest"]
  >[0],
): void {
  getTestApi().setRemoteModelCatalogOverlaySourcesForTest(sources);
}
