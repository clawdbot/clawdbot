// npm publish plan tests validate package publish planning rules.
import { describe, expect, it } from "vitest";
import {
  collectReleaseVersionFloorErrors,
  resolveNpmDistTagMirrorAuth,
  resolveNpmPublishPlan,
  shouldRequireNpmDistTagMirrorAuth,
} from "../scripts/lib/npm-publish-plan.mjs";

describe("collectReleaseVersionFloorErrors", () => {
  it("blocks June 2026 stable and beta release trains below the published beta floor", () => {
    expect(collectReleaseVersionFloorErrors("2026.6.4")).toEqual([
      'June 2026 stable and beta release trains must use patch 5 or higher because 2026.6.5-beta.1 is already published; found "2026.6.4".',
    ]);
    expect(collectReleaseVersionFloorErrors("2026.6.4-beta.1")).toEqual([
      'June 2026 stable and beta release trains must use patch 5 or higher because 2026.6.5-beta.1 is already published; found "2026.6.4-beta.1".',
    ]);
  });

  it("keeps alpha compatibility and patch-floor release trains valid during the transition", () => {
    expect(collectReleaseVersionFloorErrors("2026.6.4-alpha.1")).toEqual([]);
    expect(collectReleaseVersionFloorErrors("2026.6.5-beta.2")).toEqual([]);
    expect(collectReleaseVersionFloorErrors("2026.7.1")).toEqual([]);
  });
});

describe("shouldRequireNpmDistTagMirrorAuth", () => {
  it("does not require npm auth for dry-run preview commands", () => {
    const plan = resolveNpmPublishPlan("2026.4.1");
    const auth = resolveNpmDistTagMirrorAuth({});

    expect(
      shouldRequireNpmDistTagMirrorAuth({
        mode: "--dry-run",
        mirrorDistTags: plan.mirrorDistTags,
        hasAuth: auth.hasAuth,
      }),
    ).toBe(false);
  });

  it("requires npm auth for real publishes that mirror dist-tags", () => {
    const plan = resolveNpmPublishPlan("2026.4.1");
    const auth = resolveNpmDistTagMirrorAuth({});

    expect(
      shouldRequireNpmDistTagMirrorAuth({
        mode: "--publish",
        mirrorDistTags: plan.mirrorDistTags,
        hasAuth: auth.hasAuth,
      }),
    ).toBe(true);
  });

  it("treats stable correction releases as latest publishes with beta mirroring", () => {
    const plan = resolveNpmPublishPlan("2026.4.1-1");

    expect(plan).toEqual({
      channel: "stable",
      publishTag: "latest",
      mirrorDistTags: ["beta"],
    });
  });

  it("does not require auth when there are no mirror dist-tags", () => {
    const plan = resolveNpmPublishPlan("2026.4.1-beta.1");
    const auth = resolveNpmDistTagMirrorAuth({});

    expect(
      shouldRequireNpmDistTagMirrorAuth({
        mode: "--publish",
        mirrorDistTags: plan.mirrorDistTags,
        hasAuth: auth.hasAuth,
      }),
    ).toBe(false);
  });

  it("publishes alpha prereleases without dist-tag mirroring", () => {
    const plan = resolveNpmPublishPlan("2026.4.1-alpha.1");

    expect(plan).toEqual({
      channel: "alpha",
      publishTag: "alpha",
      mirrorDistTags: [],
    });
  });

  it("does not require auth when a publish already has npm auth", () => {
    const plan = resolveNpmPublishPlan("2026.4.1");
    const auth = resolveNpmDistTagMirrorAuth({ npmToken: "token" });

    expect(
      shouldRequireNpmDistTagMirrorAuth({
        mode: "--publish",
        mirrorDistTags: plan.mirrorDistTags,
        hasAuth: auth.hasAuth,
      }),
    ).toBe(false);
  });
});
