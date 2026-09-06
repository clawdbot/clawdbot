import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { expect, it } from "vitest";
import { resolvePackagedCodexNativeCommand } from "./managed-binary.js";
import { CODEX_APP_SERVER_VERSION } from "./version.js";

async function readBundledModelShellTypes(binary: string): Promise<unknown[]> {
  const marker = Buffer.from('{\n  "models": [');
  let buffer = Buffer.alloc(0);
  let found = false;
  // Codex models-manager/src/lib.rs embeds models.json verbatim with include_str!.
  // Its top-level closing brace is unindented; prompt newlines are JSON escapes.
  for await (const chunk of createReadStream(binary)) {
    buffer = Buffer.concat([buffer, chunk]);
    if (!found) {
      const start = buffer.indexOf(marker);
      if (start < 0) {
        buffer = buffer.subarray(Math.max(0, buffer.length - marker.length + 1));
        continue;
      }
      buffer = buffer.subarray(start);
      found = true;
    }
    const end = buffer.indexOf("\n}");
    if (end >= 0) {
      let catalog: {
        models?: Array<{ shell_type?: unknown }>;
      };
      try {
        catalog = JSON.parse(buffer.subarray(0, end + 2).toString("utf8"));
      } catch {
        throw new Error(
          "Pinned Codex model catalog is invalid; recheck packaging and native cron authority.",
        );
      }
      if (!Array.isArray(catalog.models) || catalog.models.length === 0) {
        throw new Error("Pinned Codex model catalog is empty; recheck native cron authority.");
      }
      return catalog.models.map((model) => model.shell_type);
    }
    if (buffer.length > 2 * 1024 * 1024) {
      break;
    }
  }
  throw new Error(
    "Pinned Codex model catalog could not be read; recheck its packaging and native cron authority.",
  );
}

it("only infers native cron shell authority for a pinned registry with shell-enabled models", async () => {
  const require = createRequire(new URL("../../package.json", import.meta.url));
  const manifest = JSON.parse(
    await readFile(require.resolve("@openai/codex/package.json"), "utf8"),
  ) as { version: string };
  expect(manifest.version).toBe(CODEX_APP_SERVER_VERSION);
  const binary = resolvePackagedCodexNativeCommand(require.resolve("@openai/codex/bin/codex.js"));
  if (!binary) {
    throw new Error("Pinned Codex native artifact is missing; install the plugin dependencies.");
  }
  const shellTypes = await readBundledModelShellTypes(binary);
  expect(
    shellTypes.every((shellType) => shellType === "unified_exec" || shellType === "shell_command"),
    "Codex registry changed shell availability; recheck native cron authority before upgrading.",
  ).toBe(true);
});
