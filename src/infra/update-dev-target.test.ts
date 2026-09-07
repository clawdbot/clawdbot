import { describe, expect, it } from "vitest";
import {
  applyDevUpdateTargetEnv,
  devUpdateTargetFromGitTarget,
  parseDevUpdateTargetEnv,
  resolveDevUpdateTargetRevision,
} from "./update-dev-target.js";

const TRACKED_VALUE =
  "openclaw-dev-target:v1:eyJ1cHN0cmVhbVJlZiI6Im9yaWdpbi9tYWluIiwidXBzdHJlYW1TaGEiOiJmcm96ZW4tc2hhIn0";

describe("dev update target environment", () => {
  it("preserves the legacy plain detached-ref contract", () => {
    expect(parseDevUpdateTargetEnv({ OPENCLAW_UPDATE_DEV_TARGET_REF: " refs/tags/dev " })).toEqual({
      status: "valid",
      target: { mode: "detached", ref: "refs/tags/dev" },
    });
  });

  it("distinguishes an absent target from an invalid one", () => {
    expect(parseDevUpdateTargetEnv({})).toEqual({ status: "absent" });
    expect(
      parseDevUpdateTargetEnv({ OPENCLAW_UPDATE_DEV_TARGET_REF: "refs/heads/my branch" }),
    ).toEqual({ status: "invalid" });
  });

  it("serializes tracked targets deterministically through the existing env field", () => {
    const env = applyDevUpdateTargetEnv(
      { KEEP: "value" },
      { mode: "tracked", upstreamRef: "origin/main", upstreamSha: "frozen-sha" },
    );

    expect(env).toEqual({ KEEP: "value", OPENCLAW_UPDATE_DEV_TARGET_REF: TRACKED_VALUE });
    expect(parseDevUpdateTargetEnv(env)).toEqual({
      status: "valid",
      target: { mode: "tracked", upstreamRef: "origin/main", upstreamSha: "frozen-sha" },
    });
  });

  it("projects campaign targets and resolves both target modes", () => {
    const tracked = devUpdateTargetFromGitTarget({
      upstreamRef: "origin/main",
      upstreamSha: "frozen-sha",
    });

    expect(tracked).toEqual({
      mode: "tracked",
      upstreamRef: "origin/main",
      upstreamSha: "frozen-sha",
    });
    expect(resolveDevUpdateTargetRevision(tracked)).toBe("frozen-sha");
    expect(resolveDevUpdateTargetRevision({ mode: "detached", ref: "refs/tags/dev" })).toBe(
      "refs/tags/dev",
    );
  });

  it.each([
    "other-dev-target:v1:payload",
    "openclaw-dev-target:v2:payload",
    "openclaw-dev-target:v1:",
    "openclaw-dev-target:v1:not+base64url",
    `openclaw-dev-target:v1:${"a".repeat(4097)}`,
    `openclaw-dev-target:v1:${Buffer.from("not-json").toString("base64url")}`,
    `openclaw-dev-target:v1:${Buffer.from(JSON.stringify(["ref", "origin/main"])).toString("base64url")}`,
    `openclaw-dev-target:v1:${Buffer.from(JSON.stringify({ mode: "tracked", upstreamRef: "origin/main", upstreamSha: "ref" })).toString("base64url")}`,
    `openclaw-dev-target:v1:${Buffer.from(JSON.stringify({ upstreamRef: " upstream ", upstreamSha: "ref" })).toString("base64url")}`,
    `openclaw-dev-target:v1:${Buffer.from(JSON.stringify({ upstreamRef: "origin/main", upstreamSha: "ref\0" })).toString("base64url")}`,
  ])("fails closed for malformed or unsupported tracked value %s", (value) => {
    expect(parseDevUpdateTargetEnv({ OPENCLAW_UPDATE_DEV_TARGET_REF: value })).toEqual({
      status: "invalid",
    });
  });
});
