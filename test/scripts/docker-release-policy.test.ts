import { describe, expect, it } from "vitest";
import { resolveDockerReleasePolicy } from "../../scripts/lib/docker-release-policy.mjs";

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

  it.each(["2026.6.33-1", "2026.6.33-alpha.1", "2026.0.33", "not-a-version"])(
    "rejects unsupported release version %s",
    (version) => {
      expect(() => resolveDockerReleasePolicy(version)).toThrow();
    },
  );
});
