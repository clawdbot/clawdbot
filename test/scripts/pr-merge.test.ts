import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const mergeScript = join(process.cwd(), "scripts/pr-lib/merge.sh");
const headSha = "0123456789abcdef0123456789abcdef01234567";
const describePosix = process.platform === "win32" ? describe.skip : describe;
type BodyScenario = {
  sourceMessages?: string[];
  previewBody?: string | null;
  previewHead?: string;
  previewQueue?: boolean;
  previewError?: boolean;
  sourceReadError?: boolean;
  configuredTrailer?: boolean;
  signedSource?: boolean;
  bodyWriteError?: boolean;
  trailerSeparators?: string;
};

function prepareBody(scenario: BodyScenario) {
  const root = tempDirs.make("openclaw-merge-attribution-");
  const sourceRepo = join(root, "source");
  const trailerMarker = join(root, "trailer-command-called");
  const body = join(root, "body");
  let localHead = headSha;
  if (scenario.sourceMessages) {
    mkdirSync(sourceRepo);
    const git = (args: string[]) => {
      const result = spawnSync(
        "git",
        [
          "-c",
          "user.name=Fixture",
          "-c",
          "user.email=fixture@example.com",
          "-c",
          "commit.gpgsign=false",
          "-c",
          "core.hooksPath=/dev/null",
          ...args,
        ],
        { cwd: sourceRepo, encoding: "utf8" },
      );
      if (result.status !== 0) {
        throw new Error(`Git fixture failed: ${result.stderr}`);
      }
      return result.stdout.trim();
    };
    git(["init", "-q"]);
    git([
      "commit",
      "--allow-empty",
      "-qm",
      "Main change\n\nCo-authored-by: Main Only <main@example.com>",
    ]);
    git(["update-ref", "refs/remotes/origin/main", git(["rev-parse", "HEAD"])]);
    if (scenario.signedSource) {
      const key = join(root, "fixture-signing-key");
      const generated = spawnSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", key]);
      expect(generated.status, generated.stderr.toString()).toBe(0);
      const allowedSigners = join(root, "allowed-signers");
      writeFileSync(allowedSigners, `fixture@example.com ${readFileSync(`${key}.pub`, "utf8")}`);
      git(["config", "gpg.format", "ssh"]);
      git(["config", "user.signingKey", key]);
      git(["config", "gpg.ssh.allowedSignersFile", allowedSigners]);
    }
    for (const message of scenario.sourceMessages) {
      git([
        "-c",
        `commit.gpgsign=${scenario.signedSource ?? false}`,
        "commit",
        "--allow-empty",
        "-qm",
        message,
      ]);
    }
    localHead = git(["rev-parse", "HEAD"]);
    if (scenario.signedSource) {
      git(["verify-commit", localHead]);
      git(["notes", "add", "-m", "Unrelated operator note", localHead]);
      git(["config", "log.showSignature", "true"]);
      git(["config", "color.ui", "always"]);
      git(["config", "log.decorate", "full"]);
      git(["config", "i18n.logOutputEncoding", "ISO-8859-1"]);
    }
    git([
      "commit",
      "--allow-empty",
      "-qm",
      "Unprepared change\n\nCo-authored-by: Unprepared <unprepared@example.com>",
    ]);
  }
  mkdirSync(join(root, ".local"));
  const shell = `
set -euo pipefail
source "$BODY_MERGE_SCRIPT"
PREP_HEAD_SHA="$BODY_HEAD"
LOCAL_PREP_HEAD_SHA="$BODY_LOCAL_HEAD"
git() {
  if [ "$BODY_READ_ERROR" = true ] && [[ " $* " = *" log "* ]]; then return 1; fi
  if [[ " $* " = *" interpret-trailers "* ]]; then command git "$@"; else command git -C "$BODY_SOURCE_REPO" "$@"; fi
}
gh_plain() { [ "$BODY_PREVIEW_ERROR" = false ] || return 1; printf '%s\\n' "$BODY_PREVIEW"; }
gh() { printf 'fixture/repo\\n'; }
mktemp() { [ "$BODY_WRITE_ERROR" = false ] || return 1; command mktemp "$@"; }
file=$(prepare_squash_merge_body 123)
[ -z "$file" ] || cp "$file" "$BODY_OUTPUT"
`;
  const result = spawnSync("bash", ["-c", shell], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      ...(scenario.configuredTrailer
        ? {
            GIT_CONFIG_COUNT: "2",
            GIT_CONFIG_KEY_0: "trailer.audit.key",
            GIT_CONFIG_VALUE_0: "Unrequested-Metadata",
            GIT_CONFIG_KEY_1: "trailer.audit.command",
            GIT_CONFIG_VALUE_1:
              'printf invoked > "$OPENCLAW_TEST_TRAILER_MARKER"; printf "unrequested value"',
          }
        : {}),
      ...(scenario.trailerSeparators
        ? {
            GIT_CONFIG_COUNT: "1",
            GIT_CONFIG_KEY_0: "trailer.separators",
            GIT_CONFIG_VALUE_0: scenario.trailerSeparators,
          }
        : {}),
      OPENCLAW_TEST_TRAILER_MARKER: trailerMarker,
      BODY_MERGE_SCRIPT: mergeScript,
      BODY_HEAD: headSha,
      BODY_LOCAL_HEAD: localHead,
      BODY_SOURCE_REPO: sourceRepo,
      BODY_OUTPUT: body,
      BODY_READ_ERROR: String(scenario.sourceReadError ?? false),
      BODY_WRITE_ERROR: String(scenario.bodyWriteError ?? false),
      BODY_PREVIEW_ERROR: String(scenario.previewError ?? false),
      BODY_PREVIEW: JSON.stringify({
        data: {
          repository: {
            pullRequest: {
              headRefOid: scenario.previewHead ?? headSha,
              isMergeQueueEnabled: scenario.previewQueue ?? false,
              viewerMergeBodyText:
                scenario.previewBody === undefined
                  ? "Server description\n\nCo-authored-by: Maintainer <maintainer@example.com>\n\n"
                  : scenario.previewBody,
            },
          },
        },
      }),
    },
  });
  return {
    ...result,
    mergeBody: existsSync(body) ? readFileSync(body, "utf8") : null,
    trailerCommandCalled: existsSync(trailerMarker),
  };
}

