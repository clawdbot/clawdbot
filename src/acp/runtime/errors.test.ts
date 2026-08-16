import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { withEnv } from "../../test-utils/env.js";
import { AcpRuntimeError, formatAcpErrorChain } from "./errors.js";

let tempDirs: string[] = [];

function writeConfig(source: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-acp-redact-config-"));
  tempDirs.push(dir);
  const configPath = path.join(dir, "openclaw.json");
  fs.writeFileSync(configPath, source);
  return configPath;
}

afterEach(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { force: true, recursive: true });
  }
  tempDirs = [];
});

describe("ACP runtime error redaction", () => {
  it("keeps provider-token coverage when operator redact patterns are configured", () => {
    const configPath = writeConfig(`{
      logging: {
        redactPatterns: ["/internal-ticket-([A-Za-z0-9]+)/g"],
      },
    }`);
    const providerToken = `ghp_${"a".repeat(20)}`;
    const customSecret = "internal-ticket-12345";

    const output = withEnv({ OPENCLAW_CONFIG_PATH: configPath }, () =>
      formatAcpErrorChain(
        new AcpRuntimeError("ACP_TURN_FAILED", `backend failed: ${providerToken} ${customSecret}`),
      ),
    );

    expect(output).not.toContain(providerToken);
    expect(output).not.toContain(customSecret);
    expect(output).toContain("backend failed");
  });
});
