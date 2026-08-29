// Host-only entrypoint: this file and app source are never mounted into the
// package-under-test container. Keep the capture module dependency-light.
import { publishDiagnostics } from "./e2e/lib/upgrade-survivor/diagnostics.mjs";

try {
  const [mode, artifactRoot, destination] = process.argv.slice(2);
  if (mode !== "publish") {
    throw new Error();
  }
  // The wrapper registers this harness's scripts/tsx.mjs before loading source.
  const { redactSensitiveText } = await import("../src/logging/redact.ts");
  publishDiagnostics(artifactRoot, destination, redactSensitiveText);
} catch {
  process.stderr.write("Upgrade survivor diagnostics missing: safe host publication failed.\n");
  process.exitCode = 1;
}
