import { describe, expect, it } from "vitest";
import {
  compareReleaseVersions,
  collectControlUiPackErrors,
  collectForbiddenPackedPathErrors,
  collectReleasePackageMetadataErrors,
  collectReleaseTagErrors,
  parseNpmPackJsonOutput,
  parseReleaseTagVersion,
  parseReleaseVersion,
  resolveNpmDistTagMirrorAuth,
  resolveNpmPublishPlan,
  resolveNpmCommandInvocation,
  shouldSkipPackedTarballValidation,
  utcCalendarDayDistance,
} from "../scripts/openclaw-npm-release-check.ts";

describe("parseReleaseVersion", () => {
  it("parses stable CalVer releases", () => {
    expect(parseReleaseVersion("2026.3.10")).toMatchObject({
      version: "2026.3.10",
      baseVersion: "2026.3.10",
      channel: "stable",
      year: 2026,
      month: 3,
      day: 10,
    });
  });

  it("parses beta CalVer releases", () => {
    expect(parseReleaseVersion("2026.3.10-beta.2")).toMatchObject({
      version: "2026.3.10-beta.2",
      baseVersion: "2026.3.10",
      channel: "beta",
      year: 2026,
      month: 3,
      day: 10,
      betaNumber: 2,
    });
  });

  it("parses stable correction releases", () => {
    expect(parseReleaseVersion("2026.3.10-1")).toMatchObject({
      version: "2026.3.10-1",
      baseVersion: "2026.3.10",
      channel: "stable",
      year: 2026,
      month: 3,
      day: 10,
      correctionNumber: 1,
    });
  });

  it("rejects legacy and malformed release formats", () => {
    expect(parseReleaseVersion("2026.03.09")).toBeNull();
    expect(parseReleaseVersion("v2026.3.10")).toBeNull();
    expect(parseReleaseVersion("2026.2.30")).toBeNull();
    expect(parseReleaseVersion("2026.3.10-0")).toBeNull();
    expect(parseReleaseVersion("2.0.0-beta2")).toBeNull();
  });
});

describe("parseReleaseTagVersion", () => {
  it("accepts correction release tags", () => {
    expect(parseReleaseTagVersion("2026.3.10-2")).toMatchObject({
      version: "2026.3.10-2",
      packageVersion: "2026.3.10-2",
      baseVersion: "2026.3.10",
      channel: "stable",
      correctionNumber: 2,
    });
  });

  it("rejects beta correction tags and malformed correction tags", () => {
    expect(parseReleaseTagVersion("2026.3.10-beta.1-1")).toBeNull();
    expect(parseReleaseTagVersion("2026.3.10-0")).toBeNull();
  });
});

describe("resolveNpmPublishPlan", () => {
  it("publishes beta prereleases to beta only", () => {
    expect(resolveNpmPublishPlan("2026.3.29-beta.2")).toEqual({
      channel: "beta",
      publishTag: "beta",
      mirrorDistTags: [],
    });
  });

  it("publishes stable releases to beta first", () => {
    expect(resolveNpmPublishPlan("2026.3.29")).toEqual({
      channel: "stable",
      publishTag: "beta",
      mirrorDistTags: [],
    });
  });

  it("publishes stable correction releases to beta first too", () => {
    expect(resolveNpmPublishPlan("2026.3.29-2")).toEqual({
      channel: "stable",
      publishTag: "beta",
      mirrorDistTags: [],
    });
  });

  it("can publish stable releases directly to latest when requested", () => {
    expect(resolveNpmPublishPlan("2026.3.29", undefined, "latest")).toEqual({
      channel: "stable",
      publishTag: "latest",
      mirrorDistTags: [],
    });
  });

  it("ignores current beta dist-tag state for stable publishes", () => {
    expect(resolveNpmPublishPlan("2026.3.29", "2026.4.1-beta.1")).toEqual({
      channel: "stable",
      publishTag: "beta",
      mirrorDistTags: [],
    });
  });

  it("rejects publishing beta prereleases to latest", () => {
    expect(() => resolveNpmPublishPlan("2026.3.29-beta.2", undefined, "latest")).toThrow(
      "Beta prereleases must publish to the beta dist-tag.",
    );
  });
});

