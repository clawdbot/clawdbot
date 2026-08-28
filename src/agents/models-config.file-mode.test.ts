// Verifies models.json writes and repairs use private file permissions.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../../test/helpers/temp-dir.js";
import {
  ensureModelsFileModeForModelsJson,
  writeModelsFileAtomicForModelsJson,
} from "./models-config.test-support.js";

const tempDirs = new Set<string>();

afterEach(() => {
  cleanupTempDirs(tempDirs);
});

describe("models-config file mode", () => {
  it("writes models.json with mode 0600", async () => {
    if (process.platform === "win32") {
      return;
    }
    const dir = makeTempDir(tempDirs, "models-json-mode-");
    const modelsPath = path.join(dir, "models.json");
    await writeModelsFileAtomicForModelsJson(modelsPath, '{"providers":{}}\n');
    const stat = await fs.stat(modelsPath);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it("repairs models.json mode to 0600 on no-content-change paths", async () => {
    // No-op content updates should still harden existing file permissions.
    if (process.platform === "win32") {
      return;
    }
    const dir = makeTempDir(tempDirs, "models-json-mode-");
    const modelsPath = path.join(dir, "models.json");
    await writeModelsFileAtomicForModelsJson(modelsPath, '{"providers":{}}\n');
    await fs.chmod(modelsPath, 0o644);

    await ensureModelsFileModeForModelsJson(modelsPath);

    const stat = await fs.stat(modelsPath);
    expect(stat.mode & 0o777).toBe(0o600);
  });
});
