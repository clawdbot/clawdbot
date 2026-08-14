/**
 * Operator-visibility proof for the bootstrap-extra-files warn fix (PR #89040).
 *
 * WHAT THIS PROVES (and why the unit test does NOT):
 *   handler.test.ts MOCKS the subsystem logger (vi.mock("../../../logging/subsystem.js")),
 *   so it only asserts that log.warn() was *called* with the right fields. It cannot
 *   prove an operator running at the DEFAULT console level actually SEES that line —
 *   the mock never touches the real level gate. That gate (levelToMinLevel in
 *   src/logging/levels.ts; shouldLogToConsole in src/logging/subsystem.ts) is exactly
 *   what makes the fix real: a `warn` (min 4) clears the default `info` (min 3) console
 *   floor and prints, while a `debug` (min 2) is below it and stays invisible.
 *
 *   This harness drives the REAL exported default handler
 *   (src/hooks/bundled/bootstrap-extra-files/handler.ts) through the REAL logger
 *   (no logger mock), at the REAL default console level (info, not forced to debug),
 *   injects a genuine non-ENOENT glob fault the same way the test does (throwing
 *   node:fs/promises glob -> loadExtraBootstrapFilesWithDiagnostics -> "io" diagnostic),
 *   and captures what the subsystem logger writes to the console sink. The captured
 *   warn line IS the operator-visible artifact.
 *
 * FAULT INJECTION: identical mechanism to handler.test.ts:167 — replace
 *   node:fs/promises `glob` with a thrower carrying code "EACCES". fs.glob normally
 *   walks past per-entry read errors, so a top-level throw means the whole pattern
 *   failed; resolveExtraBootstrapPatternPaths rethrows every non-ENOENT error and the
 *   loader records it as reason "io". The handler routes io/security diagnostics to
 *   log.warn and benign (missing) diagnostics to log.debug.
 *
 * DEFAULT LEVEL: the console level is left to resolve naturally to `info`
 *   (src/logging/console.ts normalizeConsoleLevel default). We never set verbose and
 *   never force debug for the two headline runs; the header prints the resolved level
 *   so the artifact shows it was info. A separate, clearly-labelled contrast run raises
 *   the level to debug ONLY to show the benign diagnostic exists but is debug-only.
 *
 * Run: NO_COLOR=1 node --import tsx proof/bootstrap-extra-files-warn-visibility-proof.mts
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";
import bootstrapExtraFilesHook from "../src/hooks/bundled/bootstrap-extra-files/handler.js";
import {
  type AgentBootstrapHookContext,
  createInternalHookEvent,
} from "../src/hooks/internal-hooks.js";
import { getConsoleSettings } from "../src/logging/console.js";
import { levelToMinLevel } from "../src/logging/levels.js";
import { loggingState } from "../src/logging/state.js";

// ---------------------------------------------------------------------------
// Captured console sink. writeConsoleLine() in subsystem.ts writes through
// `loggingState.rawConsole ?? console`; we never enableConsoleCapture(), so it
// falls through to the global console. Swapping the global console methods
// records exactly what an operator's terminal would show, per level.
// ---------------------------------------------------------------------------
type CapturedLine = { sink: "log" | "warn" | "error"; text: string };

async function captureHandlerConsole(context: AgentBootstrapHookContext): Promise<CapturedLine[]> {
  const captured: CapturedLine[] = [];
  const original = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
  };
  // writeConsoleLine passes a single already-formatted string per call.
  console.log = (...args: unknown[]) => captured.push({ sink: "log", text: String(args[0] ?? "") });
  console.info = console.log;
  console.warn = (...args: unknown[]) =>
    captured.push({ sink: "warn", text: String(args[0] ?? "") });
  console.error = (...args: unknown[]) =>
    captured.push({ sink: "error", text: String(args[0] ?? "") });
  try {
    const event = createInternalHookEvent(
      "agent",
      "bootstrap",
      context.sessionKey ?? "agent:main:main",
      context,
    );
    await bootstrapExtraFilesHook(event);
  } finally {
    console.log = original.log;
    console.info = original.info;
    console.warn = original.warn;
    console.error = original.error;
  }
  return captured;
}

function makeConfig(paths: string[]): OpenClawConfig {
  return {
    hooks: {
      internal: {
        entries: {
          "bootstrap-extra-files": { enabled: true, paths },
        },
      },
    },
  } as OpenClawConfig;
}

function makeContext(params: {
  workspaceDir: string;
  cfg: OpenClawConfig;
  rootAgentsPath: string;
  rootAgentsContent: string;
}): AgentBootstrapHookContext {
  const bootstrapFiles = [
    {
      name: "AGENTS.md",
      path: params.rootAgentsPath,
      content: params.rootAgentsContent,
      missing: false,
    },
  ] as AgentBootstrapHookContext["bootstrapFiles"];
  return {
    workspaceDir: params.workspaceDir,
    bootstrapFiles,
    cfg: params.cfg,
    sessionKey: "agent:main:main",
  };
}

// Force the console settings to re-resolve on the next log so a style/level
// change takes effect. resolveConsoleSettings caches by value in loggingState.
function invalidateConsoleSettingsCache(): void {
  loggingState.cachedConsoleSettings = null;
}

function redactWorkspace(text: string, workspace: string): string {
  return text.split(workspace).join("<workspace>");
}

function findWarns(lines: CapturedLine[]): CapturedLine[] {
  return lines.filter((l) => l.sink === "warn");
}

async function main(): Promise<void> {
  const headSha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();

  // --- Hermetic default environment: no verbose, no env level override, an
  // isolated (nonexistent) config path so readLoggingConfig returns undefined and
  // the console level resolves to its genuine `info` default. NO_COLOR keeps the
  // captured transcript plain and copy-pasteable.
  const tmpBase = await fsp.realpath(os.tmpdir());
  const cfgHome = fs.mkdtempSync(path.join(tmpBase, "openclaw-warnproof-home-"));
  process.env.NO_COLOR = "1";
  delete process.env.FORCE_COLOR;
  delete process.env.OPENCLAW_LOG_LEVEL;
  delete process.env.VITEST;
  process.env.OPENCLAW_HOME = cfgHome;
  process.env.OPENCLAW_CONFIG_PATH = path.join(cfgHome, "no-such-openclaw.json");
  loggingState.overrideSettings = null;
  invalidateConsoleSettingsCache();

  const workspace = fs.mkdtempSync(path.join(tmpBase, "openclaw-warnproof-ws-"));
  const rootAgents = path.join(workspace, "AGENTS.md");
  fs.writeFileSync(rootAgents, "# Root AGENTS\nWorkspace policy.\n");
  // A real extra file the glob WOULD inject if resolution succeeded — its absence
  // from the bootstrap set after a fault is the operator-visible correctness half.
  const extraDir = path.join(workspace, "packages", "core");
  fs.mkdirSync(extraDir, { recursive: true });
  fs.writeFileSync(path.join(extraDir, "AGENTS.md"), "# extra agents\n");

  const resolvedLevel = getConsoleSettings().level;
  const out: string[] = [];
  const w = (line = "") => out.push(line);

  w(
    "================ PR #89040 bootstrap-extra-files WARN operator-visibility proof ================",
  );
  w(`head:            ${headSha} (exact current HEAD)`);
  w(`node:            ${process.version}`);
  w(`os/arch:         ${os.type()} ${os.release()} ${process.arch}`);
  w(`workspace:       <workspace> (temp, redacted)`);
  w(
    "driven fn:       bootstrapExtraFilesHook (REAL default export) -> loadExtraBootstrapFilesWithDiagnostics",
  );
  w("logger:          REAL createSubsystemLogger('bootstrap-extra-files') (NOT mocked)");
  w(`console level:   ${resolvedLevel}  (resolved default; NOT forced to debug)`);
  w(
    `level gate:      warn=min${levelToMinLevel("warn")} >= console-floor info=min${levelToMinLevel("info")} -> VISIBLE;  ` +
      `debug=min${levelToMinLevel("debug")} < info=min${levelToMinLevel("info")} -> HIDDEN`,
  );
  w("fault inject:    node:fs/promises glob -> throw EACCES (same as handler.test.ts:167)");
  w("");

  if (resolvedLevel !== "info") {
    w(`ABORT: expected default console level 'info', resolved '${resolvedLevel}'.`);
    process.stdout.write(`${out.join("\n")}\n`);
    process.exitCode = 1;
    return;
  }

  // --- Save the real glob so every run restores it. ---
  const realGlob = fsp.glob;
  // A non-ENOENT top-level glob failure is a genuine fault (fs.glob normally
  // skips unreadable entries, so a throw means the whole pattern failed).
  const throwingGlob = (() => {
    throw Object.assign(new Error("permission denied"), { code: "EACCES" });
  }) as typeof fsp.glob;

  let injectedWarnCompact: CapturedLine[] = [];
  let injectedLinesJson: CapturedLine[] = [];
  let benignInfoLines: CapturedLine[] = [];
  let benignDebugLines: CapturedLine[] = [];
  let extraLeakedAfterFault = false;

  try {
    // =====================================================================
    // CASE 1 — injected io fault, DEFAULT compact style, DEFAULT info level.
    // This is what a fully-default operator terminal shows. The warn line has
    // no rendered meta in compact style (meta goes to the file log), but its
    // visibility at info is the headline claim.
    // =====================================================================
    loggingState.overrideSettings = null;
    invalidateConsoleSettingsCache();
    // @ts-expect-error -- deliberately override the writable node:fs/promises glob
    fsp.glob = throwingGlob;
    {
      const cfg = makeConfig(["packages/*/AGENTS.md"]);
      const ctx = makeContext({
        workspaceDir: workspace,
        cfg,
        rootAgentsPath: rootAgents,
        rootAgentsContent: "# Root AGENTS\nWorkspace policy.\n",
      });
      const lines = await captureHandlerConsole(ctx);
      injectedWarnCompact = findWarns(lines);
      // The failed pattern's files must not leak into the bootstrap set.
      extraLeakedAfterFault = ctx.bootstrapFiles.some(
        (f) => path.relative(workspace, f.path) === path.join("packages", "core", "AGENTS.md"),
      );
    }

    // =====================================================================
    // CASE 2 — same injected io fault, JSON console style, still DEFAULT info
    // level. JSON style renders the structured meta, so the operator line shows
    // failed count, reasons {io,security}, offending paths, and the hint.
    // consoleLevel is left unset in the override -> still resolves to info.
    // =====================================================================
    loggingState.overrideSettings = {
      consoleStyle: "json",
    } as typeof loggingState.overrideSettings;
    invalidateConsoleSettingsCache();
    if (getConsoleSettings().level !== "info") {
      throw new Error("json-style run drifted off the default info level");
    }
    {
      const cfg = makeConfig(["packages/*/AGENTS.md"]);
      const ctx = makeContext({
        workspaceDir: workspace,
        cfg,
        rootAgentsPath: rootAgents,
        rootAgentsContent: "# Root AGENTS\nWorkspace policy.\n",
      });
      injectedLinesJson = await captureHandlerConsole(ctx);
    }
  } finally {
    // Restore glob before the benign runs so real resolution happens.
    fsp.glob = realGlob;
  }

  // =====================================================================
  // CASE 3 — benign "missing" optional literal, JSON style, DEFAULT info.
  // A configured-but-absent path is normal noise, routed to log.debug. At the
  // default info floor the operator sees NOTHING — proving the fix does not
  // over-warn on ordinary skips.
  // =====================================================================
  loggingState.overrideSettings = { consoleStyle: "json" } as typeof loggingState.overrideSettings;
  invalidateConsoleSettingsCache();
  {
    const cfg = makeConfig(["does-not-exist/AGENTS.md"]);
    const ctx = makeContext({
      workspaceDir: workspace,
      cfg,
      rootAgentsPath: rootAgents,
      rootAgentsContent: "# Root AGENTS\nWorkspace policy.\n",
    });
    benignInfoLines = await captureHandlerConsole(ctx);
  }

  // =====================================================================
  // CASE 4 — CONTRAST ONLY (NOT the default): same benign missing path, but
  // console level raised to debug. This shows the benign diagnostic genuinely
  // EXISTS (reason {missing:1}) and would surface a debug line — which the info
  // default hides. It is the negative control for the level split.
  // =====================================================================
  loggingState.overrideSettings = {
    consoleLevel: "debug",
    consoleStyle: "json",
  } as typeof loggingState.overrideSettings;
  invalidateConsoleSettingsCache();
  {
    const cfg = makeConfig(["does-not-exist/AGENTS.md"]);
    const ctx = makeContext({
      workspaceDir: workspace,
      cfg,
      rootAgentsPath: rootAgents,
      rootAgentsContent: "# Root AGENTS\nWorkspace policy.\n",
    });
    benignDebugLines = await captureHandlerConsole(ctx);
  }

  // Restore defaults + clean up.
  loggingState.overrideSettings = null;
  invalidateConsoleSettingsCache();
  await fsp.rm(workspace, { recursive: true, force: true });
  await fsp.rm(cfgHome, { recursive: true, force: true });

  // ------------------------------------------------------------------ report
  w("-- CASE 1: injected io fault, DEFAULT compact style, DEFAULT info level --");
  w("   (what a fully-default operator terminal prints)");
  if (injectedWarnCompact.length > 0) {
    for (const line of injectedWarnCompact) {
      w(`   WARN VISIBLE >>> ${redactWorkspace(line.text, workspace)}`);
    }
  } else {
    w("   (no warn captured — FAIL)");
  }
  w(`   failed-pattern files leaked into bootstrap set: ${extraLeakedAfterFault} (expect false)`);
  w("");

  w("-- CASE 2: same injected io fault, JSON console style, DEFAULT info level --");
  w("   (structured operator line: message + failed count + reasons + paths + hint)");
  const jsonWarns = findWarns(injectedLinesJson);
  let jsonFieldsOk = false;
  if (jsonWarns.length > 0) {
    for (const line of jsonWarns) {
      w(`   WARN VISIBLE >>> ${redactWorkspace(line.text, workspace)}`);
    }
    try {
      const parsed = JSON.parse(jsonWarns[0]?.text ?? "{}") as {
        level?: string;
        message?: string;
        failed?: number;
        reasons?: { io?: number; security?: number };
        paths?: string[];
        hint?: string;
      };
      jsonFieldsOk =
        parsed.level === "warn" &&
        typeof parsed.message === "string" &&
        parsed.message.includes("resolution failed") &&
        parsed.failed === 1 &&
        parsed.reasons?.io === 1 &&
        parsed.reasons?.security === 0 &&
        Array.isArray(parsed.paths) &&
        parsed.paths.length === 1 &&
        typeof parsed.hint === "string" &&
        parsed.hint.length > 0;
      w(
        `   parsed fields -> level=${parsed.level} failed=${parsed.failed} ` +
          `reasons={io:${parsed.reasons?.io},security:${parsed.reasons?.security}} ` +
          `paths=[${(parsed.paths ?? []).map((p) => redactWorkspace(p, workspace)).join(", ")}] ` +
          `hint="${parsed.hint}"`,
      );
    } catch (err) {
      w(`   (warn line was not valid JSON: ${String(err)})`);
    }
  } else {
    w("   (no warn captured — FAIL)");
  }
  w("");

  w("-- CASE 3: benign missing optional path, JSON style, DEFAULT info level --");
  w("   (ordinary skip -> log.debug -> BELOW the info floor -> operator sees nothing)");
  w(`   console lines captured at info: ${benignInfoLines.length} (expect 0)`);
  w(`   of which warn lines:            ${findWarns(benignInfoLines).length} (expect 0)`);
  w("");

  w("-- CASE 4: CONTRAST ONLY (console level raised to debug, NOT the default) --");
  w("   (proves the benign diagnostic exists and is debug-only; hidden at info)");
  const benignDebug = benignDebugLines.filter((l) => l.sink === "log");
  if (benignDebug.length > 0) {
    for (const line of benignDebug) {
      w(`   DEBUG (only visible at debug) >>> ${redactWorkspace(line.text, workspace)}`);
    }
  } else {
    w("   (no debug line captured at debug level — unexpected)");
  }
  w(
    `   warn lines even at debug level:  ${findWarns(benignDebugLines).length} (expect 0 — never over-warns)`,
  );
  w("");

  // ------------------------------------------------------------------ verdict
  const warnVisibleAtInfo = injectedWarnCompact.length === 1 && jsonWarns.length === 1;
  const noWarnOnBenign =
    findWarns(benignInfoLines).length === 0 &&
    benignInfoLines.length === 0 &&
    findWarns(benignDebugLines).length === 0;
  const benignExistsAsDebug = benignDebug.length === 1;
  const pass =
    warnVisibleAtInfo &&
    jsonFieldsOk &&
    !extraLeakedAfterFault &&
    noWarnOnBenign &&
    benignExistsAsDebug;

  w("PRE-FIX CONTRAST NOTE:");
  w("   Before this fix the handler emitted these io/security faults at log.debug, so at");
  w("   the default info console level (Case 1/2) the operator would have seen NOTHING —");
  w("   a silent bootstrap-file drop. The visible warn lines above are the fix's effect.");
  w("");
  w(`fault warn visible at DEFAULT info level:      ${warnVisibleAtInfo ? "YES" : "NO"}`);
  w(`structured fields present (io/paths/hint):     ${jsonFieldsOk ? "YES" : "NO"}`);
  w(`faulted files kept OUT of bootstrap set:       ${!extraLeakedAfterFault ? "YES" : "NO"}`);
  w(`benign skip stays silent at info (no over-warn): ${noWarnOnBenign ? "YES" : "NO"}`);
  w(`benign diagnostic exists as debug-only:        ${benignExistsAsDebug ? "YES" : "NO"}`);
  w(`VERDICT:                                       ${pass ? "PASS" : "FAIL"}`);
  w(
    "==============================================================================================",
  );

  process.stdout.write(`${out.join("\n")}\n`);
  if (!pass) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error("[warn-visibility-proof] FAILED", error);
  process.exitCode = 1;
});
