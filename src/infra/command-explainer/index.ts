// Public command explainer facade for parsing shell commands and formatting approval spans.
export { explainShellCommand } from "./extract.js";
export { formatCommandSpans } from "./format.js";
export type {
  CommandContext,
  CommandExplanation,
  CommandRisk,
  CommandShape,
  CommandStep,
  SourceSpan,
} from "./types.js";