describe("resolveNpmDistTagMirrorAuth", () => {
  it("prefers NODE_AUTH_TOKEN when both auth env vars exist", () => {
    expect(
      resolveNpmDistTagMirrorAuth({
        nodeAuthToken: "node-token",
        npmToken: "npm-token",
      }),
    ).toEqual({
      hasAuth: true,
      source: "node-auth-token",
    });
  });

  it("falls back to NPM_TOKEN when NODE_AUTH_TOKEN is missing", () => {
    expect(
      resolveNpmDistTagMirrorAuth({
        nodeAuthToken: "  ",
        npmToken: "npm-token",
      }),
    ).toEqual({
      hasAuth: true,
      source: "npm-token",
    });
  });

  it("reports missing auth when neither token exists", () => {
    expect(
      resolveNpmDistTagMirrorAuth({
        nodeAuthToken: "",
        npmToken: undefined,
      }),
    ).toEqual({
      hasAuth: false,
      source: "none",
    });
  });
});

describe("shouldSkipPackedTarballValidation", () => {
  it("defaults to full pack validation", () => {
    expect(shouldSkipPackedTarballValidation({})).toBe(false);
  });

  it("accepts truthy values for metadata-only validation", () => {
    expect(
      shouldSkipPackedTarballValidation({
        OPENCLAW_NPM_RELEASE_SKIP_PACK_CHECK: "1",
      }),
    ).toBe(true);
  });

  it("treats false-like values as disabled", () => {
    expect(
      shouldSkipPackedTarballValidation({
        OPENCLAW_NPM_RELEASE_SKIP_PACK_CHECK: "false",
      }),
    ).toBe(false);
  });
});

describe("compareReleaseVersions", () => {
  it("treats stable as newer than same-day beta", () => {
    expect(compareReleaseVersions("2026.3.29", "2026.3.29-beta.2")).toBe(1);
  });

  it("treats a newer beta day as newer than an older stable day", () => {
    expect(compareReleaseVersions("2026.4.1-beta.1", "2026.3.29")).toBe(1);
  });

  it("orders stable correction releases after the base stable release", () => {
    expect(compareReleaseVersions("2026.3.29-2", "2026.3.29")).toBe(1);
  });

  it("returns null when either version is not release-shaped", () => {
    expect(compareReleaseVersions("latest", "2026.3.29")).toBeNull();
  });
});

describe("utcCalendarDayDistance", () => {
  it("compares UTC calendar days rather than wall-clock hours", () => {
    const left = new Date("2026-03-09T23:59:59Z");
    const right = new Date("2026-03-11T00:00:01Z");
    expect(utcCalendarDayDistance(left, right)).toBe(2);
  });
});

describe("resolveNpmCommandInvocation", () => {
  it("uses npm_execpath when it points to npm", () => {
    expect(
      resolveNpmCommandInvocation({
        npmExecPath: "/usr/local/lib/node_modules/npm/bin/npm-cli.js",
        nodeExecPath: "/usr/local/bin/node",
        platform: "linux",
      }),
    ).toEqual({
      command: "/usr/local/bin/node",
      args: ["/usr/local/lib/node_modules/npm/bin/npm-cli.js"],
    });
  });

  it("falls back to the npm command when npm_execpath points to pnpm", () => {
    expect(
      resolveNpmCommandInvocation({
        npmExecPath: "/home/test/.cache/node/corepack/v1/pnpm/10.23.0/bin/pnpm.cjs",
        nodeExecPath: "/usr/local/bin/node",
        platform: "linux",
      }),
    ).toEqual({
      command: "npm",
      args: [],
    });
  });

  it("uses the platform npm command when npm_execpath is missing", () => {
    expect(resolveNpmCommandInvocation({ platform: "win32" })).toEqual({
      command: "npm.cmd",
      args: [],
    });
  });
});

describe("parseNpmPackJsonOutput", () => {
  it("parses a plain npm pack JSON array", () => {
    expect(parseNpmPackJsonOutput('[{"filename":"openclaw.tgz","files":[]}]')).toEqual([
      { filename: "openclaw.tgz", files: [] },
    ]);
  });

  it("parses the trailing JSON payload after npm lifecycle logs", () => {
    const stdout = [
      'npm warn Unknown project config "node-linker".',
      "",
      "> openclaw@2026.3.23 prepack",
      "> pnpm build && pnpm ui:build",
      "",
      "[copy-hook-metadata] Copied 4 hook metadata files.",
      '[{"filename":"openclaw.tgz","files":[{"path":"dist/control-ui/index.html"}]}]',
    ].join("\n");

    expect(parseNpmPackJsonOutput(stdout)).toEqual([
      {
        filename: "openclaw.tgz",
        files: [{ path: "dist/control-ui/index.html" }],
      },
    ]);
  });

  it("returns null when no JSON payload is present", () => {
    expect(parseNpmPackJsonOutput("> openclaw@2026.3.23 prepack")).toBeNull();
  });
});

