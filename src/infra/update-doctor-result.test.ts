import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolvePreferredOpenClawTmpDir } from "./tmp-openclaw-dir.js";
import {
  consumeUpdatePostInstallDoctorResult,
  createDeferredConfiguredPluginRepairDoctorResult,
  createUpdatePostInstallDoctorResultPath,
  writeUpdatePostInstallDoctorResult,
} from "./update-doctor-result.js";

const resultPaths: string[] = [];

afterEach(async () => {
  await Promise.all(resultPaths.splice(0).map((resultPath) => fs.rm(resultPath, { force: true })));
});

describe("post-install doctor result IPC", () => {
  it("round-trips typed advisory results and consumes the file", async () => {
    const resultPath = createUpdatePostInstallDoctorResultPath();
    resultPaths.push(resultPath);
    const result = createDeferredConfiguredPluginRepairDoctorResult([
      "deferred configured plugin repair",
    ]);

    await writeUpdatePostInstallDoctorResult({ resultPath, result });

    await expect(consumeUpdatePostInstallDoctorResult(resultPath)).resolves.toEqual(result);
    await expect(fs.access(resultPath)).rejects.toThrow();
  });

  it("rejects result paths outside the secure OpenClaw temp root", async () => {
    const tempRoot = resolvePreferredOpenClawTmpDir();
    const resultPath = path.join(
      `${tempRoot}-outside`,
      `openclaw-update-doctor-${process.pid}-00000000-0000-4000-8000-000000000000.json`,
    );

    await expect(
      writeUpdatePostInstallDoctorResult({
        resultPath,
        result: createDeferredConfiguredPluginRepairDoctorResult(["deferred repair"]),
      }),
    ).rejects.toThrow("Unsafe post-install doctor result path");
    await expect(fs.access(resultPath)).rejects.toThrow();
  });

  it("accepts newer child advisory copy and normalizes it to the parent copy", async () => {
    const resultPath = createUpdatePostInstallDoctorResultPath();
    resultPaths.push(resultPath);
    await fs.writeFile(
      resultPath,
      JSON.stringify({
        status: "advisory",
        advisory: {
          kind: "package-post-install-doctor",
          reason: "deferred-configured-plugin-repair",
          message: "newer child advisory wording",
          details: ["deferred repair"],
        },
      }),
      { encoding: "utf8", mode: 0o600, flag: "wx" },
    );

    await expect(consumeUpdatePostInstallDoctorResult(resultPath)).resolves.toEqual(
      createDeferredConfiguredPluginRepairDoctorResult(["deferred repair"]),
    );
  });

  it("rejects malformed advisory payloads and consumes the file", async () => {
    const resultPath = createUpdatePostInstallDoctorResultPath();
    resultPaths.push(resultPath);
    await fs.writeFile(
      resultPath,
      JSON.stringify({
        status: "advisory",
        advisory: {
          kind: "package-post-install-doctor",
          reason: "deferred-configured-plugin-repair",
          message: "forged advisory",
          details: [],
        },
      }),
      { encoding: "utf8", mode: 0o600, flag: "wx" },
    );

    await expect(consumeUpdatePostInstallDoctorResult(resultPath)).resolves.toBeNull();
    await expect(fs.access(resultPath)).rejects.toThrow();
  });
});
