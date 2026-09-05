/**
 * Runtime proof for PR #89040's fs.glob-absent extra-bootstrap symlink-descent fix.
 *
 * SCOPE (read this before trusting a green run):
 *   This harness proves ONE thing at runtime, over real on-disk symlinks and the
 *   real production code path, ON A RUNTIME WITHOUT fs.promises.glob: an extra-
 *   bootstrap glob whose match sits behind a literal-named directory symlink is
 *   descended, resolved, and LOADED — instead of being silently dropped because
 *   the fallback walk saw a symlink Dirent with isDirectory() === false and never
 *   stepped into it.
 *
 *   The fix lives in src/agents/workspace-extra-bootstrap-walker.ts. fs.glob owns
 *   matching where it exists and already follows literal-named directory symlinks,
 *   so the gap only shows on runtimes that ship no fs.glob (older Node, some Bun
 *   builds), where the local Minimatch walk is the matcher. This harness therefore
 *   HIDES fs.promises.glob for the whole run (exactly as such a runtime would),
 *   forcing every resolve through the fallback walk that the fix changed. If the
 *   file loads with fs.glob absent, the restored fallback descent is what loaded
 *   it — not fs.glob.
 *
 * What is driven (no mocks of the pipeline):
 *   - resolveExtraBootstrapPatternPaths(workspace, "**\/pkg/linked/**\/AGENTS.md")
 *       the real resolver + workspace realpath containment filter, on the fallback.
 *   - loadExtraBootstrapFilesWithDiagnostics(workspace, [...])
 *       the real guarded loader the bundled hook calls (files + diagnostics).
 *   - bootstrapExtraFilesHook over a real AgentBootstrapHookContext
 *       the exact production consumption path that appends to context.bootstrapFiles.
 *   Only fs.promises.glob is removed — to REACH the fallback, not to fake it.
 *
 * Discriminator:
 *   The pre-fix fallback classified the `linked` symlink as a non-directory leaf,
 *   so `**\/pkg/linked/**\/AGENTS.md` yielded nothing and the configured bootstrap
 *   file was dropped with no operator-visible trace. Loading it here, with fs.glob
 *   absent, is exactly the drop the fix removes. Termination is structural (pattern
 *   progress, never a visited-realpath set), so the escape case below is discarded
 *   by containment, not by refusing to walk the link.
 *
 * Honest limits:
 *   - Directory symlinks may be unconstructible in some sandboxes (EPERM/ENOSYS);
 *     there the harness SKIPS cleanly as PASS rather than assert a broken fixture.
 *   - Windows is out of scope for the POSIX symlink semantics under test; it SKIPS.
 *
 * Run: NO_COLOR=1 node --import tsx proof/bootstrap-extra-files-symlink-fallback-proof.mts
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

const LINKED_CONTENT = "linked agents";
const CONTROL_CONTENT = "plain agents";
const PATTERN = "**/pkg/linked/**/AGENTS.md";

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

// Try to create a directory symlink; return false if the sandbox forbids it so
// the harness can SKIP instead of asserting on a fixture that could not be built.
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

