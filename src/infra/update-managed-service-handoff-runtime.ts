import fs from "node:fs";
import path from "node:path";
import { resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";
import {
  MANAGED_HANDOFF_RUNTIME_ENTRY,
  managedHandoffRuntimeEntrypoint,
} from "./update-managed-service-handoff-runtime-assets.js";

/** Prepare the complete lease owner before launch; the caller owns partial-stage cleanup. */
export function stageManagedHandoffRuntime(directory: string): string[] {
  const source = resolveRuntimeWorkerUrl(managedHandoffRuntimeEntrypoint);
  if (!source.pathname.endsWith(".mjs")) {
    throw new Error(
      "Managed handoff requires its sealed runtime; use the repository test runner or the dist-backed pnpm openclaw CLI.",
    );
  }
  const destination = path.join(directory, "runtime", MANAGED_HANDOFF_RUNTIME_ENTRY);
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  fs.writeFileSync(destination, fs.readFileSync(source), { mode: 0o600, flag: "wx" });
  // Survives update-to-triage exec, then shares the helper's sensitive-file cleanup.
  return [destination];
}
