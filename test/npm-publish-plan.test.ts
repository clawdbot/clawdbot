import { describe, expect, it } from "vitest";
import {
  resolveNpmDistTagMirrorAuth,
  resolveNpmPublishPlan,
  shouldRequireNpmDistTagMirrorAuth,
} from "../scripts/lib/npm-publish-plan.mjs";

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