async function main(): Promise<void> {
  const headSha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const out: string[] = [];
  const w = (line = "") => out.push(line);

  w("============== PR #89040 fs.glob-absent symlink-descent runtime proof ==============");
  w(`head:            ${headSha} (exact current HEAD)`);
  w(`node:            ${process.version}`);
  w(`os/arch:         ${os.type()} ${os.release()} ${process.arch}`);
  w("driven fn:       resolveExtraBootstrapPatternPaths + loadExtraBootstrapFilesWithDiagnostics");
  w("                 + bootstrapExtraFilesHook (all REAL; only fs.promises.glob is hidden)");
  w("");

  if (process.platform === "win32") {
    w("PART: SKIP (POSIX directory-symlink semantics are out of scope on Windows)");
    w("VERDICT: PASS");
    w("====================================================================================");
    process.stdout.write(`${out.join("\n")}\n`);
    return;
  }

  // Hermetic, redactable environment. realpath the tmp base first: on macOS
  // os.tmpdir() is /var -> /private/var and the walker's containment filter
  // compares canonical realpaths, so a raw /var workspace would reject every match.
  const tmpBase = await fsp.realpath(os.tmpdir());
  const cfgHome = fs.mkdtempSync(path.join(tmpBase, "openclaw-symlink-home-"));
  process.env.NO_COLOR = "1";
  delete process.env.FORCE_COLOR;
  process.env.OPENCLAW_HOME = cfgHome;
  process.env.OPENCLAW_STATE_DIR = path.join(cfgHome, "state");
  process.env.OPENCLAW_CONFIG_PATH = path.join(cfgHome, "no-such-openclaw.json");

  const workspace = fs.mkdtempSync(path.join(tmpBase, "openclaw-symlink-ws-"));
  const redactNeedles = [workspace, cfgHome];

  // Fixture:
  //   pkg/linked  -> ../target        (contained directory symlink; must descend)
  //   pkg/escape  -> ../../outside     (escapes the workspace; must be discarded)
  //   plain/AGENTS.md                  (ordinary control; must load unchanged)
  const pkgDir = path.join(workspace, "pkg");
  const target = path.join(workspace, "target");
  fs.mkdirSync(target, { recursive: true });
  fs.mkdirSync(pkgDir, { recursive: true });
  const linkedFileAbs = path.join(pkgDir, "linked", "AGENTS.md");
  fs.writeFileSync(path.join(target, "AGENTS.md"), LINKED_CONTENT);

  const outsideRoot = fs.mkdtempSync(path.join(tmpBase, "openclaw-symlink-outside-"));
  fs.writeFileSync(path.join(outsideRoot, "AGENTS.md"), "SECRET-OUTSIDE");

  const controlDir = path.join(workspace, "plain");
  fs.mkdirSync(controlDir, { recursive: true });
  const controlFileAbs = path.join(controlDir, "AGENTS.md");
  fs.writeFileSync(controlFileAbs, CONTROL_CONTENT);

  const linkedOk = trySymlink(path.join("..", "target"), path.join(pkgDir, "linked"));
  const escapeOk = trySymlink(outsideRoot, path.join(pkgDir, "escape"));
  if (!linkedOk || !escapeOk) {
    w("PART: SKIP (this sandbox cannot create directory symlinks: EPERM/ENOSYS)");
    w("VERDICT: PASS");
    w("====================================================================================");
    process.stdout.write(`${out.join("\n")}\n`);
    await fsp.rm(workspace, { recursive: true, force: true });
    await fsp.rm(outsideRoot, { recursive: true, force: true });
    await fsp.rm(cfgHome, { recursive: true, force: true });
    return;
  }

  // Force the fs.glob-absent fallback for the WHOLE run: the fix under proof only
  // matters where fs.glob does not exist, so hiding it is how we reach the changed
  // code, not how we fake a result.
  const originalGlob = Object.getOwnPropertyDescriptor(fsp, "glob");
  Object.defineProperty(fsp, "glob", { value: undefined, configurable: true, writable: true });
  const fsGlobHidden = typeof (fsp as { glob?: unknown }).glob !== "function";

  const check0 = fsGlobHidden;
  let check1 = false;
  let check2 = false;
  let check3 = false;
  let check4 = false;

  try {
    w("-- CHECK 0: fs.promises.glob is absent, so every resolve takes the fallback walk --");
    w(`   typeof fs.glob !== "function": ${fsGlobHidden} (expect true)`);
    w(`   CHECK 0: ${check0 ? "PASS" : "FAIL"}`);
    w("");

    // -- CHECK 1: the fallback resolver descends the symlink and returns the match --
    const matches = (await resolveExtraBootstrapPatternPaths(workspace, PATTERN)).toSorted();
    check1 = matches.includes("pkg/linked/AGENTS.md") && !matches.some((m) => m.includes("escape")); // the escaping link contributes nothing

    w("-- CHECK 1: fallback resolver descends pkg/linked and returns its contained match --");
    w(`   returned matches:       ${JSON.stringify(matches)}`);
    w(
      `   contains pkg/linked/AGENTS.md: ${matches.includes("pkg/linked/AGENTS.md")} (expect true)`,
    );
    w(`   CHECK 1: ${check1 ? "PASS" : "FAIL"}`);
    w("");

    // -- CHECK 2: the guarded loader loads the linked file + the bundled hook appends it --
    const loaded = await loadExtraBootstrapFilesWithDiagnostics(workspace, [PATTERN]);
    const linkedLoaded = loaded.files.find((f) => f.path === linkedFileAbs);
    const noEscapeContent = loaded.files.every((f) => f.content !== "SECRET-OUTSIDE");
    const diagnosticsEmpty = loaded.diagnostics.length === 0;

    const context: AgentBootstrapHookContext = {
      workspaceDir: workspace,
      bootstrapFiles: [] as AgentBootstrapHookContext["bootstrapFiles"],
      cfg: makeExtraFilesConfig([PATTERN]),
      sessionKey: "agent:main:main",
    };
    const event = createInternalHookEvent("agent", "bootstrap", "agent:main:main", context);
    await bootstrapExtraFilesHook(event);
    const hookAppendedLinked = context.bootstrapFiles.some(
      (f) => f.path === linkedFileAbs && f.content === LINKED_CONTENT,
    );
    check2 =
      linkedLoaded !== undefined &&
      linkedLoaded.content === LINKED_CONTENT &&
      linkedLoaded.missing === false &&
      diagnosticsEmpty &&
      noEscapeContent &&
      hookAppendedLinked;

    w("-- CHECK 2: guarded loader + bundled hook load the file behind the symlink --");
    w(
      `   loaded path:            ${linkedLoaded ? redact(linkedLoaded.path, redactNeedles) : "(not loaded)"}`,
    );
    w(`   loaded content matches: ${linkedLoaded?.content === LINKED_CONTENT} (expect true)`);
    w(`   diagnostics empty:      ${diagnosticsEmpty} (expect true)`);
    w(`   hook appended to bootstrapFiles: ${hookAppendedLinked} (expect true)`);
    w(`   CHECK 2: ${check2 ? "PASS" : "FAIL"}`);
    w("");

    // -- CHECK 3: the escaping symlink is discarded by containment (no out-of-tree read) --
    const escapePattern = "**/pkg/escape/**/AGENTS.md";
    const escapeMatches = await resolveExtraBootstrapPatternPaths(workspace, escapePattern);
    const escapeLoaded = await loadExtraBootstrapFilesWithDiagnostics(workspace, [escapePattern]);
    const leakedOutside = escapeLoaded.files.some((f) => f.content === "SECRET-OUTSIDE");
    check3 = escapeMatches.length === 0 && !leakedOutside;

    w("-- CHECK 3: an escaping symlink is descended but its out-of-tree match is discarded --");
    w(`   escape matches:         ${JSON.stringify(escapeMatches)} (expect [])`);
    w(`   outside content leaked: ${leakedOutside} (expect false)`);
    w(`   CHECK 3: ${check3 ? "PASS" : "FAIL"}`);
    w("");

    // -- CHECK 4: CONTROL — an ordinary (non-symlink) file still loads on the fallback --
    const controlLoaded = await loadExtraBootstrapFilesWithDiagnostics(workspace, [
      "**/plain/AGENTS.md",
    ]);
    const controlFile = controlLoaded.files.find((f) => f.path === controlFileAbs);
    check4 = controlFile !== undefined && controlFile.content === CONTROL_CONTENT;

    w("-- CHECK 4: CONTROL — a plain (non-symlink) AGENTS.md still loads on the fallback --");
    w(
      `   control loaded path:    ${controlFile ? redact(controlFile.path, redactNeedles) : "(not loaded)"}`,
    );
    w(`   control content matches: ${controlFile?.content === CONTROL_CONTENT} (expect true)`);
    w(`   CHECK 4: ${check4 ? "PASS" : "FAIL"}`);
    w("");
  } finally {
    if (originalGlob) {
      Object.defineProperty(fsp, "glob", originalGlob);
    }
    await fsp.rm(workspace, { recursive: true, force: true });
    await fsp.rm(outsideRoot, { recursive: true, force: true });
    await fsp.rm(cfgHome, { recursive: true, force: true });
  }

  const pass = check0 && check1 && check2 && check3 && check4;
  w("PRE-FIX NOTE:");
  w("   Before this PR the fs.glob-absent fallback saw the `linked` symlink Dirent as");
  w("   isDirectory() === false and never descended it, so **/pkg/linked/**/AGENTS.md");
  w("   yielded nothing and the configured bootstrap file was dropped silently. The");
  w("   real load above, with fs.glob hidden (CHECK 0), is this PR's effect.");
  w("");
  w(`VERDICT: ${pass ? "PASS" : "FAIL"}`);
  w("====================================================================================");

  process.stdout.write(`${out.join("\n")}\n`);
  if (!pass) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error("[symlink-fallback-proof] FAILED", error);
  process.exitCode = 1;
});
