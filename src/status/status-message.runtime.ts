// Lazy boundary for the heavier status message formatter. Status text imports
// this wrapper so command startup does not eagerly load the full formatter graph.
export async function loadStatusMessageRuntimeModule() {
  return await import("../auto-reply/status.runtime.js");
}
