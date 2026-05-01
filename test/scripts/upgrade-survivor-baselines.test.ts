import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveBaselines } from "../../scripts/resolve-upgrade-survivor-baselines.mjs";

function withReleaseFixture<T>(releases: unknown[], fn: (file: string) => T): T {
  const dir = mkdtempSync(path.join(tmpdir(), "openclaw-upgrade-baselines-"));
  try {
    const file = path.join(dir, "releases.json");
    writeFileSync(file, `${JSON.stringify(releases)}\n`);
    return fn(file);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
}

function withJsonFixture<T>(name: string, contents: unknown, fn: (file: string) => T): T {
  const dir = mkdtempSync(path.join(tmpdir(), "openclaw-upgrade-baselines-"));
  try {
    const file = path.join(dir, name);
    writeFileSync(file, `${JSON.stringify(contents)}\n`);
    return fn(file);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
}

describe("scripts/resolve-upgrade-survivor-baselines", () => {
  it("keeps the single fallback baseline when no expanded request is provided", () => {
    expect(resolveBaselines(new Map([["fallback", "2026.4.23"]]))).toEqual(["openclaw@2026.4.23"]);
  });

  it("resolves release-history to last six stable releases plus explicit legacy anchors", () => {
    const releases = (
      [
        ["v2026.4.29", "2026-04-30T00:00:00Z"],
        ["v2026.4.27", "2026-04-28T00:00:00Z"],
        ["v2026.4.26", "2026-04-27T00:00:00Z"],
        ["v2026.4.25", "2026-04-26T00:00:00Z"],
        ["v2026.4.24", "2026-04-25T00:00:00Z"],
        ["v2026.4.22", "2026-04-23T00:00:00Z"],
        ["v2026.4.23", "2026-04-22T00:00:00Z"],
        ["v2026.3.13-1", "2026-03-14T18:04:00Z"],
        ["v2026.3.12", "2026-03-12T00:00:00Z"],
        ["v2026.4.30-beta.1", "2026-05-01T00:00:00Z", true],
      ] as const
    ).map(([tagName, publishedAt, isPrerelease = false]) => ({
      isPrerelease,
      publishedAt,
      tagName,
    }));

    withReleaseFixture(releases, (file) => {
      expect(
        resolveBaselines(
          new Map([
            ["requested", "release-history 2026.4.29"],
            ["releases-json", file],
            ["history-count", "6"],
            ["include-version", "2026.4.23"],
            ["pre-date", "2026-03-15T00:00:00Z"],
          ]),
        ),
      ).toEqual([
        "openclaw@2026.4.29",
        "openclaw@2026.4.27",
        "openclaw@2026.4.26",
        "openclaw@2026.4.25",
        "openclaw@2026.4.24",
        "openclaw@2026.4.22",
        "openclaw@2026.4.23",
        "openclaw@2026.3.13-1",
      ]);
    });
  });

  it("maps release-history anchors to npm-published package versions when GitHub tags have republish suffixes", () => {
    const releases = (
      [
        ["v2026.4.29", "2026-04-30T00:00:00Z"],
        ["v2026.4.27", "2026-04-28T00:00:00Z"],
        ["v2026.4.26", "2026-04-27T00:00:00Z"],
        ["v2026.4.25", "2026-04-26T00:00:00Z"],
        ["v2026.4.24", "2026-04-25T00:00:00Z"],
        ["v2026.4.23", "2026-04-22T00:00:00Z"],
        ["v2026.3.13-1", "2026-03-14T18:04:00Z"],
      ] as const
    ).map(([tagName, publishedAt]) => ({
      isPrerelease: false,
      publishedAt,
      tagName,
    }));

    withReleaseFixture(releases, (releasesFile) => {
      withJsonFixture(
        "versions.json",
        ["2026.4.29", "2026.4.27", "2026.4.26", "2026.4.25", "2026.4.24", "2026.4.23", "2026.3.13"],
        (versionsFile) => {
          expect(
            resolveBaselines(
              new Map([
                ["requested", "release-history"],
                ["releases-json", releasesFile],
                ["npm-versions-json", versionsFile],
                ["history-count", "6"],
                ["include-version", "2026.4.23"],
                ["pre-date", "2026-03-15T00:00:00Z"],
              ]),
            ),
          ).toEqual([
            "openclaw@2026.4.29",
            "openclaw@2026.4.27",
            "openclaw@2026.4.26",
            "openclaw@2026.4.25",
            "openclaw@2026.4.24",
            "openclaw@2026.4.23",
            "openclaw@2026.3.13",
          ]);
        },
      );
    });
  });
});
