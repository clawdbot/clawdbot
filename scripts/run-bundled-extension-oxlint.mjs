// Runs oxlint over bundled plugin source files using the shared extension lint runner.
import { runExtensionOxlint } from "./lib/run-extension-oxlint.mjs";

runExtensionOxlint({
  roots: ["extensions"],
  toolName: "oxlint-bundled-extensions",
  lockName: "oxlint-bundled-extensions",
  tempDirPrefix: "openclaw-bundled-extension-oxlint-",
  emptyMessage: "No bundled extension files found.",
});
