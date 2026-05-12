import fs from "node:fs";
import path from "node:path";
import { loadSecretFileSync as loadSecretFileSyncFromCore } from "openclaw/plugin-sdk/core";
import { readFileWithinRoot, writeFileWithinRoot } from "openclaw/plugin-sdk/file-access-runtime";
import {
  loadSecretFileSync,
  type SecretFileReadResult,
} from "openclaw/plugin-sdk/secret-file-runtime";
import { describe, expect, it } from "vitest";
import { withTempDir } from "../test-helpers/temp-dir.js";

describe("plugin SDK fs-safe compatibility exports", () => {
  it("keeps deprecated secret-file result helpers on public SDK subpaths", async () => {
    await withTempDir({ prefix: "openclaw-sdk-secret-compat-" }, async (root) => {
      const secretPath = path.join(root, "token.txt");
      fs.writeFileSync(secretPath, "secret\n", { mode: 0o600 });

      const result: SecretFileReadResult = loadSecretFileSync(secretPath, "token");
      expect(result.ok).toBe(true);
      if (!result.ok) {
        throw new Error("expected secret-file read to succeed");
      }
      expect(result.secret).toBe("secret");
      expect(result.resolvedPath).toBe(secretPath);

      const coreResult = loadSecretFileSyncFromCore(secretPath, "token");
      expect(coreResult.ok).toBe(true);
      if (!coreResult.ok) {
        throw new Error("expected core secret-file read to succeed");
      }
      expect(coreResult.secret).toBe("secret");
    });
  });

  it("keeps deprecated root-bounded read/write helpers on file-access-runtime", async () => {
    await withTempDir({ prefix: "openclaw-sdk-file-access-compat-" }, async (root) => {
      await writeFileWithinRoot({
        rootDir: root,
        relativePath: "nested/file.txt",
        data: "hello",
        mkdir: true,
      });

      const result = await readFileWithinRoot({
        rootDir: root,
        relativePath: "nested/file.txt",
      });

      expect(result.buffer.toString("utf8")).toBe("hello");
      expect(result.realPath).toBe(fs.realpathSync(path.join(root, "nested", "file.txt")));
    });
  });
});
