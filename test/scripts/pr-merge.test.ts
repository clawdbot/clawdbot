import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const mergeScript = join(process.cwd(), "scripts/pr-lib/merge.sh");
const headSha = "0123456789abcdef0123456789abcdef01234567";
const describePosix = process.platform === "win32" ? describe.skip : describe;
type BodyScenario = {
  sourceMessages?: string[];
  sourceCommits?: Array<{
    message: string;
    author?: { name: string; email: string };
  }>;
  refreshMergeAuthor?: { name: string; email: string };
  refreshMergeMessage?: string;
  localFixup?: {
    message: string;
    author: { name: string; email: string };
  };
  previewBody?: string | null;
  previewHead?: string;
  previewQueue?: boolean;
  previewError?: boolean;
  sourceReadError?: boolean;
  configuredTrailer?: boolean;
  signedSource?: boolean;
  bodyWriteError?: boolean;
  trailerSeparators?: string;
  overrideBody?: string;
};

function prepareBody(scenario: BodyScenario) {
  const root = tempDirs.make("openclaw-merge-attribution-");
  const sourceRepo = join(root, "source");
  const trailerMarker = join(root, "trailer-command-called");
  const body = join(root, "body");
  const override = join(root, "operator body.md");
  if (scenario.overrideBody !== undefined) {
    writeFileSync(override, scenario.overrideBody);
  }
  let localHead = headSha;
  let publishedHead = headSha;
  if (scenario.sourceMessages || scenario.sourceCommits) {
    mkdirSync(sourceRepo);
    const git = (args: string[], env?: NodeJS.ProcessEnv) => {
      const result = spawnSync(
        "git",
        [
          "-c",
          "user.name=Maintainer",
          "-c",
          "user.email=maintainer@example.com",
          "-c",
          "commit.gpgsign=false",
          "-c",
          "core.hooksPath=/dev/null",
          ...args,
        ],
        { cwd: sourceRepo, encoding: "utf8", env: { ...process.env, ...env } },
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
    const base = git(["rev-parse", "HEAD"]);
    let main = base;
    if (scenario.refreshMergeAuthor) {
      git(["switch", "-qc", "main-refresh"]);
      git(["commit", "--allow-empty", "-qm", "Main refresh"], {
        GIT_AUTHOR_NAME: "Main Author",
        GIT_AUTHOR_EMAIL: "main@example.com",
        GIT_COMMITTER_NAME: "Main Author",
        GIT_COMMITTER_EMAIL: "main@example.com",
      });
      main = git(["rev-parse", "HEAD"]);
      git(["switch", "-qc", "pr", base]);
    }
    git(["update-ref", "refs/remotes/origin/main", main]);
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
    const sourceCommits: NonNullable<BodyScenario["sourceCommits"]> =
      scenario.sourceCommits ??
      scenario.sourceMessages?.map((message) => ({
        message,
      })) ??
      [];
    for (const { message, author } of sourceCommits) {
      git(
        [
          "-c",
          `commit.gpgsign=${scenario.signedSource ?? false}`,
          "commit",
          "--allow-empty",
          "-qm",
          message,
        ],
        author
          ? {
              GIT_AUTHOR_NAME: author.name,
              GIT_AUTHOR_EMAIL: author.email,
              GIT_COMMITTER_NAME: author.name,
              GIT_COMMITTER_EMAIL: author.email,
            }
          : undefined,
      );
    }
    if (scenario.refreshMergeAuthor) {
      const author = scenario.refreshMergeAuthor;
      git(
        [
          "merge",
          "--no-ff",
          "-qm",
          scenario.refreshMergeMessage ?? "Merge branch 'main' into repair",
          main,
        ],
        {
          GIT_AUTHOR_NAME: author.name,
          GIT_AUTHOR_EMAIL: author.email,
          GIT_COMMITTER_NAME: author.name,
          GIT_COMMITTER_EMAIL: author.email,
        },
      );
    }
    publishedHead = git(["rev-parse", "HEAD"]);
    if (scenario.localFixup) {
      const { author, message } = scenario.localFixup;
      git(["commit", "--allow-empty", "-qm", message], {
        GIT_AUTHOR_NAME: author.name,
        GIT_AUTHOR_EMAIL: author.email,
        GIT_COMMITTER_NAME: author.name,
        GIT_COMMITTER_EMAIL: author.email,
      });
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
  // Match the native worktree: Git setup may change cwd when the temp root
  // itself is inside another repository, so the body belongs in sourceRepo.
  mkdirSync(join(sourceRepo, ".local"));
  const shell = `
set -euo pipefail
source "$BODY_MERGE_SCRIPT"
PREP_HEAD_SHA="$BODY_HEAD"
LOCAL_PREP_HEAD_SHA="$BODY_LOCAL_HEAD"
git() {
  if [ "$BODY_READ_ERROR" = true ] && [[ " $* " = *" log "* ]]; then return 1; fi
  command git -C "$BODY_SOURCE_REPO" "$@"
}
PR_MAIN_SHA=$(git rev-parse --verify refs/remotes/origin/main)
gh_plain() { [ "$BODY_PREVIEW_ERROR" = false ] || return 1; printf '%s\\n' "$BODY_PREVIEW"; }
gh() { printf 'fixture/repo\\n'; }
mktemp() { [ "$BODY_WRITE_ERROR" = false ] || return 1; command mktemp "$@"; }
snapshot=""
[ -z "$BODY_OVERRIDE" ] || snapshot=$(snapshot_merge_body "$BODY_OVERRIDE")
file=$(prepare_squash_merge_body 123 "$snapshot")
[ -z "$file" ] || cp "$file" "$BODY_OUTPUT"
`;
  const result = spawnSync("bash", ["-c", shell], {
    cwd: sourceRepo,
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
      BODY_HEAD: publishedHead,
      BODY_LOCAL_HEAD: localHead,
      BODY_SOURCE_REPO: sourceRepo,
      BODY_OUTPUT: body,
      BODY_OVERRIDE: scenario.overrideBody === undefined ? "" : override,
      BODY_READ_ERROR: String(scenario.sourceReadError ?? false),
      BODY_WRITE_ERROR: String(scenario.bodyWriteError ?? false),
      BODY_PREVIEW_ERROR: String(scenario.previewError ?? false),
      BODY_PREVIEW: JSON.stringify({
        data: {
          repository: {
            pullRequest: {
              headRefOid: scenario.previewHead ?? publishedHead,
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
  it("omits preview credit backed only by a refresh merge author", () => {
    const previewCredit = "Co-authored-by: Vincent Koc <vincent@example.com>";
    const result = prepareBody({
      sourceCommits: [
        {
          message: "Repair",
          author: { name: "Contributor", email: "contributor@example.com" },
        },
      ],
      refreshMergeAuthor: { name: "Vincent Koc", email: "vincent@example.com" },
      previewBody: `Repair summary\n\n---------\n\n${previewCredit}`,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.mergeBody).toBe("Repair summary\n");
  });

  it("retains preview credit backed by a non-merge PR commit author", () => {
    const previewCredit = "Co-authored-by: Second Author <second@example.com>";
    const result = prepareBody({
      sourceCommits: [
        { message: "Repair" },
        {
          message: "Second repair",
          author: { name: "Second Author", email: "SECOND@example.com" },
        },
      ],
      previewBody: `Repair summary\n\n${previewCredit}`,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.mergeBody).toBe(`Repair summary\n\n${previewCredit}\n`);
  });

  it("does not trust an unpublished local fixup author for preview credit", () => {
    const previewCredit = "Co-authored-by: Local Fixup <local@example.com>";
    const result = prepareBody({
      sourceMessages: ["Repair"],
      localFixup: {
        message: "Local fixup",
        author: { name: "Local Fixup", email: "local@example.com" },
      },
      previewBody: `Repair summary\n\n${previewCredit}`,
      previewQueue: true,
    });
    expect(result.status).toBe(1);
    expect(result.mergeBody).toBeNull();
    expect(result.stderr).toContain("Cannot queue");
  });

  it("retains explicit source credit carried by a merge commit", () => {
    const sourceCredit = "Co-authored-by: Merge Helper <helper@example.com>";
    const result = prepareBody({
      sourceMessages: ["Repair"],
      refreshMergeAuthor: { name: "Refresh Author", email: "refresh@example.com" },
      refreshMergeMessage: `Merge branch 'main' into repair\n\n${sourceCredit}`,
      previewBody: "Repair summary",
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.mergeBody).toBe(`Repair summary\n\n${sourceCredit}\n`);
  });

  it("refuses ambiguous removal of unsupported preview credit", () => {
    const previewCredit = "Co-authored-by: Preview Only <preview@example.com>";
    const result = prepareBody({
      sourceMessages: ["Repair"],
      previewBody: `${previewCredit}\n\nQuoted example.\n\n${previewCredit}`,
    });
    expect(result.status).toBe(1);
    expect(result.mergeBody).toBeNull();
    expect(result.stderr).toContain("unambiguously");
  });

  it.each([
    "Co-authored-by: Claude <noreply@anthropic.com>",
    "co-authored-by: Claude <NOREPLY@ANTHROPIC.COM>",
    "Co-Authored-By: Claude\n <noreply@anthropic.com>",
    "Co-authored-by: Cursor <cursoragent@cursor.com>",
    "co-authored-by: Cursor <CURSORAGENT@CURSOR.COM>",
    "Co-Authored-By: Cursor\n <cursoragent@cursor.com>",
    "Co-authored-by: Amp <amp@ampcode.com>",
    "co-authored-by: Amp <AMP@AMPCODE.COM>",
    "Co-Authored-By: Amp\n <amp@ampcode.com>",
  ])("omits imported machine credit while preserving human credit: %j", (machineCredit) => {
    const humanCredit = [
      "Co-authored-by: Claude <claude@example.com>",
      "Co-authored-by: Human <person@anthropic.com>",
      "Co-authored-by: Other <noreply@anthropic.com.example.org>",
      "Co-authored-by: Cursor <cursor@example.com>",
      "Co-authored-by: Human <person@cursor.com>",
      "Co-authored-by: Other <cursoragent@cursor.com.example.org>",
      "Co-authored-by: Amp <amp@example.com>",
      "Co-authored-by: Human <person@ampcode.com>",
      "Co-authored-by: Other <amp@ampcode.com.example.org>",
    ].join("\n");
    const server = "Co-authored-by: Server <server@example.com>";
    const result = prepareBody({
      sourceMessages: [
        `Repair\n\n${machineCredit}\n${humanCredit}`,
        `Follow-up\n\n${machineCredit}`,
      ],
      previewBody: `Server description\n\n${machineCredit}\n${server}`,
      overrideBody: `Reviewed correction.\r\n\r\n${server}\r\n\r\n`,
      configuredTrailer: true,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.mergeBody).toBe(`Reviewed correction.\r\n\r\n${server}\n${humanCredit}\r\n\r\n`);
    expect(result.trailerCommandCalled).toBe(false);
  });

  it.each([
    undefined,
    "Reviewed correction.\n\nCo-authored-by: Claude <noreply@anthropic.com>\n",
    "Reviewed correction.\n\nCo-authored-by: Cursor <cursoragent@cursor.com>\n",
    "Reviewed correction.\n\nCo-authored-by: Amp <amp@ampcode.com>\n",
  ])(
    "requires a reviewed body when the chosen message contains machine credit: %j",
    (overrideBody) => {
      const machineCredit = "Co-authored-by: Claude <noreply@anthropic.com>";
      const result = prepareBody({
        sourceMessages: [`Repair\n\n${machineCredit}`],
        previewBody: `Server description\n\n${machineCredit}`,
        overrideBody,
      });
      expect(result.status).toBe(1);
      expect(result.mergeBody).toBeNull();
      expect(result.stderr).toContain("--body-file");
    },
  );

  it.each([
    "Claude <noreply@anthropic.com>",
    "Cursor <cursoragent@cursor.com>",
    "Amp <amp@ampcode.com>",
  ])("rejects machine credit present only in the default server preview: %s", (identity) => {
    const result = prepareBody({
      sourceMessages: ["Repair"],
      previewBody: `Server description\n\nCo-authored-by: ${identity}`,
    });
    expect(result.status).toBe(1);
    expect(result.mergeBody).toBeNull();
    expect(result.stderr).toContain("--body-file");
  });

  it("keeps queue admission without a body override or source trailers", () => {
    const result = prepareBody({ sourceMessages: ["Repair"], previewQueue: true });
    expect(result.status, result.stderr).toBe(0);
    expect(result.mergeBody).toBeNull();
  });

  it("rejects queue admission when preview credit requires removal", () => {
    const previewCredit = "Co-authored-by: Refresh Author <refresh@example.com>";
    const result = prepareBody({
      sourceMessages: ["Repair"],
      refreshMergeAuthor: { name: "Refresh Author", email: "refresh@example.com" },
      previewBody: `Repair summary\n\n${previewCredit}`,
      previewQueue: true,
    });
    expect(result.status).toBe(1);
    expect(result.mergeBody).toBeNull();
    expect(result.stderr).toContain("Cannot queue");
  });

  it("replaces obsolete closing prose while preserving operator, server and source credit", () => {
    const source = "Co-authored-by: Source <source@example.com>";
    const server = "Co-authored-by: Server <server@example.com>";
    const operator = "Co-authored-by: Operator <operator@example.com>";
    const result = prepareBody({
      sourceCommits: [
        {
          message: `Repair\n\n${source}`,
          author: { name: "Server", email: "server@example.com" },
        },
      ],
      previewBody: `Obsolete complete fix.\n\nFixes #42\n\n${server}`,
      overrideBody: `Partial repair. Related: #42.\r\n\r\n${operator}\r\n\r\n`,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.mergeBody).toBe(
      `Partial repair. Related: #42.\r\n\r\n${operator}\n${server}\n${source}\r\n\r\n`,
    );
    expect(result.mergeBody).not.toContain("Fixes #42");
  });

  it.each([
    "",
    "é漢字\r\n\r\n",
    "Co-authored-by: Operator <operator@example.com>\n",
    "Description\n\nReviewed-by: Reviewer <reviewer@example.com>\n\n",
  ])("retains exact explicit body bytes without extra credit: %j", (overrideBody) => {
    const result = prepareBody({
      sourceMessages: ["Repair"],
      previewBody: "Fixes #42",
      overrideBody,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.mergeBody).toBe(overrideBody);
  });

  it("preserves only server credit for an empty explicit body and deduplicates supplied credit", () => {
    const credit = "Co-authored-by: Server <server@example.com>";
    const result = prepareBody({
      sourceCommits: [
        {
          message: "Repair",
          author: { name: "Server", email: "server@example.com" },
        },
      ],
      previewBody: `Fixes: #42\n${credit}`,
      overrideBody: "",
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.mergeBody).toBe(credit);
    const duplicate = prepareBody({
      sourceMessages: [`Repair\n\n${credit}`],
      previewBody: credit,
      overrideBody: `${credit}\n\n`,
      configuredTrailer: true,
    });
    expect(duplicate.status, duplicate.stderr).toBe(0);
    expect(duplicate.mergeBody).toBe(`${credit}\n\n`);
    expect(duplicate.trailerCommandCalled).toBe(false);
  });

  it("appends credit without inventing a final newline in an explicit body", () => {
    const credit = "Co-authored-by: Source <source@example.com>";
    const result = prepareBody({
      sourceMessages: [`Repair\n\n${credit}`],
      previewBody: "Old prose",
      overrideBody: "Corrected prose",
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.mergeBody).toBe(`Corrected prose\n\n${credit}`);
  });

  it.each(["missing", "directory", "symlink", "fifo", "nul", "invalid-utf8"])(
    "rejects an invalid explicit body boundary: %s",
    (kind) => {
      const root = tempDirs.make("merge-body-input-");
      const input = join(root, "body");
      if (kind === "directory") {
        mkdirSync(input);
      }
      if (kind === "symlink") {
        symlinkSync(join(root, "target"), input);
      }
      if (kind === "fifo") {
        expect(spawnSync("mkfifo", [input]).status).toBe(0);
      }
      if (kind === "nul") {
        writeFileSync(input, Buffer.from([65, 0, 66]));
      }
      if (kind === "invalid-utf8") {
        writeFileSync(input, Buffer.from([0xff]));
      }
      const result = spawnSync(
        process.execPath,
        [join(process.cwd(), "scripts/pr-lib/merge-body.mjs"), "read", input],
        { encoding: "utf8", timeout: 5000 },
      );
      expect(result.status, result.stderr).toBe(1);
      expect(result.stdout).toBe("");
    },
  );

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
    for (const overrideBody of [undefined, "Explicit corrected prose"]) {
      const result = prepareBody({
        sourceMessages: ["Repair\n\nCo-authored-by: Contributor <contributor@example.com>"],
        overrideBody,
        ...failure,
      });
      expect(result.status).toBe(1);
      expect(result.mergeBody).toBeNull();
    }
  });
});