describePosix("native squash attribution", () => {
  it("preserves canonical GitHub trailers despite configured separators", () => {
    const credit = "Co-authored-by: Contributor <contributor@example.com>";
    const result = prepareBody({ sourceMessages: [`Repair\n\n${credit}`], trailerSeparators: "%" });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.mergeBody).toBe(
      `Server description\n\nCo-authored-by: Maintainer <maintainer@example.com>\n${credit}\n`,
    );
  });

  it("does not execute configured trailer commands or add unrelated metadata", () => {
    const credit = "Co-authored-by: Contributor <contributor@example.com>";
    const result = prepareBody({
      sourceMessages: [`Repair\n\n${credit}`],
      configuredTrailer: true,
    });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.trailerCommandCalled).toBe(false);
    expect(result.mergeBody).toContain(credit);
    expect(result.mergeBody).not.toContain("Unrequested-Metadata");
  });

  it("preserves source coauthors with the server authors in one parsed trailer block", () => {
    const credit = "Co-authored-by: 唐梓夷0668001293 <tang.ziyi@example.com>";
    const result = prepareBody({
      sourceMessages: [
        `Owner repair\n\n${credit}`,
        `Second repair\n\n${credit}\nCo-authored-by: Another Contributor <another@example.com>`,
      ],
    });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.mergeBody, "the merge must consume an explicit attribution body").not.toBeNull();
    expect(result.mergeBody).toContain("Server description");
    const parsed = spawnSync("git", ["interpret-trailers", "--parse", "--no-divider"], {
      encoding: "utf8",
      input: `Synthetic subject\n\n${result.mergeBody ?? ""}`,
    });
    expect(parsed.status, parsed.stderr).toBe(0);
    expect(parsed.stdout.trim().split("\n")).toEqual([
      "Co-authored-by: Maintainer <maintainer@example.com>",
      credit,
      "Co-authored-by: Another Contributor <another@example.com>",
    ]);
    expect(result.mergeBody).not.toContain("Main Only");
    expect(result.mergeBody).not.toContain("Unprepared");
  });

  it("extracts only UTF-8 credit from signed commits despite configured log presentation", () => {
    const credit = "Co-authored-by: Élodie <elodie@example.com>";
    const result = prepareBody({ sourceMessages: [`Repair\n\n${credit}`], signedSource: true });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.mergeBody).toBe(
      `Server description\n\nCo-authored-by: Maintainer <maintainer@example.com>\n${credit}\n`,
    );
  });

  it.each([
    "",
    "Server description",
    "Co-authored-by: Maintainer <maintainer@example.com>",
    "Server description\n\nCo-authored-by: Maintainer <maintainer@example.com>\n\n \t\n",
    "Server description\n\n---\n\nMore context\n\nCo-authored-by: Maintainer <maintainer@example.com>",
  ])("preserves the preview and its parsed trailers for body %j", (previewBody) => {
    const credit = "Co-authored-by: Contributor <contributor@example.com>";
    const result = prepareBody({ sourceMessages: [`Repair\n\n${credit}`], previewBody });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const preview = previewBody.trimEnd();
    const separator = !preview ? "" : preview.includes("Co-authored-by:") ? "\n" : "\n\n";
    expect(result.mergeBody).toBe(`${preview}${separator}${credit}\n`);
  });

  it("does not duplicate an existing trailer or mistake prose for a trailer", () => {
    const credit = "Co-authored-by: Contributor <contributor@example.com>";
    const previewBody = `Quoted example: ${credit}\n\nNot a trailer.`;
    const present = prepareBody({ sourceMessages: [`Repair\n\n${credit}`], previewBody: credit });
    expect(present.status, present.stderr).toBe(0);
    expect(present.mergeBody).toBe(`${credit}\n`);
    const prose = prepareBody({ sourceMessages: [`Repair\n\n${credit}`], previewBody });
    expect(prose.status, prose.stderr).toBe(0);
    expect(prose.mergeBody).toBe(`${previewBody}\n\n${credit}\n`);
  });

  it.each<BodyScenario>([
    { previewError: true },
    { previewBody: null },
    { previewHead: "b".repeat(40) },
    { previewQueue: true },
    { sourceReadError: true },
    { bodyWriteError: true },
  ])("refuses before merge when attribution evidence is unavailable: %j", (failure) => {
    const result = prepareBody({
      sourceMessages: ["Repair\n\nCo-authored-by: Contributor <contributor@example.com>"],
      ...failure,
    });
    expect(result.status).toBe(1);
    expect(result.mergeBody).toBeNull();
  });
});
