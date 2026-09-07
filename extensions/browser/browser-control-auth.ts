/**
 * Browser control-auth API barrel. It exposes auth generation and validation
 * helpers for the browser control server.
 */
export type { BrowserControlAuth } from "./src/browser/control-auth.js";
export {
  ensureBrowserControlAuth,
  resolveBrowserControlAuth,
  shouldAutoGenerateBrowserAuth,
} from "./src/browser/control-auth.js";
