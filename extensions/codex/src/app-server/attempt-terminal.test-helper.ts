import { attemptTerminal, type EmbeddedRunAttemptResult } from "./attempt-terminal.js";

export const readAttemptTerminal = (result: EmbeddedRunAttemptResult) =>
  attemptTerminal.project(result.terminal);
