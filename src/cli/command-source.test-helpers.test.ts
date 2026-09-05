// Command source test-helper tests cover fixture helpers for command source checks.
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { readCommandSource } from "./command-source.test-helpers.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("readCommandSource", () => {
  it("follows re-export shims and runtime boundaries", async () => {
    const rootDir = tempDirs.make("openclaw-command-source-");
    const cliDir = path.join(rootDir, "src", "cli");
    fs.mkdirSync(cliDir, { recursive: true });
    fs.writeFileSync(path.join(cliDir, "index.ts"), 'export * from "./command.js";\n');
    fs.writeFileSync(
      path.join(cliDir, "command.ts"),
      [
        "async function loadRuntime() {",
        '  return await import("./command.runtime.js");',
        "}",
        "export { loadRuntime };",
      ].join("\n"),
    );
    fs.writeFileSync(
      path.join(cliDir, "command.runtime.ts"),
      'export const marker = "resolveCommandSecretRefsViaGateway";\n',
    );

    const source = await readCommandSource("src/cli/index.ts", rootDir);

    expect(source).toContain('export * from "./command.js";');
    expect(source).toContain('import("./command.runtime.js")');
    expect(source).toContain("resolveCommandSecretRefsViaGateway");
  });

  it("dedupes repeated runtime imports", async () => {
    const rootDir = tempDirs.make("openclaw-command-source-");
    const cliDir = path.join(rootDir, "src", "cli");
    fs.mkdirSync(cliDir, { recursive: true });
    fs.writeFileSync(
      path.join(cliDir, "command.ts"),
      ['await import("./shared.runtime.js");', 'await import("./shared.runtime.js");'].join("\n"),
    );
    fs.writeFileSync(path.join(cliDir, "shared.runtime.ts"), "export const shared = true;\n");

    const source = await readCommandSource("src/cli/command.ts", rootDir);
    const occurrences = source.match(/export const shared = true;/gu) ?? [];

    expect(occurrences).toHaveLength(1);
  });
});
