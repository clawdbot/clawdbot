import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { inspectLocalPackage } from "./source.js";

const fixture = (name: string) => resolve("packages", "claw-cli", "test", "fixtures", name);

describe("standalone local Claw package inspection", () => {
  it("returns a normalized content-free inspection", async () => {
    const result = await inspectLocalPackage(fixture("valid"));

    expect(result).toMatchObject({
      source: {
        kind: "local-package",
        packageName: "@example/incident-triage-claw",
        packageVersion: "1.0.0",
        fileCount: 5,
      },
      summary: {
        agent: { id: "incident-triage", name: "Incident triage" },
        bootstrapFiles: ["AGENTS.md", "SOUL.md"],
        hasPortablePrompt: false,
        openClawProfilePath: "profiles/openclaw.yml",
      },
    });
    expect(JSON.stringify({ source: result.source, summary: result.summary })).not.toContain(
      "Review incoming incidents",
    );
    expect(result.source.integrity).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("returns portable schema diagnostics for malformed packages", async () => {
    const error = await inspectLocalPackage(fixture("malformed")).catch((caught) => caught);
    expect(error).toMatchObject({
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: "invalid_manifest", phase: "package" }),
      ]),
    });
  });

  it("rejects remote-looking sources without resolving them", async () => {
    await expect(inspectLocalPackage("@example/remote-claw@1.0.0")).rejects.toMatchObject({
      diagnostics: [{ code: "unsupported_source", phase: "source" }],
    });
  });

  it("inspects only the declared payload and ignores workspace dependencies", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "claw-cli-payload-"));
    try {
      await cp(fixture("valid"), root, { recursive: true });
      await mkdir(resolve(root, "node_modules", "unrelated"), { recursive: true });
      await writeFile(resolve(root, "node_modules", "unrelated", "large-build-output.js"), "x");

      const [original, installedWorkspace] = await Promise.all([
        inspectLocalPackage(fixture("valid")),
        inspectLocalPackage(root),
      ]);

      expect(installedWorkspace.source).toMatchObject({
        fileCount: original.source.fileCount,
        byteLength: original.source.byteLength,
        integrity: original.source.integrity,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns a structured diagnostic for malformed JSON manifests", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "claw-cli-json-"));
    try {
      await writeFile(
        resolve(root, "package.json"),
        JSON.stringify({
          name: "@example/malformed-json-claw",
          version: "1.0.0",
          openclaw: { claw: "claw.json" },
        }),
      );
      await writeFile(resolve(root, "claw.json"), "{");

      await expect(inspectLocalPackage(root)).rejects.toMatchObject({
        diagnostics: [{ code: "invalid_claw_manifest", phase: "package", path: "claw.json" }],
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not treat noncanonical Markdown filenames as CLAW.md", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "claw-cli-markdown-name-"));
    try {
      await writeFile(
        resolve(root, "package.json"),
        JSON.stringify({
          name: "@example/noncanonical-markdown-claw",
          version: "1.0.0",
          openclaw: { claw: "manifest.md" },
        }),
      );
      await writeFile(resolve(root, "manifest.md"), "---\nschemaVersion: 1\n---\n");

      await expect(inspectLocalPackage(root)).rejects.toMatchObject({
        diagnostics: [{ code: "invalid_claw_manifest", phase: "package", path: "manifest.md" }],
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("recognizes an explicitly declared case-variant CLAW.md filename", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "claw-cli-markdown-case-"));
    try {
      await writeFile(
        resolve(root, "package.json"),
        JSON.stringify({
          name: "@example/case-variant-claw",
          version: "1.0.0",
          openclaw: { claw: "claw.md" },
        }),
      );
      await writeFile(
        resolve(root, "claw.md"),
        "---\nschemaVersion: 1\nagent:\n  id: case-variant\n---\n",
      );

      await expect(inspectLocalPackage(root)).resolves.toMatchObject({
        summary: { agent: { id: "case-variant" } },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
