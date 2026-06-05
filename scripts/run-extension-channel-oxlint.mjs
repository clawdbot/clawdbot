// Runs oxlint over extension channel test roots through the shared extension lint runner.
import { extensionChannelTestRoots } from "../test/vitest/vitest.channel-paths.mjs";
import { runExtensionOxlint } from "./lib/run-extension-oxlint.mjs";

runExtensionOxlint({
  roots: extensionChannelTestRoots,
  toolName: "oxlint-extension-channels",
  lockName: "oxlint-extension-channels",
  tempDirPrefix: "openclaw-extension-channel-oxlint-",
  emptyMessage: "No extension channel files found.",
  allowEmpty: true,
});
