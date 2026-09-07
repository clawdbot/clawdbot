/** Playwright browser session facade. */
export type {
  BrowserConsoleMessage,
  BrowserNetworkRequest,
  BrowserPageError,
  PlaywrightConnectionRetirement,
} from "./pw-session-contracts.js";
export { isBrowserObservedDialogBlockedError } from "./pw-session-contracts.js";
export {
  beginActionDownloadCaptureOnPage,
  isDownloadStartingNavigationError,
} from "./pw-session-downloads.js";
export {
  ensureContextState,
  getPageForTargetId,
  hasCachedPlaywrightBrowserConnection,
  retirePlaywrightBrowserConnection,
  retirePlaywrightBrowserConnectionExact,
} from "./pw-session-connection.js";
export {
  armObservedDialogResponseOnPage,
  createObservedDialogAbortSignalForPage,
  ensurePageState,
  getObservedBrowserStateForPage,
  markObservedDialogsHandledRemotelyForPage,
  respondToObservedDialogOnPage,
  restoreRoleRefsForTarget,
  storeRoleRefsForTarget,
} from "./pw-session-state.js";
export {
  assertPageNavigationCompletedSafely,
  closeBlockedNavigationTarget,
  gotoPageWithNavigationGuard,
  isPolicyDenyNavigationError,
  quarantineBlockedNavigationTarget,
  wasBrowserNavigationSourcePreservedAfterPolicyDenial,
  withPageNavigationRequestGuard,
} from "./pw-session-navigation.js";
export {
  closePageByTargetIdViaPlaywright,
  closePlaywrightBrowserConnection,
  createPageViaPlaywright,
  focusPageByTargetIdViaPlaywright,
  forceDisconnectPlaywrightForTarget,
  getMainFrameDocumentIdentityViaPlaywright,
  getObservedBrowserStateViaPlaywright,
  listPagesViaPlaywright,
  refLocator,
} from "./pw-session-actions.js";
