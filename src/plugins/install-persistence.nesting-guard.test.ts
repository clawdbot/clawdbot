// Plugin install persistence preflight tests for the shared JSON nesting guard:
// over-deep included configs must be rejected by the pre-scan before any
// parser runs (a native parse of a pathological include cannot be contained
// by a JS try/catch). Split from install-persistence.test.ts to stay under
// the oxlint max-lines limit for test files.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MAX_CONFIG_JSON_NESTING_DEPTH } from "../config/nesting-limit.js";

describe("resolveInstallConfigMutationPreflights include nesting guard", () => {
  it("blocks over-deep included configs at the preflight instead of parsing them natively", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-install-preflight-nesting-"));
    try {
      const configPath = path.join(tempRoot, "openclaw.json");
      const includePath = path.join(tempRoot, "plugins.json5");
      const overDeep =
        "[".repeat(MAX_CONFIG_JSON_NESTING_DEPTH + 1) +
        "]".repeat(MAX_CONFIG_JSON_NESTING_DEPTH + 1);
      const includeRaw = `{"plugins":{"allow":${overDeep}}}`;
      fs.writeFileSync(
        configPath,
        JSON.stringify({ plugins: { $include: "plugins.json5" } }),
        "utf8",
      );
      fs.writeFileSync(includePath, includeRaw, "utf8");

      const { resolveInstallConfigMutationPreflights } = await import("./install-persistence.js");
      const { hashConfigIncludeRaw, resolveConfigIncludeWritePath } =
        await import("../config/includes.js");
      const resolvedTarget = resolveConfigIncludeWritePath({
        configPath,
        includePath,
        allowedRoots: [],
      });

      const preflights = resolveInstallConfigMutationPreflights({
        parsed: { plugins: { $include: "plugins.json5" } } as unknown as Record<string, unknown>,
        snapshotPath: configPath,
        writeOptions: {
          includeFileHashesForWrite: { [includePath]: hashConfigIncludeRaw(includeRaw) },
          includeFileTargetsForWrite: { [includePath]: resolvedTarget },
        },
      });

      // Controlled blocked outcome: the shared pre-scan rejects the over-deep
      // include before any parser runs, so it lands in the existing
      // "could not be inspected" blocked-preflight handling instead of a
      // native parse (which no JS try/catch can contain).
      expect(preflights.pluginMutation.mode).toBe("blocked");
      if (preflights.pluginMutation.mode === "blocked") {
        expect(preflights.pluginMutation.reason).toContain(
          "could not be inspected at its snapshot target",
        );
      }
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
