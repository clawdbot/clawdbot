/**
 * Runtime proof for PR #89040's literal-backslash extra-bootstrap match fix.
 *
 * SCOPE (read this before trusting a green run):
 *   This harness proves ONE thing at runtime, over real on-disk files and the
 *   real production code path: an extra-bootstrap glob match whose directory name
 *   contains a literal backslash byte (a legal POSIX filename character) is
 *   resolved and LOADED intact, instead of being folded to a different, missing
 *   path and silently dropped.
 *
 *   The fix lives in src/agents/workspace-extra-bootstrap-walker.ts: matches now
 *   pass through toPortableMatchPath(match, separator = path.sep), which folds
 *   ONLY the platform separator. On POSIX path.sep is "/", so a backslash in a
 *   matched filename survives. The pre-fix normalization folded EVERY backslash
 *   to "/", so `back\slash-dir/AGENTS.md` became `back/slash-dir/AGENTS.md` — a
 *   path that does not exist — and the configured bootstrap file was dropped with
 *   no operator-visible trace. Unit/regression tests already cover the seam; this
 *   is the missing runtime demonstration.
 *
 * What is driven (no mocks):
 *   - resolveExtraBootstrapPatternPaths(workspace, "**\/AGENTS.md")
 *       the real fs.glob-backed resolver + workspace realpath containment filter.
 *   - loadExtraBootstrapFilesWithDiagnostics(workspace, ["**\/AGENTS.md"])
 *       the real guarded loader the bundled hook calls (files + diagnostics).
 *   - bootstrapExtraFilesHook over a real AgentBootstrapHookContext
 *       the exact production consumption path that appends to context.bootstrapFiles.
 *
 * Honest limits:
 *   - Literal-backslash filenames are not representable on Windows (the separator
 *     IS a backslash there), so on win32 this harness SKIPS. The fix's Windows
 *     branch — folding the "\\" separator losslessly, because Windows names cannot
 *     hold a backslash — is covered by the injectable-separator unit tests, not here.
 *   - The pre-fix contrast is computed, not checked out: it applies the old
 *     fold-every-backslash transform to the very match this run produced and shows
 *     that path is absent on disk. This demonstrates the exact silent drop the fix
 *     removes without rebuilding the old tree.
 *
 * Run: NO_COLOR=1 node --import tsx proof/bootstrap-extra-files-literal-backslash-proof.mts
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  resolveExtraBootstrapPatternPaths,
  toPortableMatchPath,
} from "../src/agents/workspace-extra-bootstrap-walker.js";
import { loadExtraBootstrapFilesWithDiagnostics } from "../src/agents/workspace.js";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";
import bootstrapExtraFilesHook from "../src/hooks/bundled/bootstrap-extra-files/handler.js";
import {
  type AgentBootstrapHookContext,
  createInternalHookEvent,
} from "../src/hooks/internal-hooks.js";

// A directory whose name carries a literal backslash byte. On POSIX this is a
// perfectly legal filename; on Windows the byte is the path separator, which is
// why this harness gates to non-Windows.
const BACKSLASH_DIR = "back\\slash-dir"; // rendered: back\slash-dir
const BACKSLASH_CONTENT = "backslash agents";
const CONTROL_DIR = "plain-dir";
const CONTROL_CONTENT = "plain agents";

function redact(text: string, needles: string[]): string {
  let result = text;
  for (const needle of needles) {
    if (needle.length > 0) {
      result = result.split(needle).join("<workspace>");
    }
  }
  return result;
}

function makeExtraFilesConfig(patterns: string[]): OpenClawConfig {
  return {
    hooks: {
      internal: {
        entries: {
          "bootstrap-extra-files": { enabled: true, paths: patterns },
        },
      },
    },
  } as OpenClawConfig;
}

async function main(): Promise<void> {
  const headSha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const out: string[] = [];
  const w = (line = "") => out.push(line);

  w("================ PR #89040 literal-backslash extra-bootstrap runtime proof ================");
  w(`head:            ${headSha} (exact current HEAD)`);
  w(`node:            ${process.version}`);
  w(`os/arch:         ${os.type()} ${os.release()} ${process.arch}`);
  w("driven fn:       resolveExtraBootstrapPatternPaths + loadExtraBootstrapFilesWithDiagnostics");
  w("                 + bootstrapExtraFilesHook (all REAL, no mocks)");
  w("");

  // Windows cannot represent a literal-backslash filename (the separator is "\\"),
  // so the scenario under test is not constructible there. Skip cleanly as PASS;
  // the fix's Windows separator branch is covered by the injectable-separator
  // unit tests instead.
  if (process.platform === "win32") {
    w("PART: SKIP (literal backslash filenames are not representable on Windows)");
    w("VERDICT: PASS");
    w("==========================================================================================");
    process.stdout.write(`${out.join("\n")}\n`);
    return;
  }

  // Hermetic, redactable environment. NO_COLOR keeps the transcript plain; the
  // isolated OPENCLAW_HOME keeps any incidental state/log writes out of the
  // operator's real state dir. realpath the tmp base first: on macOS os.tmpdir()
  // is /var -> /private/var, and the walker's containment filter compares
  // canonical realpaths, so a raw /var workspace would reject every match.
  const tmpBase = await fsp.realpath(os.tmpdir());
  const cfgHome = fs.mkdtempSync(path.join(tmpBase, "openclaw-backslash-home-"));
  process.env.NO_COLOR = "1";
  delete process.env.FORCE_COLOR;
  process.env.OPENCLAW_HOME = cfgHome;
  process.env.OPENCLAW_STATE_DIR = path.join(cfgHome, "state");
  process.env.OPENCLAW_CONFIG_PATH = path.join(cfgHome, "no-such-openclaw.json");

  const workspace = fs.mkdtempSync(path.join(tmpBase, "openclaw-backslash-ws-"));
  const redactNeedles = [workspace, cfgHome];

  // Fixture: a real backslash-named directory + a plain control directory, each
  // with its own AGENTS.md and distinct content.
  const backslashDirAbs = path.join(workspace, BACKSLASH_DIR);
  fs.mkdirSync(backslashDirAbs, { recursive: true });
  const backslashFileAbs = path.join(backslashDirAbs, "AGENTS.md");
  fs.writeFileSync(backslashFileAbs, BACKSLASH_CONTENT);

  const controlDirAbs = path.join(workspace, CONTROL_DIR);
  fs.mkdirSync(controlDirAbs, { recursive: true });
  const controlFileAbs = path.join(controlDirAbs, "AGENTS.md");
  fs.writeFileSync(controlFileAbs, CONTROL_CONTENT);

  // The relative POSIX matches the resolver is expected to return. On POSIX
  // path.sep is "/", so toPortableMatchPath leaves the backslash byte untouched.
  const expectedBackslashMatch = `${BACKSLASH_DIR}/AGENTS.md`; // back\slash-dir/AGENTS.md
  const expectedControlMatch = `${CONTROL_DIR}/AGENTS.md`;
  // What the pre-fix fold-every-backslash normalization would have produced.
  const preFixFoldedMatch = expectedBackslashMatch.replaceAll("\\", "/"); // back/slash-dir/AGENTS.md

  let check1 = false;
  let check2 = false;
  let check3 = false;
  let check4 = false;

  try {
    // -- CHECK 1: the resolver returns the backslash match with the byte intact --
    const matches = await resolveExtraBootstrapPatternPaths(workspace, "**/AGENTS.md");
    const matchesSorted = [...matches].toSorted();
    const backslashByteIntact =
      matches.includes(expectedBackslashMatch) &&
      expectedBackslashMatch.includes("\\") &&
      !matches.includes(preFixFoldedMatch);
    check1 = backslashByteIntact;
    // Sanity: the resolver's separator-only fold is a no-op on POSIX for this match.
    const foldNoOpOnPosix = toPortableMatchPath(expectedBackslashMatch) === expectedBackslashMatch;

    w("-- CHECK 1: resolveExtraBootstrapPatternPaths keeps the literal backslash byte --");
    w(`   returned matches:       ${JSON.stringify(matchesSorted)}`);
    w(
      `   expected backslash match present:  ${matches.includes(expectedBackslashMatch)} (expect true)`,
    );
    w(
      `   folded ("back/slash-...") absent:  ${!matches.includes(preFixFoldedMatch)} (expect true)`,
    );
    w(`   toPortableMatchPath is a no-op here (POSIX sep="/"): ${foldNoOpOnPosix}`);
    w(`   CHECK 1: ${check1 ? "PASS" : "FAIL"}`);
    w("");

    // -- CHECK 2: the guarded loader actually LOADS the backslash file's content --
    const loaded = await loadExtraBootstrapFilesWithDiagnostics(workspace, ["**/AGENTS.md"]);
    const backslashLoaded = loaded.files.find((f) => f.path === backslashFileAbs);
    const diagnosticsEmpty = loaded.diagnostics.length === 0;
    check2 =
      backslashLoaded !== undefined &&
      backslashLoaded.content === BACKSLASH_CONTENT &&
      backslashLoaded.missing === false &&
      diagnosticsEmpty;

    // Drive the exact production consumption path too: the bundled hook appends
    // resolved extras to context.bootstrapFiles. Proves the file reaches the
    // session bootstrap set end-to-end, not just the loader's return value.
    const context: AgentBootstrapHookContext = {
      workspaceDir: workspace,
      bootstrapFiles: [] as AgentBootstrapHookContext["bootstrapFiles"],
      cfg: makeExtraFilesConfig(["**/AGENTS.md"]),
      sessionKey: "agent:main:main",
    };
    const event = createInternalHookEvent("agent", "bootstrap", "agent:main:main", context);
    await bootstrapExtraFilesHook(event);
    const hookAppendedBackslash = context.bootstrapFiles.some(
      (f) => f.path === backslashFileAbs && f.content === BACKSLASH_CONTENT,
    );
    check2 = check2 && hookAppendedBackslash;

    w("-- CHECK 2: guarded loader loads the backslash file's real content --");
    w(
      `   loaded path:            ${backslashLoaded ? redact(backslashLoaded.path, redactNeedles) : "(not loaded)"}`,
    );
    w(`   loaded content matches: ${backslashLoaded?.content === BACKSLASH_CONTENT} (expect true)`);
    w(`   diagnostics empty:      ${diagnosticsEmpty} (expect true)`);
    w(
      `   diagnostics:            ${JSON.stringify(loaded.diagnostics.map((d) => ({ reason: d.reason, path: redact(d.path, redactNeedles) })))}`,
    );
    w(
      `   bundled hook appended it to context.bootstrapFiles: ${hookAppendedBackslash} (expect true)`,
    );
    w(`   CHECK 2: ${check2 ? "PASS" : "FAIL"}`);
    w("");

    // -- CHECK 3: PRE-FIX CONTRAST — the folded path points at a missing file --
    const preFixTargetAbs = path.resolve(workspace, preFixFoldedMatch);
    const preFixTargetExists = fs.existsSync(preFixTargetAbs);
    check3 = preFixTargetExists === false;

    w("-- CHECK 3: PRE-FIX CONTRAST — fold-every-backslash pointed at a missing file --");
    w(`   pre-fix folded match:   ${preFixFoldedMatch}  (old normalization output)`);
    w(`   resolves on disk to:    ${redact(preFixTargetAbs, redactNeedles)}`);
    w(
      `   fs.existsSync(folded):  ${preFixTargetExists} (expect false — the silent drop the fix removes)`,
    );
    w(`   CHECK 3: ${check3 ? "PASS" : "FAIL"}`);
    w("");

    // -- CHECK 4: CONTROL — the ordinary (no backslash) path is unaffected --
    const controlLoaded = loaded.files.find((f) => f.path === controlFileAbs);
    check4 =
      matches.includes(expectedControlMatch) &&
      controlLoaded !== undefined &&
      controlLoaded.content === CONTROL_CONTENT;

    w("-- CHECK 4: CONTROL — a plain (backslash-free) AGENTS.md still loads --");
    w(`   control match present:  ${matches.includes(expectedControlMatch)} (expect true)`);
    w(
      `   control loaded path:    ${controlLoaded ? redact(controlLoaded.path, redactNeedles) : "(not loaded)"}`,
    );
    w(`   control content matches: ${controlLoaded?.content === CONTROL_CONTENT} (expect true)`);
    w(`   CHECK 4: ${check4 ? "PASS" : "FAIL"}`);
    w("");
  } finally {
    await fsp.rm(workspace, { recursive: true, force: true });
    await fsp.rm(cfgHome, { recursive: true, force: true });
  }

  const pass = check1 && check2 && check3 && check4;
  w("PRE-FIX NOTE:");
  w("   Before this PR the resolver folded every backslash in a match, so a real");
  w("   file at back\\slash-dir/AGENTS.md was looked up at back/slash-dir/AGENTS.md");
  w("   (CHECK 3), found nothing, and dropped the configured bootstrap file silently.");
  w("   The intact match + real content load above (CHECKS 1-2) is this PR's effect.");
  w("");
  w(`VERDICT: ${pass ? "PASS" : "FAIL"}`);
  w("==========================================================================================");

  process.stdout.write(`${out.join("\n")}\n`);
  if (!pass) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error("[literal-backslash-proof] FAILED", error);
  process.exitCode = 1;
});
