import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createQaEvidenceBundle,
  parseQaEvidenceBundle,
  readQaEvidenceBundleFile,
  serializeQaEvidenceBundle,
} from "./evidence-bundle.js";

const temporaryRoots: string[] = [];
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

async function createRoot() {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "qa-evidence-bundle-")));
  temporaryRoots.push(dir);
  return dir;
}

function parseValue(value: unknown) {
  const bytes = Buffer.from(JSON.stringify(value));
  return parseQaEvidenceBundle(bytes, digest(bytes));
}

function bundleValue(artifacts: unknown[] = []) {
  return {
    kind: "openclaw.qa.evidence-bundle",
    version: 1,
    createdAt: "2026-09-04T00:00:00.000Z",
    artifacts,
  };
}

function captured(artifactPath: string, bytes = Buffer.from("proof")) {
  return {
    path: artifactPath,
    status: "captured",
    sha256: digest(bytes),
    data: bytes.toString("base64"),
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe("QA evidence bundles", () => {
  it("captures only named binary files and retains missing entries after originals change", async () => {
    const artifactRoot = await createRoot();
    const bytes = Buffer.from([0, 255, 10, 128]);
    await fs.writeFile(path.join(artifactRoot, "proof.bin"), bytes);
    await fs.writeFile(path.join(artifactRoot, "unrequested.txt"), "private");
    const bundle = await createQaEvidenceBundle({
      artifactRoot,
      artifacts: ["proof.bin", "missing.json"],
    });
    const serialized = serializeQaEvidenceBundle(bundle);
    await fs.writeFile(path.join(artifactRoot, "proof.bin"), "replacement");
    const replay = parseQaEvidenceBundle(serialized, digest(serialized));
    expect(replay.artifacts).toEqual([
      { path: "missing.json", status: "missing" },
      captured("proof.bin", bytes),
    ]);
    expect(serializeQaEvidenceBundle(replay)).toEqual(serialized);
    await fs.writeFile(path.join(artifactRoot, "bundle.json"), serialized);
    expect(
      await readQaEvidenceBundleFile(path.join(artifactRoot, "bundle.json"), digest(serialized)),
    ).toEqual(replay);
  });

  it.each([
    "../proof",
    "/proof",
    "a/../proof",
    "a/./proof",
    "a//proof",
    "a/",
    "a\\proof",
    "C:proof",
    "nul.txt",
    "proof.",
    "proof ",
    "a\u0000b",
  ])("rejects nonportable path %j before capture or parsing", async (artifactPath) => {
    await expect(
      createQaEvidenceBundle({ artifactRoot: "/unused", artifacts: [artifactPath] }),
    ).rejects.toThrow();
    expect(() => parseValue(bundleValue([{ path: artifactPath, status: "missing" }]))).toThrow();
  });

  it("rejects duplicate paths and excessive entry counts including missing entries", async () => {
    for (const paths of [["a", "a"], Array.from({ length: 257 }, (_, index) => `${index}.json`)]) {
      await expect(
        createQaEvidenceBundle({ artifactRoot: "/unused", artifacts: paths }),
      ).rejects.toThrow();
      expect(() =>
        parseValue(
          bundleValue(paths.map((artifactPath) => ({ path: artifactPath, status: "missing" }))),
        ),
      ).toThrow();
    }
  });

  it("rejects symlinks, ancestor aliases, directories, and nondirectory ancestors", async () => {
    const artifactRoot = await createRoot();
    await fs.mkdir(path.join(artifactRoot, "folder"));
    await fs.writeFile(path.join(artifactRoot, "folder", "proof"), "proof");
    await fs.symlink("folder/proof", path.join(artifactRoot, "alias"));
    await fs.symlink("folder", path.join(artifactRoot, "alias-dir"), "dir");
    await fs.symlink("missing", path.join(artifactRoot, "dangling"));
    for (const artifactPath of [
      "alias",
      "alias-dir/proof",
      "dangling",
      "folder",
      "folder/proof/child",
    ]) {
      await expect(
        createQaEvidenceBundle({ artifactRoot, artifacts: [artifactPath] }),
      ).rejects.toThrow();
    }
  });

  it("accepts a canonicalized root alias but rejects linked evidence files", async () => {
    const artifactRoot = await createRoot();
    await fs.mkdir(path.join(artifactRoot, "real"));
    await fs.symlink("real", path.join(artifactRoot, "root-alias"), "dir");
    await fs.writeFile(path.join(artifactRoot, "real", "proof"), "proof");
    expect(
      (
        await createQaEvidenceBundle({
          artifactRoot: path.join(artifactRoot, "root-alias"),
          artifacts: ["proof"],
        })
      ).artifacts,
    ).toEqual([captured("proof")]);
    await fs.link(path.join(artifactRoot, "real", "proof"), path.join(artifactRoot, "hardlink"));
    await expect(
      createQaEvidenceBundle({ artifactRoot, artifacts: ["hardlink"] }),
    ).rejects.toThrow();
    await expect(
      readQaEvidenceBundleFile(path.join(artifactRoot, "root-alias"), "0".repeat(64)),
    ).rejects.toThrow();
  });

  it("rejects bundle substitution before parsing and verifies embedded content independently", () => {
    const bytes = Buffer.from(JSON.stringify(bundleValue([captured("proof")])));
    expect(() => parseQaEvidenceBundle(bytes, "0".repeat(64))).toThrow("bundle digest mismatch");
    expect(() =>
      parseValue(
        bundleValue([{ ...captured("proof"), data: Buffer.from("tampered").toString("base64") }]),
      ),
    ).toThrow("artifact digest mismatch");
    expect(() => parseValue(bundleValue([{ ...captured("proof"), data: "cHJvb2Y" }]))).toThrow(
      "canonical base64",
    );
  });

  it.each([
    { ...bundleValue(), extra: true },
    { ...bundleValue(), version: 2 },
    { ...bundleValue(), createdAt: "2026-02-30T00:00:00.000Z" },
    { ...bundleValue(), createdAt: "2026-09-04" },
    bundleValue([{ path: "proof", status: "missing", data: "" }]),
    bundleValue([{ path: "proof", status: "unknown" }]),
    bundleValue([{ ...captured("proof"), sha256: "A".repeat(64) }]),
  ])("rejects malformed bundle shape %#", (value) => {
    expect(() => parseValue(value)).toThrow();
  });

  it("bounds capture and parsing by file, aggregate, and encoded bundle size", async () => {
    const artifactRoot = await createRoot();
    const maximumFile = Buffer.alloc(8 * 1024 * 1024);
    await fs.writeFile(path.join(artifactRoot, "large"), Buffer.alloc(maximumFile.length + 1));
    await expect(createQaEvidenceBundle({ artifactRoot, artifacts: ["large"] })).rejects.toThrow();
    for (const file of ["a", "b"]) {
      await fs.writeFile(path.join(artifactRoot, file), maximumFile);
    }
    await fs.writeFile(path.join(artifactRoot, "c"), "x");
    await expect(
      createQaEvidenceBundle({ artifactRoot, artifacts: ["a", "b", "c"] }),
    ).rejects.toThrow();
    expect(() =>
      parseValue(
        bundleValue([
          captured("a", maximumFile),
          captured("b", maximumFile),
          captured("c", Buffer.from("x")),
        ]),
      ),
    ).toThrow("byte limit");
    const oversized = Buffer.alloc(24 * 1024 * 1024 + 1);
    expect(() => parseQaEvidenceBundle(oversized, digest(oversized))).toThrow("bundle byte limit");
    await fs.writeFile(path.join(artifactRoot, "bundle.json"), oversized);
    await expect(
      readQaEvidenceBundleFile(path.join(artifactRoot, "bundle.json"), digest(oversized)),
    ).rejects.toThrow();
  });

  it("rejects invalid UTF-8 even when the outer digest matches", () => {
    const bytes = Buffer.concat([
      Buffer.from('{"invalid":"'),
      Buffer.from([255]),
      Buffer.from('"}'),
    ]);
    expect(() => parseQaEvidenceBundle(bytes, digest(bytes))).toThrow();
  });
});
