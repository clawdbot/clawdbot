/**
 * Public browser action client barrel.
 *
 * Re-exports the action helpers used by Browser tool registration and tests.
 */
export {
  browserAct,
  browserArmDialog,
  browserArmFileChooser,
  browserNavigate,
  browserScreenshotAction,
} from "./client-actions-core.js";
export { browserConsoleMessages, browserPdfSave } from "./client-actions-observe.js";
