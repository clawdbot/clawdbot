export async function loadStatusMessageRuntimeModule() {
  return await import("../auto-reply/status.runtime.js");
}
