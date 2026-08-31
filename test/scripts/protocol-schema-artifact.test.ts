// Protocol schema artifact tests cover the published document contract and the
// regenerate-then-diff guards that verify the committed generator outputs.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertProtocolSchemaDocument,
  buildProtocolSchemaDocument,
  type ProtocolSchemaDocument,
} from "../../scripts/lib/protocol-schema-document.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const GIT_DIFF_GUARD = "git diff --exit-code --";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function readPackageScripts(): Record<string, string> {
  const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };
  return manifest.scripts;
}

function readGitDiffGuardPaths(script: string): string[] {
  return script
    .split("&&")
    .map((command) => command.trim())
    .filter((command) => command.startsWith(GIT_DIFF_GUARD))
    .flatMap((command) => command.slice(GIT_DIFF_GUARD.length).trim().split(/\s+/u));
}

function buildValidDocument(): ProtocolSchemaDocument {
  return buildProtocolSchemaDocument({
    methods: [{ name: "health", scope: "operator.read", since: "<=2026.7" }],
    schemas: {
      ConnectParams: { type: "object" },
      RequestFrame: { type: "object" },
      ResponseFrame: { type: "object" },
      EventFrame: { type: "object" },
    },
  });
}

describe("regenerate-then-diff protocol guards", () => {
  it("guards only git-tracked generator outputs", () => {
    const guardedScripts = Object.entries(readPackageScripts())
      .map(([name, script]) => ({ name, paths: readGitDiffGuardPaths(script) }))
      .filter(({ paths }) => paths.length > 0);

    expect(guardedScripts.length).toBeGreaterThan(0);
    for (const { name, paths } of guardedScripts) {
      // An untracked path makes `git diff --exit-code` succeed unconditionally,
      // so the guard reads as verification while it can never fail.
      const tracked = execFileSync("git", ["ls-files", "--", ...paths], {
        cwd: repoRoot,
        encoding: "utf8",
      })
        .split("\n")
        .filter(Boolean);
      expect({ script: name, tracked: [...tracked].sort() }).toEqual({
        script: name,
        tracked: [...paths].sort(),
      });
    }
  });
});

describe("published protocol schema document", () => {
  it("accepts the canonical document", () => {
    expect(() => assertProtocolSchemaDocument(buildValidDocument())).not.toThrow();
  });

  it("rejects a document that lost a required frame definition", () => {
    const document = buildValidDocument();
    delete document.definitions.ConnectParams;

    expect(() => assertProtocolSchemaDocument(document)).toThrow(
      "definition ConnectParams is missing",
    );
  });

  it("rejects reordered frame branches", () => {
    const document = buildValidDocument();
    document.oneOf = [...document.oneOf].reverse();

    expect(() => assertProtocolSchemaDocument(document)).toThrow("frame oneOf must list");
  });

  it("rejects a rewritten type discriminator", () => {
    const document = buildValidDocument();
    document.discriminator.mapping.req = "#/definitions/EventFrame";

    expect(() => assertProtocolSchemaDocument(document)).toThrow("type discriminator must map");
  });

  it("rejects an empty method catalog", () => {
    const document = buildValidDocument();
    document.methods = {};

    expect(() => assertProtocolSchemaDocument(document)).toThrow("method metadata is empty");
  });
});

describe("protocol-gen artifact", () => {
  it("writes the canonical document the contract check guards", () => {
    const outputPath = path.join(tempDirs.make("openclaw-protocol-gen-"), "protocol.schema.json");
    execFileSync(
      process.execPath,
      ["--import", "./scripts/tsx.mjs", "scripts/protocol-gen.ts", "--out", outputPath],
      { cwd: repoRoot, encoding: "utf8", stdio: "pipe" },
    );

    const written = fs.readFileSync(outputPath, "utf8");
    const document = JSON.parse(written) as ProtocolSchemaDocument;
    expect(() => assertProtocolSchemaDocument(document)).not.toThrow();
    // Rebuilding the envelope from the artifact's own parts fails the moment
    // the generator stops emitting exactly what the shared owner produces.
    expect(
      JSON.stringify(
        buildProtocolSchemaDocument({
          methods: Object.entries(document.methods).map(([name, metadata]) => ({
            name,
            ...metadata,
          })),
          schemas: document.definitions,
        }),
        null,
        2,
      ),
    ).toBe(written);
  }, 120_000);
});
