/** Covers the bundled codex manifest at the plugin-config validation boundary. */
import fs from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { validateJsonSchemaValue } from "./schema-validator.js";

async function readCodexConfigSchema() {
  const manifest = JSON.parse(
    await fs.readFile(
      new URL("../../extensions/codex/openclaw.plugin.json", import.meta.url),
      "utf8",
    ),
  ) as { configSchema: Record<string, unknown> };
  return manifest.configSchema;
}

describe("bundled codex manifest config schema", () => {
  it("rejects an unknown appServer.nativeHookRelay key at the manifest boundary", async () => {
    // `validation-plugin-config.ts` runs this exact call for every plugin entry, so
    // a typo surfaces as a load-time config issue naming the key instead of reaching
    // the strict runtime parser, whose safe-parse fallback would drop the sibling
    // `approvalPolicy` along with it.
    const result = validateJsonSchemaValue({
      schema: await readCodexConfigSchema(),
      cacheKey: "codex-manifest-native-hook-relay-unknown-key",
      value: {
        appServer: { approvalPolicy: "untrusted", nativeHookRelay: { enabeld: false } },
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected manifest validation failure");
    }
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        path: "appServer.nativeHookRelay",
        message: 'must not have additional properties: "enabeld"',
      }),
    );
  });

  it("accepts the documented appServer.nativeHookRelay kill-switch", async () => {
    const result = validateJsonSchemaValue({
      schema: await readCodexConfigSchema(),
      cacheKey: "codex-manifest-native-hook-relay-kill-switch",
      value: {
        appServer: { approvalPolicy: "untrusted", nativeHookRelay: { enabled: false } },
      },
    });

    expect(result.ok).toBe(true);
  });
});
