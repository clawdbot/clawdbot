/**
 * Runtime proof for PR #89040's fs.glob-absent extra-bootstrap DIRECTORY-YIELD fix.
 *
 * SCOPE (read this before trusting a green run):
 *   This harness proves ONE thing at runtime, over real on-disk fixtures and the
 *   real production code path, ON A RUNTIME WITHOUT fs.promises.glob: the local
 *   Minimatch fallback walk yields a DIRECTORY (or a descended directory symlink)
 *   that fully matches the pattern — exactly as Node's fs.glob does — instead of
 *   descending it and silently dropping the directory match. fs.glob owns matching
 *   where it exists and already yields fully-matching directories, so the gap only
 *   shows on runtimes that ship no fs.glob (older Node, some Bun builds), where the
 *   fallback walk is the matcher.
 *
 *   The fix lives in src/agents/workspace-extra-bootstrap-walker.ts: the plain-
 *   directory branch and the descended-symlink branch each now `yield` the match
 *   key when it fully matches (patternMatchesDirectory), which also tests the
 *   slash-terminated candidate key `dir/` so a trailing-slash directory-only
 *   pattern (`pkg/*\/`) matches. The pre-fix fallback descended such a directory but
 *   never yielded it, so the configured match was dropped with no operator trace on
 *   a no-fs.glob runtime.
 *
 * Method — every parity case is byte-checked against a LIVE fs.glob oracle:
 *   For each case the harness computes Node's real fs.glob result FIRST (while the
 *   API exists), then HIDES fs.promises.glob for the fallback resolve and asserts
 *   the fallback array is byte-equal to that oracle. Only fs.promises.glob is hidden
 *   — to REACH the fallback, never to fake it; the resolver, loader and bundled hook
 *   are the real production code with no mocks.
 *
 * What is driven (no mocks of the pipeline):
 *   - resolveExtraBootstrapPatternPaths(workspace, pattern)
 *       the real resolver + workspace realpath containment filter, on the fallback.
 *   - loadExtraBootstrapFilesWithDiagnostics(workspace, [...])
 *       the real guarded loader the bundled hook calls (files + diagnostics).
 *   - bootstrapExtraFilesHook over a real AgentBootstrapHookContext
 *       the exact production consumption path that appends to context.bootstrapFiles.
 *
 * Cases:
 *   1. NATIVE-PREFERRED CONTROL: with fs.glob present the resolver uses it (a wrapper
 *      records the call) and the native result contains the directory — the fallback
 *      never replaces the normal path.
 *   2. REAL DIRECTORY FULL MATCH: `pkg/*` -> ["pkg/core","pkg/notes.md"].
 *   3. TRAILING-SLASH DIRECTORY-ONLY: `pkg/*\/` -> ["pkg/core"] (file excluded).
 *   4. DESCENDED LITERAL DIRECTORY SYMLINK FULL MATCH: `**\/pkg/linked` -> ["pkg/linked"].
 *   5. NEGATIVE PREFIX: `pkg/*\/inner` -> ["pkg/core/inner"], prefix `pkg/core` absent.
 *   6. DESCENDED FULL-MATCH RESOLVES ONCE: a directory that fully matches AND is
 *      descended resolves to a single entry (the resolver folds duplicates via a Set).
 *   7. TERMINAL NON-DESCENDED SYMLINK NOT SLASH-MATCHED: a wildcard-reached dir
 *      symlink leaf is not matched by the directory-only `pkg/*\/` (== oracle == []).
 *   8. LOADER-BOUNDARY OUTCOME: a directory match reaches the loader as a RECORDED
 *      diagnostic (never a silent nothing), while a real AGENTS.md still loads with
 *      zero diagnostics and is appended by the bundled hook.
 *
 * Honest limits:
 *   - Directory symlinks may be unconstructible in some sandboxes (EPERM/ENOSYS);
 *     there the affected symlink case (4 and/or 7) is reported as SKIP in the summary,
 *     independently, and does not fail the run.
 *   - fs.promises.glob must exist to build the live parity oracle, so a runtime that
 *     ships no fs.glob SKIPS the whole run (the fallback is proven by hiding fs.glob on
 *     a runtime that has it).
 *   - Windows is out of scope for the POSIX symlink semantics; the whole run SKIPS.
 *
 * Run: NO_COLOR=1 node --import tsx proof/bootstrap-extra-files-directory-yield-proof.mts
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveExtraBootstrapPatternPaths } from "../src/agents/workspace-extra-bootstrap-walker.js";
import { loadExtraBootstrapFilesWithDiagnostics } from "../src/agents/workspace.js";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";
import bootstrapExtraFilesHook from "../src/hooks/bundled/bootstrap-extra-files/handler.js";
import {
  type AgentBootstrapHookContext,
  createInternalHookEvent,
} from "../src/hooks/internal-hooks.js";

const POSITIVE_CONTENT = "positive bootstrap";

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

// Try to create a directory symlink; return false if the sandbox forbids it so the
// symlink-dependent cases can SKIP instead of asserting on a fixture that could not
// be built.
function trySymlink(target: string, linkPath: string): boolean {
  try {
    fs.symlinkSync(target, linkPath, "dir");
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? "";
    if (["EPERM", "EACCES", "ENOSYS"].includes(code)) {
      return false;
    }
    throw err;
  }
}

// The LIVE fs.glob parity oracle: Node's real fs.glob set for a pattern, folded and
// sorted exactly like the resolver's output, so a byte comparison is meaningful.
// Computed only while fs.glob exists — it is the independent yardstick the hidden-
// glob fallback must reproduce.
async function nativeGlobOracle(workspaceDir: string, pattern: string): Promise<string[]> {
  const matches: string[] = [];
  for await (const match of fsp.glob(pattern, { cwd: workspaceDir })) {
    matches.push(match.replaceAll(path.sep, "/"));
  }
  return matches.toSorted();
}

async function main(): Promise<void> {
  const headSha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const out: string[] = [];
  const w = (line = "") => out.push(line);
  const eq = (a: string[], b: string[]) => JSON.stringify(a) === JSON.stringify(b);

  w("=============== PR #89040 fs.glob-absent directory-yield runtime proof ===============");
  w(`head:            ${headSha} (exact current HEAD)`);
  w(`node:            ${process.version}`);
  w(`os/arch:         ${os.type()} ${os.release()} ${process.arch}`);
  w("driven fn:       resolveExtraBootstrapPatternPaths + loadExtraBootstrapFilesWithDiagnostics");
  w("                 + bootstrapExtraFilesHook (all REAL; only fs.promises.glob is hidden)");
  w("oracle:          Node fs.promises.glob computed live per case (byte-equal parity)");
  w("");

  if (process.platform === "win32") {
    w("PART: SKIP (POSIX directory-symlink semantics are out of scope on Windows)");
    w("VERDICT: PASS");
    w("======================================================================================");
    process.stdout.write(`${out.join("\n")}\n`);
    return;
  }

  // Live-parity proof: every case is byte-checked against Node's real fs.glob, so the
  // oracle needs fs.promises.glob to exist. On a runtime that ships no fs.glob (older
  // Node, some Bun builds) — the very runtime class the fix targets — the oracle is
  // unbuildable, so SKIP cleanly as PASS instead of crashing in the CHECK 1 wrapper or
  // the oracle. The fallback itself is still proven by hiding fs.glob on a runtime that
  // has it; this proof simply has to be RUN on such a runtime.
  if (typeof fsp.glob !== "function") {
    w("PART: SKIP (this runtime ships no fs.promises.glob; the live parity oracle needs it)");
    w("VERDICT: PASS");
    w("======================================================================================");
    process.stdout.write(`${out.join("\n")}\n`);
    return;
  }

  // Hermetic, redactable environment. realpath the tmp base first: on macOS
  // os.tmpdir() is /var -> /private/var and the walker's containment filter compares
  // canonical realpaths, so a raw /var workspace would reject every match.
  const tmpBase = await fsp.realpath(os.tmpdir());
  const cfgHome = fs.mkdtempSync(path.join(tmpBase, "openclaw-diryield-home-"));
  process.env.NO_COLOR = "1";
  delete process.env.FORCE_COLOR;
  process.env.OPENCLAW_HOME = cfgHome;
  process.env.OPENCLAW_STATE_DIR = path.join(cfgHome, "state");
  process.env.OPENCLAW_CONFIG_PATH = path.join(cfgHome, "no-such-openclaw.json");

  const mkWorkspace = (label: string) =>
    fs.mkdtempSync(path.join(tmpBase, `openclaw-diryield-${label}-`));

  // -- Fixtures. Each case gets its own hermetic workspace so patterns cannot
  //    cross-match. ws2 is shared by the plain-directory cases (2, 3, 8, and the
  //    native control 1) since they all need `pkg/core` (dir) + `pkg/notes.md` (file).
  const ws2 = mkWorkspace("dir");
  fs.mkdirSync(path.join(ws2, "pkg", "core"), { recursive: true });
  fs.writeFileSync(path.join(ws2, "pkg", "notes.md"), "notes");

  const ws5 = mkWorkspace("prefix");
  fs.mkdirSync(path.join(ws5, "pkg", "core", "inner"), { recursive: true });

  const ws6 = mkWorkspace("once");
  fs.mkdirSync(path.join(ws6, "pkg", "core"), { recursive: true });
  fs.writeFileSync(path.join(ws6, "pkg", "core", "x.md"), "child"); // deeper than `pkg/*` can match

  const wsPos = mkWorkspace("positive");
  fs.mkdirSync(path.join(wsPos, "sub"), { recursive: true });
  const positiveFileAbs = path.join(wsPos, "sub", "AGENTS.md");
  fs.writeFileSync(positiveFileAbs, POSITIVE_CONTENT);

  // Symlink-dependent fixtures (cases 4 and 7), built independently. If the sandbox
  // forbids a directory symlink, only that case SKIPs (shown as SKIP in the summary,
  // not FAIL, so the run still exits 0); the other still runs.
  const ws4 = mkWorkspace("linked");
  fs.mkdirSync(path.join(ws4, "pkg"), { recursive: true });
  fs.mkdirSync(path.join(ws4, "target"), { recursive: true });
  fs.writeFileSync(path.join(ws4, "target", "AGENTS.md"), "behind-link");
  const ws4Ok = trySymlink(path.join("..", "target"), path.join(ws4, "pkg", "linked"));

  const ws7 = mkWorkspace("leaf");
  fs.mkdirSync(path.join(ws7, "pkg"), { recursive: true });
  fs.mkdirSync(path.join(ws7, "target"), { recursive: true });
  const ws7Ok = trySymlink(path.join("..", "target"), path.join(ws7, "pkg", "leaf"));

  const redactNeedles = [ws2, ws5, ws6, wsPos, ws4, ws7, cfgHome];
  const allWorkspaces = [ws2, ws5, ws6, wsPos, ws4, ws7, cfgHome];

  const originalGlobDescriptor = Object.getOwnPropertyDescriptor(fsp, "glob");
  const results: { name: string; pass: boolean; skipped?: boolean }[] = [];
  const record = (name: string, pass: boolean, skipped = false) =>
    results.push({ name, pass, skipped });

  // Print one parity case: fallback array, oracle array, an equal line, and the
  // documented expected exact value. PASS requires fallback == oracle AND, when an
  // expected value is given, fallback == expected.
  const parityCase = (
    label: string,
    pattern: string,
    fallback: string[],
    oracle: string[],
    expected: string[],
    extra?: { note: string; ok: boolean },
  ): void => {
    const fb = fallback.toSorted();
    const or = oracle.toSorted();
    const exp = expected.toSorted();
    const equal = eq(fb, or);
    const expectedOk = eq(fb, exp);
    const extraOk = extra ? extra.ok : true;
    const pass = equal && expectedOk && extraOk;
    w(`-- ${label} (pattern: ${JSON.stringify(pattern)}) --`);
    w(`   fallback result:  ${JSON.stringify(fb)}`);
    w(`   fs.glob oracle:   ${JSON.stringify(or)}`);
    w(`   expected:         ${JSON.stringify(exp)}`);
    w(`   equal:            ${equal}`);
    if (extra) {
      w(`   ${extra.note}: ${extra.ok}`);
    }
    w(`   ${label}: ${pass ? "PASS" : "FAIL"}`);
    w("");
    record(label, pass);
  };

  try {
    // -- CHECK 1: NATIVE-PREFERRED CONTROL — with fs.glob present the resolver uses
    //    it (wrapper records the call) and native yields the directory. --
    let globCalls = 0;
    Object.defineProperty(fsp, "glob", {
      value: (pattern: string, opts: { cwd: string }) => {
        globCalls += 1;
        return originalGlobDescriptor!.value.call(fsp, pattern, opts);
      },
      configurable: true,
      writable: true,
    });
    const nativeMatches = (await resolveExtraBootstrapPatternPaths(ws2, "pkg/*")).toSorted();
    if (originalGlobDescriptor) {
      Object.defineProperty(fsp, "glob", originalGlobDescriptor);
    }
    const check1 = globCalls > 0 && nativeMatches.includes("pkg/core");
    w('-- CHECK 1: NATIVE-PREFERRED CONTROL (fs.glob present, pattern: "pkg/*") --');
    w(`   fs.glob wrapper call count:      ${globCalls} (expect > 0)`);
    w(`   native result:                   ${JSON.stringify(nativeMatches)}`);
    w(`   native contains pkg/core:        ${nativeMatches.includes("pkg/core")} (expect true)`);
    w(`   CHECK 1: ${check1 ? "PASS" : "FAIL"}`);
    w("");
    record("CHECK 1 native-preferred", check1);

    // -- Oracles: Node's real fs.glob set per case, computed WHILE fs.glob exists. --
    const oracle2 = await nativeGlobOracle(ws2, "pkg/*");
    const oracle3 = await nativeGlobOracle(ws2, "pkg/*/");
    const oracle5 = await nativeGlobOracle(ws5, "pkg/*/inner");
    const oracle6 = await nativeGlobOracle(ws6, "pkg/*");
    const oracle4 = ws4Ok ? await nativeGlobOracle(ws4, "**/pkg/linked") : [];
    const oracle7ctrl = ws7Ok ? await nativeGlobOracle(ws7, "pkg/*") : [];
    const oracle7 = ws7Ok ? await nativeGlobOracle(ws7, "pkg/*/") : [];

    // Hide fs.promises.glob for the WHOLE fallback phase: the fix under proof only
    // matters where fs.glob does not exist, so hiding it is how we reach the changed
    // code, not how we fake a result. CHECK 1 already proved this mutation is what
    // production observes — its wrapper on this same namespace object was invoked by
    // the resolver — so setting the property undefined here forces production's
    // `typeof fs.glob === "function"` branch (workspace-extra-bootstrap-walker.ts) to
    // the fallback walk rather than the parity cases silently re-running native glob.
    Object.defineProperty(fsp, "glob", { value: undefined, configurable: true, writable: true });
    const check0 = typeof (fsp as { glob?: unknown }).glob !== "function";
    w("-- CHECK 0: fs.promises.glob is absent, so every resolve below takes the fallback walk --");
    w(`   typeof fs.glob !== "function": ${check0} (expect true)`);
    w(`   CHECK 0: ${check0 ? "PASS" : "FAIL"}`);
    w("");
    record("CHECK 0 fallback forced", check0);

    // -- CHECK 2: REAL DIRECTORY FULL MATCH --
    parityCase(
      "CHECK 2 directory full match",
      "pkg/*",
      await resolveExtraBootstrapPatternPaths(ws2, "pkg/*"),
      oracle2,
      ["pkg/core", "pkg/notes.md"],
    );

    // -- CHECK 3: TRAILING-SLASH DIRECTORY-ONLY. Note: the matcher tests the slash-
    //    terminated candidate key `pkg/core/` internally, but the public result is
    //    the native-compatible key `pkg/core` (no trailing slash). --
    const c3 = (await resolveExtraBootstrapPatternPaths(ws2, "pkg/*/")).toSorted();
    parityCase("CHECK 3 trailing-slash directory-only", "pkg/*/", c3, oracle3, ["pkg/core"], {
      note: "public key has no trailing slash (native-compatible)",
      ok: c3.includes("pkg/core") && !c3.includes("pkg/core/"),
    });

    // -- CHECK 4: DESCENDED LITERAL DIRECTORY SYMLINK FULL MATCH --
    if (ws4Ok) {
      parityCase(
        "CHECK 4 descended directory-symlink full match",
        "**/pkg/linked",
        await resolveExtraBootstrapPatternPaths(ws4, "**/pkg/linked"),
        oracle4,
        ["pkg/linked"],
      );
    } else {
      w("-- CHECK 4 descended directory-symlink full match: SKIP (sandbox forbids symlinks) --");
      w("");
      record("CHECK 4 descended directory-symlink full match", true, true);
    }

    // -- CHECK 5: NEGATIVE PREFIX — full match only, never the partial-prefix descent
    //    gate: `pkg/core/inner` present, prefix `pkg/core` absent. --
    const c5 = (await resolveExtraBootstrapPatternPaths(ws5, "pkg/*/inner")).toSorted();
    parityCase("CHECK 5 negative prefix", "pkg/*/inner", c5, oracle5, ["pkg/core/inner"], {
      note: "prefix pkg/core absent (full-match only)",
      ok: c5.includes("pkg/core/inner") && !c5.includes("pkg/core"),
    });

    // -- CHECK 6: DESCENDED FULL-MATCH RESOLVES ONCE — `pkg/core` fully matches `pkg/*`
    //    AND is descended (its child x.md is read but cannot match). The resolver folds
    //    duplicates through a Set, so this confirms the descend-and-yield path surfaces
    //    the directory as a single resolved entry in parity with fs.glob; it cannot
    //    observe a raw generator double-yield (the Set would absorb one). --
    const c6 = (await resolveExtraBootstrapPatternPaths(ws6, "pkg/*")).toSorted();
    parityCase("CHECK 6 descended full-match resolves once", "pkg/*", c6, oracle6, ["pkg/core"], {
      note: "resolved pkg/core entries == 1",
      ok: c6.filter((m) => m === "pkg/core").length === 1,
    });

    // -- CHECK 7: TERMINAL NON-DESCENDED SYMLINK NOT SLASH-MATCHED. The wildcard-
    //    reached dir symlink `pkg/leaf` is a valid leaf under `pkg/*` (control), but a
    //    directory-only `pkg/*/` does not slash-match the undescended leaf: == [] . --
    if (ws7Ok) {
      const c7ctrl = (await resolveExtraBootstrapPatternPaths(ws7, "pkg/*")).toSorted();
      parityCase(
        "CHECK 7a control (leaf matches non-directory pattern)",
        "pkg/*",
        c7ctrl,
        oracle7ctrl,
        ["pkg/leaf"],
      );
      const c7 = (await resolveExtraBootstrapPatternPaths(ws7, "pkg/*/")).toSorted();
      parityCase(
        "CHECK 7b directory-only excludes undescended symlink leaf",
        "pkg/*/",
        c7,
        oracle7,
        [],
      );
    } else {
      w(
        "-- CHECK 7 terminal non-descended symlink not slash-matched: SKIP (sandbox forbids symlinks) --",
      );
      w("");
      record("CHECK 7 terminal non-descended symlink", true, true);
    }

    // -- CHECK 8: LOADER-BOUNDARY OUTCOME. The directory match `pkg/core` reaches the
    //    guarded loader as a RECORDED diagnostic (invalid-bootstrap-filename for the
    //    non-bootstrap basename `core`) — never a silent nothing. In the SAME run a
    //    real AGENTS.md still loads with zero diagnostics and is appended by the
    //    bundled hook, proving directory-yield did not regress file loading. --
    const dirLoad = await loadExtraBootstrapFilesWithDiagnostics(ws2, ["pkg/*"]);
    const dirDiag = dirLoad.diagnostics.find(
      (d) => d.reason === "invalid-bootstrap-filename" && path.basename(d.path) === "core",
    );
    const dirReachedLoader = dirDiag !== undefined;

    const posLoad = await loadExtraBootstrapFilesWithDiagnostics(wsPos, ["**/AGENTS.md"]);
    const posLoaded = posLoad.files.find((f) => f.path === positiveFileAbs);
    const posDiagnosticsEmpty = posLoad.diagnostics.length === 0;

    const context: AgentBootstrapHookContext = {
      workspaceDir: wsPos,
      bootstrapFiles: [] as AgentBootstrapHookContext["bootstrapFiles"],
      cfg: makeExtraFilesConfig(["**/AGENTS.md"]),
      sessionKey: "agent:main:main",
    };
    const event = createInternalHookEvent("agent", "bootstrap", "agent:main:main", context);
    await bootstrapExtraFilesHook(event);
    const hookAppendedPositive = context.bootstrapFiles.some(
      (f) => f.path === positiveFileAbs && f.content === POSITIVE_CONTENT,
    );

    const check8 =
      dirReachedLoader &&
      posLoaded !== undefined &&
      posLoaded.content === POSITIVE_CONTENT &&
      posLoaded.missing === false &&
      posDiagnosticsEmpty &&
      hookAppendedPositive;
    w("-- CHECK 8: LOADER-BOUNDARY OUTCOME (fallback forced; directory match is recorded) --");
    w(
      `   directory match pkg/core reached loader as recorded diagnostic: ${dirReachedLoader} (expect true)`,
    );
    w(
      `   directory diagnostic:  ${dirDiag ? JSON.stringify({ reason: dirDiag.reason, path: redact(dirDiag.path, redactNeedles) }) : "(none)"}`,
    );
    w(
      `   positive control loaded path:    ${posLoaded ? redact(posLoaded.path, redactNeedles) : "(not loaded)"}`,
    );
    w(
      `   positive control content matches: ${posLoaded?.content === POSITIVE_CONTENT} (expect true)`,
    );
    w(`   positive control diagnostics empty: ${posDiagnosticsEmpty} (expect true)`);
    w(`   bundled hook appended positive control: ${hookAppendedPositive} (expect true)`);
    w(`   CHECK 8: ${check8 ? "PASS" : "FAIL"}`);
    w("");
    record("CHECK 8 loader-boundary", check8);
  } finally {
    if (originalGlobDescriptor) {
      Object.defineProperty(fsp, "glob", originalGlobDescriptor);
    }
    for (const dir of allWorkspaces) {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  }

  const pass = results.every((r) => r.pass);
  const skippedCount = results.filter((r) => r.skipped).length;
  w("PRE-FIX NOTE:");
  w("   Before this PR the fs.glob-absent fallback descended a fully-matching directory");
  w("   (or descended directory symlink) but never yielded it, so `pkg/*`, `pkg/*/`,");
  w("   `**/pkg/linked` and `pkg/*/inner` dropped their directory matches silently on a");
  w("   no-fs.glob runtime. The byte-equal parity with the live fs.glob oracle above is");
  w("   this PR's effect.");
  w("");
  w("SUMMARY:");
  for (const r of results) {
    const tag = r.skipped ? "SKIP" : r.pass ? "PASS" : "FAIL";
    w(`   ${tag}  ${r.name}`);
  }
  w("");
  // Carry the skip count on the verdict line so a partial run (e.g. a sandbox that
  // could not build a directory symlink, leaving CHECK 4/7 unexercised) cannot read as
  // full coverage to anyone scanning only VERDICT. Still exits 0 — a skip is not a fail.
  const skipSuffix = pass && skippedCount > 0 ? ` (${skippedCount} SKIPPED)` : "";
  w(`VERDICT: ${pass ? "PASS" : "FAIL"}${skipSuffix}`);
  w("======================================================================================");

  process.stdout.write(`${out.join("\n")}\n`);
  if (!pass) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error("[directory-yield-proof] FAILED", error);
  process.exitCode = 1;
});
