import { describe, expect, it } from "vitest";
import {
  resolveCurrentDockerReleaseTags,
  resolveDockerReleasePolicy,
} from "../../scripts/lib/docker-release-policy.mjs";

describe("Docker release policy", () => {
  it("advances regular stable aliases only for final and correction patches below 33", () => {
    for (const version of ["2026.7.1", "2026.7.1-2"]) {
      expect(resolveDockerReleasePolicy(version)).toEqual({
        version,
        channel: "stable",
        movingAliases: {
          default: ["latest", "main"],
          slim: ["slim", "main-slim"],
          browser: ["latest-browser", "main-browser"],
        },
      });
    }
  });

  it("keeps extended-stable releases on dedicated moving aliases", () => {
    for (const version of ["2026.6.33", "2026.6.34", "2026.6.99"]) {
      expect(resolveDockerReleasePolicy(version)).toEqual({
        version,
        channel: "extended-stable",
        movingAliases: {
          default: ["extended-stable"],
          slim: ["extended-stable-slim"],
          browser: ["extended-stable-browser"],
        },
      });
    }
  });

  it("publishes beta versions without moving a channel alias", () => {
    expect(resolveDockerReleasePolicy("2026.7.2-beta.3")).toEqual({
      version: "2026.7.2-beta.3",
      channel: "beta",
      movingAliases: { default: [], slim: [], browser: [] },
    });
  });

  it("resolves the newest stable and extended-stable tags independently", () => {
    expect(
      resolveCurrentDockerReleaseTags([
        "v2026.6.34",
        "v2026.7.1-2",
        "v2026.6.33",
        "v2026.8.1-beta.1",
        "not-a-release-tag",
        "v2026.7.1",
      ]),
    ).toEqual({
      stable: { tag: "v2026.7.1-2", version: "2026.7.1-2" },
      extendedStable: { tag: "v2026.6.34", version: "2026.6.34" },
    });
  });

  it.each([
    [["v2026.6.34"], "No stable Docker release tag found"],
    [["v2026.7.1"], "No extended-stable Docker release tag found"],
  ])("requires both moving release channels when resolving refresh sources", (tags, error) => {
    expect(() => resolveCurrentDockerReleaseTags(tags)).toThrow(error);
  });

  it.each(["2026.6.33-1", "2026.6.33-alpha.1", "2026.0.33", "not-a-version"])(
    "rejects unsupported release version %s",
    (version) => {
      expect(() => resolveDockerReleasePolicy(version)).toThrow();
    },
  );
});
