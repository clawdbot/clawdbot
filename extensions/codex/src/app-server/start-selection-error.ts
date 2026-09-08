export class CodexAppServerStartSelectionChangedError extends Error {
  readonly code = "CODEX_APP_SERVER_START_SELECTION_CHANGED";

  constructor() {
    super("Codex app-server managed executable selection changed during startup");
    this.name = "CodexAppServerStartSelectionChangedError";
  }
}

/** Cross-bundle-safe check for a managed executable selection retry. */
export function isCodexAppServerStartSelectionChangedError(
  error: unknown,
): error is CodexAppServerStartSelectionChangedError {
  return (
    error instanceof Error &&
    "code" in error &&
    error.code === "CODEX_APP_SERVER_START_SELECTION_CHANGED"
  );
}
