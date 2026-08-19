import { describe, expect, it } from "vitest";
import { normalizeCloudRepo } from "./cloud-worker-project-profiles.js";

describe("normalizeCloudRepo", () => {
  it.each([
    ["SSH origin", "git@github.com:Acme/App.git", "github.com/acme/app"],
    ["HTTPS origin", "https://github.com/acme/app", "github.com/acme/app"],
    ["uppercase origin", "https://GITHUB.COM/ACME/APP", "github.com/acme/app"],
    ["trailing .git", "https://github.com/acme/app.git", "github.com/acme/app"],
    ["missing owner and repo", "https://github.com", undefined],
    ["missing repo", "https://github.com/acme", undefined],
  ])("normalizes %s", (_label, originUrl, expected) => {
    expect(normalizeCloudRepo(originUrl)).toBe(expected);
  });
});
