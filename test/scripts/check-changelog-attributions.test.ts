import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { findForbiddenChangelogThanks } from "../../scripts/check-changelog-attributions.mjs";

describe("check-changelog-attributions", () => {
  it("flags forbidden bot, org, and maintainer thanks attributions", () => {
    const content = [
      "- Internal cleanup. Thanks @codex.",
      "- Org-owned fix. Thanks @openclaw.",
      "- Maintainer-owned fix. Thanks @steipete.",
      "- Mixed credit. Thanks @contributor and @OpenClaw.",
    ].join("\n");

    expect(findForbiddenChangelogThanks(content)).toEqual([
      { line: 1, handle: "codex", text: "- Internal cleanup. Thanks @codex." },
      { line: 2, handle: "openclaw", text: "- Org-owned fix. Thanks @openclaw." },
      { line: 3, handle: "steipete", text: "- Maintainer-owned fix. Thanks @steipete." },
      { line: 4, handle: "openclaw", text: "- Mixed credit. Thanks @contributor and @OpenClaw." },
    ]);
  });

  it("allows external contributor thanks attributions", () => {
    expect(
      findForbiddenChangelogThanks(
        "- User-facing fix. Fixes #123. Thanks @external-contributor and @other-user.",
      ),
    ).toStrictEqual([]);
  });

  it("keeps PR changelog gates on the same attribution policy", () => {
    const commonLib = readFileSync("scripts/pr-lib/common.sh", "utf8");
    const changelogLib = readFileSync("scripts/pr-lib/changelog.sh", "utf8");
    const gates = readFileSync("scripts/pr-lib/gates.sh", "utf8");
    const mergeLib = readFileSync("scripts/pr-lib/merge.sh", "utf8");
    const prepareCore = readFileSync("scripts/pr-lib/prepare-core.sh", "utf8");

    expect(commonLib).toContain("pr_contributor_allows_human_trailers");
    expect(commonLib).toContain("resolve_contributor_coauthor_email");
    expect(changelogLib).toContain("node scripts/check-changelog-attributions.mjs CHANGELOG.md");
    expect(changelogLib).toContain("changelog_thanks_required_for_contributor");
    expect(changelogLib).toContain('"app/"*');
    expect(changelogLib).toContain('"clawsweeper"');
    expect(gates).toContain("validate_changelog_attribution_policy");
    expect(prepareCore).toContain("resolve_contributor_coauthor_email");
    expect(mergeLib).toContain("pr_contributor_allows_human_trailers");
    expect(mergeLib).toContain("Skipping PR author co-author trailer check for bot/app author");
  });
});
