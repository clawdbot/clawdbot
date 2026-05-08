import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readSecretFromFile } from "./secret-file.js";

describe("readSecretFromFile", () => {
  it("reads and trims secrets from regular files", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-acp-secret-"));
    const file = path.join(dir, "secret.txt");
    try {
      await fs.writeFile(file, " token-value \n", "utf8");

      expect(readSecretFromFile(file, "ACP secret")).toBe("token-value");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