describe("collectControlUiPackErrors", () => {
  it("rejects packs that ship the dashboard HTML without the asset payload", () => {
    expect(collectControlUiPackErrors(["dist/control-ui/index.html"])).toEqual([
      'npm package is missing Control UI asset payload under "dist/control-ui/assets/". Refuse release when the dashboard tarball would be empty.',
    ]);
  });

  it("accepts packs that ship dashboard HTML and bundled assets", () => {
    expect(
      collectControlUiPackErrors([
        "dist/control-ui/index.html",
        "dist/control-ui/assets/index-Bu8rSoJV.js",
        "dist/control-ui/assets/index-BK0yXA_h.css",
      ]),
    ).toEqual([]);
  });
});

describe("collectForbiddenPackedPathErrors", () => {
  it("rejects generated docs artifacts in npm pack output", () => {
    expect(
      collectForbiddenPackedPathErrors([
        "dist/index.js",
        "docs/.generated/config-baseline.json",
        "docs/.generated/config-baseline.plugin.json",
      ]),
    ).toEqual([
      'npm package must not include generated docs artifact "docs/.generated/config-baseline.json".',
      'npm package must not include generated docs artifact "docs/.generated/config-baseline.plugin.json".',
    ]);
  });

  it("rejects private qa artifacts in npm pack output", () => {
    expect(
      collectForbiddenPackedPathErrors([
        "dist/extensions/qa-channel/runtime-api.js",
        "dist/extensions/qa-channel/package.json",
        "dist/extensions/qa-lab/runtime-api.js",
        "dist/extensions/qa-lab/src/cli.js",
      ]),
    ).toEqual([
      'npm package must not include private QA channel artifact "dist/extensions/qa-channel/package.json".',
      'npm package must not include private QA lab artifact "dist/extensions/qa-lab/src/cli.js".',
    ]);
  });
});

describe("collectReleaseTagErrors", () => {
  it("accepts versions within the two-day CalVer window", () => {
    expect(
      collectReleaseTagErrors({
        packageVersion: "2026.3.10",
        releaseTag: "v2026.3.10",
        now: new Date("2026-03-11T12:00:00Z"),
      }),
    ).toEqual([]);
  });

  it("rejects versions outside the two-day CalVer window", () => {
    expect(
      collectReleaseTagErrors({
        packageVersion: "2026.3.10",
        releaseTag: "v2026.3.10",
        now: new Date("2026-03-13T00:00:00Z"),
      }),
    ).toContainEqual(expect.stringContaining("must be within 2 days"));
  });

  it("accepts fallback correction tags for stable package versions", () => {
    expect(
      collectReleaseTagErrors({
        packageVersion: "2026.3.10",
        releaseTag: "v2026.3.10-1",
        now: new Date("2026-03-10T00:00:00Z"),
      }),
    ).toEqual([]);
  });

  it("accepts correction package versions paired with matching correction tags", () => {
    expect(
      collectReleaseTagErrors({
        packageVersion: "2026.3.10-1",
        releaseTag: "v2026.3.10-1",
        now: new Date("2026-03-10T00:00:00Z"),
      }),
    ).toEqual([]);
  });

  it("rejects beta package versions paired with fallback correction tags", () => {
    expect(
      collectReleaseTagErrors({
        packageVersion: "2026.3.10-beta.1",
        releaseTag: "v2026.3.10-1",
        now: new Date("2026-03-10T00:00:00Z"),
      }),
    ).toContainEqual(expect.stringContaining("does not match package.json version"));
  });
});

describe("collectReleasePackageMetadataErrors", () => {
  it("validates the expected npm package metadata", () => {
    expect(
      collectReleasePackageMetadataErrors({
        name: "openclaw",
        description: "Multi-channel AI gateway with extensible messaging integrations",
        license: "MIT",
        repository: { url: "git+https://github.com/openclaw/openclaw.git" },
        bin: { openclaw: "openclaw.mjs" },
        peerDependencies: { "node-llama-cpp": "3.18.1" },
        peerDependenciesMeta: { "node-llama-cpp": { optional: true } },
      }),
    ).toEqual([]);
  });

  it("requires node-llama-cpp to stay an optional peer", () => {
    expect(
      collectReleasePackageMetadataErrors({
        name: "openclaw",
        description: "Multi-channel AI gateway with extensible messaging integrations",
        license: "MIT",
        repository: { url: "git+https://github.com/openclaw/openclaw.git" },
        bin: { openclaw: "openclaw.mjs" },
        peerDependencies: { "node-llama-cpp": "3.18.1" },
      }),
    ).toContain('package.json peerDependenciesMeta["node-llama-cpp"].optional must be true.');
  });
});
