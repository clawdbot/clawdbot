// Narrow CLI/runtime facade re-exported for memory host helpers.

export {
  colorize,
  defaultRuntime,
  formatDocsLink,
  formatErrorMessage,
  formatHelpExamples,
  isRich,
  isVerbose,
  resolveCommandSecretRefsViaGateway,
  setVerbose,
  shortenHomeInString,
  shortenHomePath,
  theme,
  withManager,
  withProgress,
  withProgressTotals,
} from "./openclaw-runtime.js";
