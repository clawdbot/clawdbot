/**
 * Tests fs-safe compatibility exports used by plugin SDK callers.
 */
import fs from "node:fs";
import path from "node:path";
import { loadSecretFileSync as loadSecretFileSyncFromCore } from "openclaw/plugin-sdk/core";
import {
  fileExists,
  readFileWithinRoot,
  removePathWithinRoot,
  writeFileWithinRoot,
} from "openclaw/plugin-sdk/file-access-runtime";
import {
  loadSecretFileSync,
  type SecretFileReadResult,
} from "openclaw/plugin-sdk/secret-file-runtime";
import { fileExists as fileExistsFromSecurity } from "openclaw/plugin-sdk/security-runtime";
import { describe, expect, it } from "vitest";
import { withTestDir } from "../test-helpers/temp-dir.js";

describe("plugin SDK fs-safe compatibility exports", () => {
  it.each([
    { subpath: "file-access-runtime", exists: fileExists },
    { subpath: "security-runtime", exists: fileExistsFromSecurity },
  ])("keeps $subpath file checks limited to regular files", async ({ exists }) => {
    await withTestDir({ prefix: "openclaw-sdk-file-exists-" }, async (root) => {
      const filePath = path.join(root, "file.txt");
      const symlinkPath = path.join(root, "linked.txt");
      fs.writeFileSync(filePath, "content");
      fs.symlinkSync(filePath, symlinkPath);

      for (const [candidate, expected] of [
        [filePath, true],
        [path.join(root, "missing.txt"), false],
        [root, false],
        [symlinkPath, false],
      ] as const) {
        expect(exists(candidate), candidate).toBe(expected);
      }
    });
  });

  it("keeps deprecated secret-file result helpers on public SDK subpaths", async () => {
    await withTestDir({ prefix: "openclaw-sdk-secret-compat-" }, async (root) => {
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

  it("keeps root-bounded file-access helpers on file-access-runtime", async () => {
    await withTestDir({ prefix: "openclaw-sdk-file-access-compat-" }, async (root) => {
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

      await removePathWithinRoot({
        rootDir: root,
        relativePath: "nested/file.txt",
        force: false,
      });

      expect(fs.existsSync(path.join(root, "nested", "file.txt"))).toBe(false);
    });
  });
});
