// Post-core install-records handoff reader: missing vs malformed JSON.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createPluginInstallRecordMap,
  getPluginInstallRecordMapEntry,
  setPluginInstallRecordMapEntry,
} from "../../config/plugin-install-record-map.js";
import type { PluginInstallRecord } from "../../config/types.plugins.js";
import {
  preparePostCorePluginInstallRecordsForFreshProcess,
  readPostCorePluginInstallRecordsFile,
  shouldResumePostCoreUpdateInFreshProcess,
  writePostCorePluginInstallRecordsFile,
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

  it("loads a prototype-safe install-records handoff with legal special ids", async () => {
    const dir = await withTempDir();
    const filePath = path.join(dir, "plugin-install-records.json");
    await fs.writeFile(
      filePath,
      '{"demo":{"source":"npm","spec":"@openclaw/demo@1.0.0","installPath":"/tmp/demo-plugin","futureMetadata":{"retained":true}},"constructor":{"source":"path"},"toString":{"source":"git"},"__proto__":{"source":"archive"}}\n',
      "utf-8",
    );

    const records = await readPostCorePluginInstallRecordsFile(filePath);
    if (!records) {
      throw new Error("Expected plugin install records handoff");
    }
    expect(Object.getPrototypeOf(records)).toBeNull();
    expect(getPluginInstallRecordMapEntry(records, "demo")).toEqual({
      source: "npm",
      spec: "@openclaw/demo@1.0.0",
      installPath: "/tmp/demo-plugin",
      futureMetadata: { retained: true },
    });
    expect(getPluginInstallRecordMapEntry(records, "constructor")).toEqual({ source: "path" });
    expect(getPluginInstallRecordMapEntry(records, "toString")).toEqual({ source: "git" });
    expect(getPluginInstallRecordMapEntry(records, "__proto__")).toEqual({ source: "archive" });
  });

  it("fails closed on structurally invalid handoff records", async () => {
    const dir = await withTempDir();
    const filePath = path.join(dir, "plugin-install-records.json");
    await fs.writeFile(filePath, '{"demo":{"source":"bogus"}}\n', "utf-8");

    await expect(readPostCorePluginInstallRecordsFile(filePath)).rejects.toThrow(
      `Invalid plugin install records in handoff file: ${filePath}`,
    );
  });

  it("writes UTF-8 byte order and preserves special ids and passthrough fields", async () => {
    const dir = await withTempDir();
    const filePath = path.join(dir, "plugin-install-records.json");
    const records = createPluginInstallRecordMap<PluginInstallRecord>();
    setPluginInstallRecordMapEntry(records, "\u{10000}", { source: "git" });
    setPluginInstallRecordMapEntry(records, "__proto__", { source: "archive" });
    setPluginInstallRecordMapEntry(records, "2", {
      source: "npm",
      futureMetadata: { retained: true },
    } as PluginInstallRecord);
    setPluginInstallRecordMapEntry(records, "toString", { source: "git" });
    setPluginInstallRecordMapEntry(records, "\uE000", { source: "path" });
    setPluginInstallRecordMapEntry(records, "constructor", { source: "path" });
    setPluginInstallRecordMapEntry(records, "10", { source: "path" });
    setPluginInstallRecordMapEntry(records, "1", { source: "archive" });
    await writePostCorePluginInstallRecordsFile(filePath, records);

    expect(await fs.readFile(filePath, "utf-8")).toBe(
      '{"1":{"source":"archive"},"10":{"source":"path"},"2":{"source":"npm","futureMetadata":{"retained":true}},"__proto__":{"source":"archive"},"constructor":{"source":"path"},"toString":{"source":"git"},"\uE000":{"source":"path"},"\u{10000}":{"source":"git"}}\n',
    );
    const loaded = await readPostCorePluginInstallRecordsFile(filePath);
    if (!loaded) {
      throw new Error("Expected plugin install records handoff");
    }
    expect(Object.getPrototypeOf(loaded)).toBeNull();
    expect(getPluginInstallRecordMapEntry(loaded, "2")).toEqual({
      source: "npm",
      futureMetadata: { retained: true },
    });
    expect(getPluginInstallRecordMapEntry(loaded, "__proto__")).toEqual({ source: "archive" });
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

describe("preparePostCorePluginInstallRecordsForFreshProcess", () => {
  it("preserves passthrough fields and untouched record identity across a downgrade handoff", () => {
    const records = createPluginInstallRecordMap<PluginInstallRecord>();
    const untouched = { source: "path" as const, sourcePath: "/tmp/local" };
    const constructorRecord = { source: "git" as const };
    const toStringRecord = { source: "archive" as const };
    const protoRecord = { source: "path" as const, sourcePath: "/tmp/proto" };
    setPluginInstallRecordMapEntry(records, "newer", {
      source: "npm",
      resolvedVersion: "9999.0.0",
      resolvedSpec: "newer@9999.0.0",
      futureMetadata: { retained: true },
    } as PluginInstallRecord);
    setPluginInstallRecordMapEntry(records, "untouched", untouched);
    setPluginInstallRecordMapEntry(records, "constructor", constructorRecord);
    setPluginInstallRecordMapEntry(records, "toString", toStringRecord);
    setPluginInstallRecordMapEntry(records, "__proto__", protoRecord);

    const prepared = preparePostCorePluginInstallRecordsForFreshProcess({
      records,
      targetVersion: "1.0.0",
    });

    expect(prepared).not.toBe(records);
    expect(Object.getPrototypeOf(prepared)).toBeNull();
    expect(getPluginInstallRecordMapEntry(prepared, "untouched")).toBe(untouched);
    expect(getPluginInstallRecordMapEntry(prepared, "constructor")).toBe(constructorRecord);
    expect(getPluginInstallRecordMapEntry(prepared, "toString")).toBe(toStringRecord);
    expect(getPluginInstallRecordMapEntry(prepared, "__proto__")).toBe(protoRecord);
    expect(getPluginInstallRecordMapEntry(prepared, "newer")).toEqual({
      source: "npm",
      futureMetadata: { retained: true },
    });
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
