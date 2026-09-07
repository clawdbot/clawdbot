// Stores the process-local embedded mode flag.
let embeddedModeValue = false;

/** Sets the process-local embedded-mode flag used by UI and hosted runtimes. */
export function setEmbeddedMode(value: boolean): void {
  embeddedModeValue = value;
}

/** Returns whether the current process is running inside an embedded OpenClaw host. */
export function isEmbeddedMode(): boolean {
  return embeddedModeValue;
}
