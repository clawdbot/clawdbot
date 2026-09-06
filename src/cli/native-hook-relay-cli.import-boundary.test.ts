// Native relay hooks are cold processes, so their direct path must not load server runtimes.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "../..");

function readSource(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), "utf8");
}

describe("native hook relay CLI import boundary", () => {
  it("loads only the client relay owner before Gateway fallback", () => {
    const cli = readSource("src/cli/native-hook-relay-cli.ts");

    expect(cli).toContain('from "../agents/harness/native-hook-relay-client.js"');
    expect(cli).not.toContain('from "../agents/harness/native-hook-relay.js"');
    expect(cli).not.toMatch(/import\s+\{\s*callGateway\s*\}\s+from\s+"..\/gateway\/call\.js"/u);
    expect(cli).toContain('import("../gateway/call.js")');
  });

  it("dispatches the hidden relay before loading the general CLI", () => {
    const entry = readSource("src/entry.ts");
    const relayDispatch = entry.indexOf('import("./cli/native-hook-relay-cli.js")');
    const generalCli = entry.indexOf('import("./cli/run-main.js")');

    expect(relayDispatch).toBeGreaterThan(-1);
    expect(generalCli).toBeGreaterThan(relayDispatch);
  });

  it("keeps server, event, permission, and writable state owners out of the client", () => {
    const clientGraph = [
      "src/agents/harness/native-hook-relay-client.ts",
      "src/agents/harness/native-hook-relay-client-store.ts",
      "src/agents/harness/native-hook-relay-bridge-record.ts",
      "src/agents/harness/native-hook-relay-constants.ts",
      "src/agents/harness/native-hook-relay-response-codec.ts",
      "src/state/openclaw-state-db-schema-version.ts",
    ]
      .map(readSource)
      .join("\n");

    for (const forbiddenImport of [
      "native-hook-relay-bridge.js",
      "native-hook-relay-events.js",
      "native-hook-relay-permissions.js",
      "native-hook-relay-state.js",
      "native-hook-relay-store.js",
      "openclaw-state-db.js",
      "openclaw-state-db-maintenance.js",
      "gateway/call.js",
    ]) {
      expect(clientGraph).not.toContain(forbiddenImport);
    }
  });
});
