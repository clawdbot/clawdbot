import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const GATEWAY_CLIENT_CONSTRUCTOR_PATTERN = /new\s+GatewayClient\s*\(/;

const ALLOWED_GATEWAY_CLIENT_CALLSITES = new Set([
  "extensions/google-meet/src/voice-call-gateway.ts",
  "src/acp/server.ts",
  "src/gateway/call.ts",
  "src/gateway/gateway-cli-backend.live-helpers.ts",
  "src/gateway/operator-approvals-client.ts",
  "src/gateway/probe.ts",
  "src/node-host/runner.ts",
  "src/tui/gateway-chat.ts",
]);

async function collectSourceFiles(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectSourceFiles(fullPath)));
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    if (!entry.name.endsWith(".ts")) {
      continue;
    }
    if (
      entry.name.endsWith(".test.ts") ||
      entry.name.endsWith(".e2e.ts") ||
      entry.name.endsWith(".e2e.test.ts") ||
      entry.name.endsWith(".live.test.ts")
    ) {
      continue;
    }
    files.push(fullPath);
  }
  return files;
}

describe("GatewayClient production callsites", () => {
  it("remain constrained to allowlisted files", async () => {
    const root = process.cwd();
    const sourceFiles = [
      ...(await collectSourceFiles(path.join(root, "src"))),
      ...(await collectSourceFiles(path.join(root, "extensions"))),
    ];
    const callsites: string[] = [];
    for (const fullPath of sourceFiles) {
      const relativePath = path.relative(root, fullPath).replaceAll(path.sep, "/");
      const content = await fs.readFile(fullPath, "utf8");
      if (GATEWAY_CLIENT_CONSTRUCTOR_PATTERN.test(content)) {
        callsites.push(relativePath);
      }
    }
    const expected = [...ALLOWED_GATEWAY_CLIENT_CALLSITES].toSorted();
    expect(callsites.toSorted()).toEqual(expected);
  });
});
