import { parentPort } from "node:worker_threads";
import {
  getRemoteModelCatalogPricing,
  getRemoteModelCatalogProviderOverlay,
} from "./remote-overlay.js";

parentPort!.postMessage(
  {
    overlay: getRemoteModelCatalogProviderOverlay({}, "anthropic"),
    pricing: getRemoteModelCatalogPricing({}),
  },
  [],
);
