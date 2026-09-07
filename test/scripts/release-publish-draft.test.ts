import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { createScriptTestHarness } from "./test-helpers.js";

const { createTempDir } = createScriptTestHarness();

it.each([
  { existing: "draft", distTag: "latest", command: "edit" },
  { existing: "draft", distTag: "beta", command: "edit" },
  { existing: "missing", distTag: "latest", command: "create" },
  { existing: "public", distTag: "latest", command: undefined },
])(
  "prepares $existing release on $distTag without promoting a draft",
  ({ existing, distTag, command }) => {
    const root = createTempDir("release-publish-draft-");
    const commands = join(root, "command");
    const notes = join(root, "notes.md");
    writeFileSync(notes, "Canonical release notes\n");
    const result = spawnSync(
      "bash",
      [
        "-c",
        `
source "$OWNER_SCRIPT"
verify_release_tag_target() { :; }
canonical_release_body_matches() { :; }
gh() {
  if [[ "$1 $2" == "release view" ]]; then
    [[ "$EXISTING" != missing ]] || return 1
    printf '{"isDraft":%s,"body":"canonical"}\\n' "$([[ "$EXISTING" == draft ]] && echo true || echo false)"
    return
  fi
  printf '%s\\n' "$@" > "$COMMAND_FILE"
  if [[ "$2" == edit && "$EXISTING" == draft && " $* " == *" --latest "* ]]; then
    echo 'HTTP 422: Latest release cannot be draft or prerelease.' >&2
    return 1
  fi
}
prepared_release_notes_file="$NOTES_FILE"
create_or_update_github_release
`,
      ],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          PATH: process.env.PATH,
          OWNER_SCRIPT: resolve("scripts/lib/release-publish-children.sh"),
          EXISTING: existing,
          COMMAND_FILE: commands,
          NOTES_FILE: notes,
          RUNNER_TEMP: root,
          GITHUB_STEP_SUMMARY: join(root, "summary"),
          GITHUB_REPOSITORY: "fixture/repository",
          GITHUB_REF: "refs/tags/release-publish/aaaaaaaaaaaa-1",
          PARENT_WORKFLOW_SHA: "a".repeat(40),
          RELEASE_TAG: "v2026.9.2",
          RELEASE_NPM_DIST_TAG: distTag,
        },
      },
    );
    expect(result.status, result.stderr).toBe(0);
    if (!command) {
      expect(existsSync(commands)).toBe(false);
      return;
    }
    const args = readFileSync(commands, "utf8").trim().split("\n");
    expect(args.slice(0, 3)).toEqual(["release", command, "v2026.9.2"]);
    expect(args).toContain(notes);
    expect(args).not.toContain("--draft=false");
    if (command === "edit") {
      expect(args.some((arg) => arg.startsWith("--latest"))).toBe(false);
    } else {
      expect(args).toContain("--draft");
      expect(args).toContain("--latest");
    }
  },
);
