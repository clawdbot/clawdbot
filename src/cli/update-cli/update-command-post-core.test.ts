// Post-core install-records handoff reader: missing vs malformed JSON.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  readPostCorePluginInstallRecordsFile,
  shouldResumePostCoreUpdateInFreshProcess,
} from "./update-command-post-core.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map(async (dir) => {
      await fs.rm(dir, { recursive: true, force: true });
    }),
  );
});

async function withTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-post-core-records-"));
  tempDirs.push(dir);
  return dir;
}

describe("readPostCorePluginInstallRecordsFile", () => {
  it("returns undefined when the path is omitted", async () => {
    await expect(readPostCorePluginInstallRecordsFile(undefined)).resolves.toBeUndefined();
  });

  it("returns undefined when the handoff file is missing", async () => {
    const dir = await withTempDir();
    const missing = path.join(dir, "missing-plugin-install-records.json");
    await expect(readPostCorePluginInstallRecordsFile(missing)).resolves.toBeUndefined();
  });

  it("loads a valid install-records handoff", async () => {
    const dir = await withTempDir();
    const filePath = path.join(dir, "plugin-install-records.json");
    await fs.writeFile(
      filePath,
      `${JSON.stringify({
        demo: {
          source: "npm",
          spec: "@openclaw/demo@1.0.0",
          installPath: "/tmp/demo-plugin",
        },
      })}\n`,
      "utf-8",
    );

    await expect(readPostCorePluginInstallRecordsFile(filePath)).resolves.toEqual({
      demo: {
        source: "npm",
        spec: "@openclaw/demo@1.0.0",
        installPath: "/tmp/demo-plugin",
      },
    });
  });

  it("fails closed on malformed handoff JSON with a path-labelled error", async () => {
    const dir = await withTempDir();
    const filePath = path.join(dir, "plugin-install-records.json");
    await fs.writeFile(filePath, "{invalid json", "utf-8");

    await expect(readPostCorePluginInstallRecordsFile(filePath)).rejects.toThrow(
      `Malformed JSON in plugin install records file: ${filePath}`,
    );
    await expect(readPostCorePluginInstallRecordsFile(filePath)).rejects.toThrow(
      "Run openclaw doctor to inspect and repair plugin installation state.",
    );
  });

  it("live FS: corrupt handoff is not silently dropped as empty records", async () => {
    // L3: real temp file + real fs.readFile/JSON.parse (no stubs).
    const dir = await withTempDir();
    const filePath = path.join(dir, "plugin-install-records.json");
    await fs.writeFile(filePath, '[{"not":"a-record-map"', "utf-8");

    let threw = false;
    try {
      await readPostCorePluginInstallRecordsFile(filePath);
    } catch (err) {
      threw = true;
      expect(String(err)).toContain(`Malformed JSON in plugin install records file: ${filePath}`);
    }
    expect(threw).toBe(true);

    console.info(
      `[post-core install-records live proof] path=${filePath} outcome=malformed-json-rejected`,
    );
  });
});

describe("shouldResumePostCoreUpdateInFreshProcess", () => {
  const unchangedGitResult = {
    status: "ok" as const,
    mode: "git" as const,
    root: "/tmp/openclaw",
    before: { sha: "abc123", version: "1.2.3" },
    after: { sha: "abc123", version: "1.2.3" },
    steps: [],
    durationMs: 1,
  };

  it("uses the fresh CLI after an install-kind switch with unchanged git metadata", () => {
    expect(
      shouldResumePostCoreUpdateInFreshProcess({
        result: unchangedGitResult,
        downgradeRisk: false,
        installKindChanged: true,
      }),
    ).toBe(true);
  });

  it("keeps a metadata-identical git update in process when the install kind is unchanged", () => {
    expect(
      shouldResumePostCoreUpdateInFreshProcess({
        result: unchangedGitResult,
        downgradeRisk: false,
        installKindChanged: false,
      }),
    ).toBe(false);
  });

  it("does not resume after a failed install-kind switch", () => {
    expect(
      shouldResumePostCoreUpdateInFreshProcess({
        result: { ...unchangedGitResult, status: "error" },
        downgradeRisk: false,
        installKindChanged: true,
      }),
    ).toBe(false);
  });
});
