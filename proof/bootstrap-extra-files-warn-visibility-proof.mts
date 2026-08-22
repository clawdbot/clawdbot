/**
 * Combined operator-visibility proof for PR #89040's two default-visible warn fixes.
 *
 * Both halves run through the REAL subsystem logger, at the REAL resolved default
 * console level (info — no debug flag, no LOG_LEVEL override, logger NOT mocked),
 * and capture what an operator's terminal would actually print. A unit test that
 * mocks the logger cannot prove this: the mock never touches the level gate
 * (levelToMinLevel in src/logging/levels.ts; shouldLogToConsole in
 * src/logging/subsystem.ts), and that gate is exactly what makes each fix real —
 * a `warn` (min 4) clears the default `info` (min 3) console floor and prints,
 * while a `debug` (min 2) is below it and stays invisible.
 *
 * PART A — bootstrap-extra-files resolution warn (src/hooks/bundled/bootstrap-extra-files/handler.ts):
 *   A genuine non-ENOENT glob fault (the same EACCES injection handler.test.ts:167
 *   uses) makes resolveExtraBootstrapPatternPaths rethrow -> the loader records an
 *   `io` diagnostic -> the handler routes io/security to log.warn. Proven visible at
 *   the default info level; benign "missing" skips stay at log.debug and stay hidden.
 *   This also exercises the non-ENOENT matched-path propagation in
 *   src/agents/workspace-extra-bootstrap-walker.ts (throw error -> outer catch ->
 *   loader io diagnostic).
 *
 * PART B — slow bootstrap-context substage breakdown (src/agents/embedded-agent-runner/run/attempt-bootstrap-prepare.ts):
 *   When bootstrap-context assembly exceeds 2000ms the runner now emits the
 *   per-substage breakdown at log.warn (previously log.debug — invisible at the
 *   default info level, so a multi-second stall left no operator trace). This half
 *   drives the REAL prepareEmbeddedAttemptBootstrap over a large on-disk workspace,
 *   with the bundled bootstrap-extra-files hook registered exactly as production
 *   registers it, and REAL time from REAL fs.glob work — no performance.now mock.
 *   Real slowness is produced by a large workspace plus several broad `**` glob
 *   patterns (each a full-tree walk; a legitimate multi-pattern operator config),
 *   so the `hook-overrides` substage alone clears 2s. The captured warn line's
 *   totalMs is the production number the changed code measured, not a harness timer.
 *   A fast control run over a tiny workspace stays under 2s and emits NO such line,
 *   proving the warn is gated on genuine slowness, not always emitted.
 *
 * DEFAULT LEVEL: the console level is left to resolve naturally to `info`
 *   (src/logging/console.ts normalizeConsoleLevel default) via a hermetic env
 *   (isolated OPENCLAW_HOME, nonexistent config path, no verbose, no LOG_LEVEL).
 *   The header prints the resolved level so the artifact shows it was info.
 *
 * Run: NO_COLOR=1 node --import tsx proof/bootstrap-extra-files-warn-visibility-proof.mts
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { prepareEmbeddedAttemptBootstrap } from "../src/agents/embedded-agent-runner/run/attempt-bootstrap-prepare.js";
import type { EmbeddedRunAttemptParams } from "../src/agents/embedded-agent-runner/run/types.js";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";
import bootstrapExtraFilesHook from "../src/hooks/bundled/bootstrap-extra-files/handler.js";
import type { InternalHookEvent } from "../src/hooks/internal-hook-types.js";
import {
  type AgentBootstrapHookContext,
  createInternalHookEvent,
  registerInternalHook,
  unregisterInternalHook,
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

async function captureConsole(fn: () => Promise<void>): Promise<CapturedLine[]> {
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
    await fn();
  } finally {
    console.log = original.log;
    console.info = original.info;
    console.warn = original.warn;
    console.error = original.error;
  }
  return captured;
}

function findWarns(lines: CapturedLine[]): CapturedLine[] {
  return lines.filter((l) => l.sink === "warn");
}

function redactWorkspace(text: string, workspaces: string[]): string {
  let result = text;
  for (const workspace of workspaces) {
    result = result.split(workspace).join("<workspace>");
  }
  return result;
}

// Force the console settings to re-resolve on the next log so a style/level
// change takes effect. resolveConsoleSettings caches by value in loggingState.
function invalidateConsoleSettingsCache(): void {
  loggingState.cachedConsoleSettings = null;
}

// ===========================================================================
// PART A helpers — bootstrap-extra-files resolution warn.
// ===========================================================================
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

function makeExtraFilesContext(params: {
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

async function captureExtraFilesHook(context: AgentBootstrapHookContext): Promise<CapturedLine[]> {
  return captureConsole(async () => {
    const event = createInternalHookEvent(
      "agent",
      "bootstrap",
      context.sessionKey ?? "agent:main:main",
      context,
    );
    await bootstrapExtraFilesHook(event);
  });
}

// ===========================================================================
// PART B helpers — slow bootstrap-context substage breakdown warn.
// ===========================================================================

// Large on-disk workspace fixture (same shape the event-loop proof builds): many
// nested dirs so a `**` glob walk is genuinely expensive, plus real nested
// AGENTS.md so the `**/AGENTS.md` pattern has matches to resolve and read.
function buildWorkspaceFixture(
  root: string,
  opts: { topDirs: number; subDirs: number; filesPerLeaf: number; agentsEvery: number },
): { dirs: number; files: number; agentsFiles: number } {
  fs.mkdirSync(root, { recursive: true });
  // Root bootstrap files read by the parallel root loader (Promise.all path).
  fs.writeFileSync(path.join(root, "AGENTS.md"), "# Root AGENTS\nWorkspace root policy.\n");
  fs.writeFileSync(path.join(root, "SOUL.md"), "# SOUL\nPersona.\n");
  fs.writeFileSync(path.join(root, "USER.md"), "# USER\nOperator profile.\n");
  fs.writeFileSync(path.join(root, "MEMORY.md"), "# MEMORY\nRoot memory.\n");

  let dirs = 0;
  let files = 0;
  let agentsFiles = 0;
  let leafIndex = 0;
  for (let t = 0; t < opts.topDirs; t += 1) {
    const topDir = path.join(root, `pkg-${t}`);
    fs.mkdirSync(topDir);
    dirs += 1;
    for (let s = 0; s < opts.subDirs; s += 1) {
      const leaf = path.join(topDir, `mod-${s}`);
      fs.mkdirSync(leaf);
      dirs += 1;
      for (let f = 0; f < opts.filesPerLeaf; f += 1) {
        fs.writeFileSync(path.join(leaf, `file-${f}.ts`), `export const v${f} = ${leafIndex};\n`);
        files += 1;
      }
      if (leafIndex % opts.agentsEvery === 0) {
        fs.writeFileSync(
          path.join(leaf, "AGENTS.md"),
          `# AGENTS ${leafIndex}\nSubtree guidance for pkg-${t}/mod-${s}.\n`,
        );
        files += 1;
        agentsFiles += 1;
      }
      leafIndex += 1;
    }
  }
  return { dirs, files, agentsFiles };
}

function makeSlowBootstrapConfig(patterns: string[]): OpenClawConfig {
  return {
    hooks: {
      internal: {
        enabled: true,
        entries: {
          "bootstrap-extra-files": { enabled: true, patterns },
        },
      },
    },
  } as unknown as OpenClawConfig;
}

// Drive the REAL prepareEmbeddedAttemptBootstrap with the bundled extra-files hook
// registered exactly as production registers it (an agent:bootstrap internal hook).
// The minimal attempt only carries the fields the bootstrap path reads; in the
// default `contextInjection: "always"` mode the SQLite session-target probe
// (hasCompletedBootstrapTurn) is never awaited, so no session store is needed —
// the heavy loaders themselves are the same ones the event-loop proof drives
// standalone. The changed >2000ms guard runs against real elapsed time here.
async function runRealBootstrapPrepare(params: {
  workspace: string;
  config: OpenClawConfig;
  runId: string;
  sessionId: string;
}): Promise<void> {
  const handler = async (event: InternalHookEvent): Promise<void> => {
    await bootstrapExtraFilesHook(event);
  };
  registerInternalHook("agent:bootstrap", handler);
  try {
    const attempt = {
      config: params.config,
      sessionKey: "agent:main:main",
      sessionId: params.sessionId,
      runId: params.runId,
      trigger: "user",
      isCanonicalWorkspace: true,
      bootstrapPromptWarningSignaturesSeen: [],
    } as unknown as EmbeddedRunAttemptParams;
    await prepareEmbeddedAttemptBootstrap({
      attempt,
      effectiveWorkspace: params.workspace,
      resolvedWorkspace: params.workspace,
      hasReadTool: true,
      isRawModelRun: false,
      markStage: () => {},
      sessionAgentId: "proof-agent",
      sessionLabel: "agent:main:main",
    });
  } finally {
    unregisterInternalHook("agent:bootstrap", handler);
  }
}

const TRACE_SUBSTAGE_MARKER = "bootstrap-context substages:";

function findTraceSummaryWarn(lines: CapturedLine[]): CapturedLine | undefined {
  return lines.find((l) => l.sink === "warn" && l.text.includes(TRACE_SUBSTAGE_MARKER));
}

function parseTraceTotalMs(text: string): number {
  const match = text.match(/totalMs=([\d.]+)/u);
  return match ? Number(match[1]) : Number.NaN;
}

function parseTraceSubstages(text: string): string {
  const match = text.match(/substages=(\S+)/u);
  return match ? (match[1] ?? "") : "";
}

// ---------------------------------------------------------------------------
// Fixture knobs. Defaults are sized so the real hook-overrides walk clears 2s
// with margin on the reference host; override via env to retune per machine.
// ---------------------------------------------------------------------------
const SLOW_TOP_DIRS = Number(process.env.PROOF_TOP_DIRS ?? 300);
const SLOW_SUB_DIRS = Number(process.env.PROOF_SUB_DIRS ?? 120);
const SLOW_FILES_PER_LEAF = Number(process.env.PROOF_FILES_PER_LEAF ?? 2);
const SLOW_AGENTS_EVERY = Number(process.env.PROOF_AGENTS_EVERY ?? 60);
// One real pattern (has matches, exercises resolve+read) plus several broad
// globstar patterns that walk the whole tree and match nothing (pure readdir
// cost, no file reads). Multiple configured extra-bootstrap patterns is a real
// operator configuration; together they push hook-overrides past 2s honestly.
const SLOW_PATTERNS = [
  "**/AGENTS.md",
  "**/__deep_scan_a__.md",
  "**/__deep_scan_b__.md",
  "**/__deep_scan_c__.md",
];

async function main(): Promise<void> {
  const headSha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();

  // --- Hermetic default environment: no verbose, no env level override, an
  // isolated (nonexistent) config path so readLoggingConfig returns undefined and
  // the console level resolves to its genuine `info` default. Isolated
  // OPENCLAW_HOME keeps the state DB out of the operator's real state dir.
  // NO_COLOR keeps the captured transcript plain and copy-pasteable.
  const tmpBase = await fsp.realpath(os.tmpdir());
  const cfgHome = fs.mkdtempSync(path.join(tmpBase, "openclaw-warnproof-home-"));
  process.env.NO_COLOR = "1";
  delete process.env.FORCE_COLOR;
  delete process.env.OPENCLAW_LOG_LEVEL;
  delete process.env.VITEST;
  process.env.OPENCLAW_HOME = cfgHome;
  process.env.OPENCLAW_STATE_DIR = path.join(cfgHome, "state");
  process.env.OPENCLAW_CONFIG_PATH = path.join(cfgHome, "no-such-openclaw.json");
  loggingState.overrideSettings = null;
  invalidateConsoleSettingsCache();

  const redactPaths: string[] = [];
  const out: string[] = [];
  const w = (line = "") => out.push(line);

  const resolvedLevel = getConsoleSettings().level;

  w(
    "================ PR #89040 bootstrap default-visibility proof (extra-files warn + slow-bootstrap summary) ================",
  );
  w(`head:            ${headSha} (exact current HEAD)`);
  w(`node:            ${process.version}`);
  w(`os/arch:         ${os.type()} ${os.release()} ${process.arch}`);
  w(`workspace:       <workspace> (temp, redacted)`);
  w("logger:          REAL createSubsystemLogger (NOT mocked)");
  w(`console level:   ${resolvedLevel}  (resolved default; NOT forced to debug)`);
  w(
    `level gate:      warn=min${levelToMinLevel("warn")} >= console-floor info=min${levelToMinLevel("info")} -> VISIBLE;  ` +
      `debug=min${levelToMinLevel("debug")} < info=min${levelToMinLevel("info")} -> HIDDEN`,
  );
  w("");

  if (resolvedLevel !== "info") {
    w(`ABORT: expected default console level 'info', resolved '${resolvedLevel}'.`);
    process.stdout.write(`${out.join("\n")}\n`);
    process.exitCode = 1;
    return;
  }

  // =========================================================================
  // PART A — bootstrap-extra-files resolution warn visibility.
  // =========================================================================
  const wsA = fs.mkdtempSync(path.join(tmpBase, "openclaw-warnproof-wsA-"));
  redactPaths.push(wsA);
  const rootAgentsA = path.join(wsA, "AGENTS.md");
  fs.writeFileSync(rootAgentsA, "# Root AGENTS\nWorkspace policy.\n");
  const extraDir = path.join(wsA, "packages", "core");
  fs.mkdirSync(extraDir, { recursive: true });
  fs.writeFileSync(path.join(extraDir, "AGENTS.md"), "# extra agents\n");

  const realGlob = fsp.glob;
  const throwingGlob = (() => {
    throw Object.assign(new Error("permission denied"), { code: "EACCES" });
  }) as typeof fsp.glob;

  let injectedWarnCompact: CapturedLine[] = [];
  let injectedLinesJson: CapturedLine[] = [];
  let benignInfoLines: CapturedLine[] = [];
  let benignDebugLines: CapturedLine[] = [];
  let extraLeakedAfterFault = false;

  try {
    // CASE 1 — injected io fault, DEFAULT compact style, DEFAULT info level.
    loggingState.overrideSettings = null;
    invalidateConsoleSettingsCache();
    // @ts-expect-error -- deliberately override the writable node:fs/promises glob
    fsp.glob = throwingGlob;
    {
      const cfg = makeExtraFilesConfig(["packages/*/AGENTS.md"]);
      const ctx = makeExtraFilesContext({
        workspaceDir: wsA,
        cfg,
        rootAgentsPath: rootAgentsA,
        rootAgentsContent: "# Root AGENTS\nWorkspace policy.\n",
      });
      const lines = await captureExtraFilesHook(ctx);
      injectedWarnCompact = findWarns(lines);
      extraLeakedAfterFault = ctx.bootstrapFiles.some(
        (f) => path.relative(wsA, f.path) === path.join("packages", "core", "AGENTS.md"),
      );
    }

    // CASE 2 — same injected io fault, JSON console style, still DEFAULT info level.
    loggingState.overrideSettings = {
      consoleStyle: "json",
    } as typeof loggingState.overrideSettings;
    invalidateConsoleSettingsCache();
    if (getConsoleSettings().level !== "info") {
      throw new Error("json-style run drifted off the default info level");
    }
    {
      const cfg = makeExtraFilesConfig(["packages/*/AGENTS.md"]);
      const ctx = makeExtraFilesContext({
        workspaceDir: wsA,
        cfg,
        rootAgentsPath: rootAgentsA,
        rootAgentsContent: "# Root AGENTS\nWorkspace policy.\n",
      });
      injectedLinesJson = await captureExtraFilesHook(ctx);
    }
  } finally {
    fsp.glob = realGlob;
  }

  // CASE 3 — benign "missing" optional literal, JSON style, DEFAULT info level.
  loggingState.overrideSettings = { consoleStyle: "json" } as typeof loggingState.overrideSettings;
  invalidateConsoleSettingsCache();
  {
    const cfg = makeExtraFilesConfig(["does-not-exist/AGENTS.md"]);
    const ctx = makeExtraFilesContext({
      workspaceDir: wsA,
      cfg,
      rootAgentsPath: rootAgentsA,
      rootAgentsContent: "# Root AGENTS\nWorkspace policy.\n",
    });
    benignInfoLines = await captureExtraFilesHook(ctx);
  }

  // CASE 4 — CONTRAST ONLY: benign missing path, console level raised to debug.
  loggingState.overrideSettings = {
    consoleLevel: "debug",
    consoleStyle: "json",
  } as typeof loggingState.overrideSettings;
  invalidateConsoleSettingsCache();
  {
    const cfg = makeExtraFilesConfig(["does-not-exist/AGENTS.md"]);
    const ctx = makeExtraFilesContext({
      workspaceDir: wsA,
      cfg,
      rootAgentsPath: rootAgentsA,
      rootAgentsContent: "# Root AGENTS\nWorkspace policy.\n",
    });
    benignDebugLines = await captureExtraFilesHook(ctx);
  }

  // Restore defaults before PART B.
  loggingState.overrideSettings = null;
  invalidateConsoleSettingsCache();
  await fsp.rm(wsA, { recursive: true, force: true });

  // =========================================================================
  // PART B — slow bootstrap-context substage breakdown warn visibility.
  // =========================================================================
  process.stderr.write("[part B] building large workspace fixture ...\n");
  const slowWs = fs.mkdtempSync(path.join(tmpBase, "openclaw-warnproof-slow-"));
  redactPaths.push(slowWs);
  const fastWs = fs.mkdtempSync(path.join(tmpBase, "openclaw-warnproof-fast-"));
  redactPaths.push(fastWs);
  const warmupWs = fs.mkdtempSync(path.join(tmpBase, "openclaw-warnproof-warmup-"));
  redactPaths.push(warmupWs);

  const fixtureBuildStart = performance.now();
  const fixture = buildWorkspaceFixture(slowWs, {
    topDirs: SLOW_TOP_DIRS,
    subDirs: SLOW_SUB_DIRS,
    filesPerLeaf: SLOW_FILES_PER_LEAF,
    agentsEvery: SLOW_AGENTS_EVERY,
  });
  const fixtureBuildMs = performance.now() - fixtureBuildStart;
  // Tiny fast-control workspace: a single trivial pattern that resolves instantly.
  fs.writeFileSync(path.join(fastWs, "AGENTS.md"), "# Root AGENTS\nTiny workspace.\n");
  fs.writeFileSync(path.join(warmupWs, "AGENTS.md"), "# warmup\n");
  process.stderr.write(
    `[part B] fixture built: ${fixture.dirs} dirs, ${fixture.files} files, ${fixture.agentsFiles} AGENTS.md (${fixtureBuildMs.toFixed(0)}ms)\n`,
  );

  let slowCapture: CapturedLine[] = [];
  let fastCapture: CapturedLine[] = [];
  let slowWallMs = 0;
  let fastWallMs = 0;
  try {
    // Warmup (uncaptured): prime the state-DB open/integrity check and module JIT
    // so their one-time console notices land outside the measured captures.
    await runRealBootstrapPrepare({
      workspace: warmupWs,
      config: makeSlowBootstrapConfig(["**/AGENTS.md"]),
      runId: "proof-warmup",
      sessionId: "proof-warmup",
    });

    // Fast control: tiny workspace, single cheap pattern -> under 2s -> no trace warn.
    process.stderr.write("[part B] fast control run ...\n");
    const fastConfig = makeSlowBootstrapConfig(["**/AGENTS.md"]);
    const fastStart = performance.now();
    fastCapture = await captureConsole(async () => {
      await runRealBootstrapPrepare({
        workspace: fastWs,
        config: fastConfig,
        runId: "proof-fast",
        sessionId: "proof-fast",
      });
    });
    fastWallMs = performance.now() - fastStart;

    // Headline: large workspace + broad patterns -> real >2s -> trace warn visible.
    process.stderr.write("[part B] slow headline run (real fs.glob work) ...\n");
    const slowConfig = makeSlowBootstrapConfig(SLOW_PATTERNS);
    const slowStart = performance.now();
    slowCapture = await captureConsole(async () => {
      await runRealBootstrapPrepare({
        workspace: slowWs,
        config: slowConfig,
        runId: "proof-slow",
        sessionId: "proof-slow",
      });
    });
    slowWallMs = performance.now() - slowStart;
  } finally {
    await fsp.rm(slowWs, { recursive: true, force: true });
    await fsp.rm(fastWs, { recursive: true, force: true });
    await fsp.rm(warmupWs, { recursive: true, force: true });
    await fsp.rm(cfgHome, { recursive: true, force: true });
  }

  const slowTraceWarn = findTraceSummaryWarn(slowCapture);
  const slowTotalMs = slowTraceWarn ? parseTraceTotalMs(slowTraceWarn.text) : Number.NaN;
  const slowSubstages = slowTraceWarn ? parseTraceSubstages(slowTraceWarn.text) : "";
  const fastTraceWarn = findTraceSummaryWarn(fastCapture);

  // ---------------------------------------------------------------- report A
  w(
    "############################## PART A — extra-files resolution warn ##############################",
  );
  w(
    "driven fn:       bootstrapExtraFilesHook (REAL default export) -> loadExtraBootstrapFilesWithDiagnostics",
  );
  w("fault inject:    node:fs/promises glob -> throw EACCES (same as handler.test.ts:167)");
  w(
    "also exercises:  workspace-extra-bootstrap-walker.ts non-ENOENT propagation -> loader io diagnostic",
  );
  w("");

  w("-- CASE 1: injected io fault, DEFAULT compact style, DEFAULT info level --");
  w("   (what a fully-default operator terminal prints)");
  if (injectedWarnCompact.length > 0) {
    for (const line of injectedWarnCompact) {
      w(`   WARN VISIBLE >>> ${redactWorkspace(line.text, redactPaths)}`);
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
      w(`   WARN VISIBLE >>> ${redactWorkspace(line.text, redactPaths)}`);
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
          `paths=[${(parsed.paths ?? []).map((p) => redactWorkspace(p, redactPaths)).join(", ")}] ` +
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
      w(`   DEBUG (only visible at debug) >>> ${redactWorkspace(line.text, redactPaths)}`);
    }
  } else {
    w("   (no debug line captured at debug level — unexpected)");
  }
  w(
    `   warn lines even at debug level:  ${findWarns(benignDebugLines).length} (expect 0 — never over-warns)`,
  );
  w("");

  // ---------------------------------------------------------------- report B
  w(
    "############################## PART B — slow bootstrap-context summary ##############################",
  );
  w(
    "driven fn:       prepareEmbeddedAttemptBootstrap (REAL) -> resolveBootstrapFilesForRunWithTiming + buildBootstrapContextForFiles",
  );
  w("logger:          REAL createSubsystemLogger('agent/embedded') (NOT mocked)");
  w("slow source:     REAL fs.glob over a large workspace; NO performance.now mock");
  w(
    `fixture:         ${fixture.dirs.toLocaleString()} dirs, ${fixture.files.toLocaleString()} files, ${fixture.agentsFiles.toLocaleString()} nested AGENTS.md (build ${fixtureBuildMs.toFixed(0)}ms)`,
  );
  w(`patterns:        ${SLOW_PATTERNS.join("  ")}`);
  w(
    "                 (1 real match pattern + broad globstar walks; a real multi-pattern operator config)",
  );
  w(
    "threshold:       attempt-bootstrap-prepare.ts emits the substage breakdown at log.warn when totalMs > 2000",
  );
  w("");

  w("-- CASE 5: genuinely slow assembly (>2000ms), DEFAULT compact style, DEFAULT info level --");
  w(
    "   (the changed log.warn; totalMs below is the PRODUCTION number the code measured, not a harness timer)",
  );
  if (slowTraceWarn) {
    w(`   WARN VISIBLE >>> ${redactWorkspace(slowTraceWarn.text, redactPaths)}`);
    w(
      `   parsed -> sink=${slowTraceWarn.sink} totalMs=${Number.isFinite(slowTotalMs) ? slowTotalMs.toFixed(1) : "NaN"} substages=${slowSubstages}`,
    );
  } else {
    w("   (no bootstrap-context substage warn captured — FAIL)");
  }
  // Surface every other captured line honestly (e.g. the dispatcher's own "Slow
  // hook handler" warn, which is real corroborating slowness evidence, and any
  // one-time state/db notice) so the transcript is not cherry-picked.
  const slowOtherLines = slowCapture.filter((l) => l !== slowTraceWarn);
  w(`   wall-clock around the real call:   ${slowWallMs.toFixed(1)}ms`);
  w(`   other console lines during run:    ${slowOtherLines.length}`);
  for (const line of slowOtherLines) {
    w(`     [${line.sink}] ${redactWorkspace(line.text, redactPaths)}`);
  }
  w("");

  w("-- CASE 6: FAST CONTROL — tiny workspace, single cheap pattern, DEFAULT info level --");
  w(
    "   (assembly stays under 2000ms -> NO substage warn -> proves the warn is gated on real slowness)",
  );
  w(`   wall-clock around the real call:   ${fastWallMs.toFixed(1)}ms`);
  w(`   bootstrap-context substage warns:  ${fastTraceWarn ? 1 : 0} (expect 0)`);
  w(`   total console lines captured:      ${fastCapture.length}`);
  for (const line of fastCapture) {
    w(`     [${line.sink}] ${redactWorkspace(line.text, redactPaths)}`);
  }
  w("");

  // ------------------------------------------------------------------ verdict
  const warnVisibleAtInfo = injectedWarnCompact.length === 1 && jsonWarns.length === 1;
  const noWarnOnBenign =
    findWarns(benignInfoLines).length === 0 &&
    benignInfoLines.length === 0 &&
    findWarns(benignDebugLines).length === 0;
  const benignExistsAsDebug = benignDebug.length === 1;

  const slowWarnVisible = Boolean(slowTraceWarn) && slowTraceWarn?.sink === "warn";
  const slowOverThreshold = Number.isFinite(slowTotalMs) && slowTotalMs > 2_000;
  const slowHasSubstages =
    slowSubstages.length > 0 &&
    slowSubstages !== "none" &&
    slowSubstages.includes("hook-overrides") &&
    slowSubstages.includes("automatic-memory-provenance");
  const fastStaysSilent = !fastTraceWarn;

  const partAPass =
    warnVisibleAtInfo &&
    jsonFieldsOk &&
    !extraLeakedAfterFault &&
    noWarnOnBenign &&
    benignExistsAsDebug;
  const partBPass = slowWarnVisible && slowOverThreshold && slowHasSubstages && fastStaysSilent;
  const pass = partAPass && partBPass;

  w("PRE-FIX CONTRAST NOTE:");
  w(
    "   Both diagnostics previously used log.debug, so at the default info console level an operator",
  );
  w(
    "   saw NOTHING — a silently dropped bootstrap file (PART A) and a multi-second bootstrap-context",
  );
  w("   stall with no trace (PART B). The visible warn lines above are this PR's effect.");
  w("");
  w("-- PART A (extra-files resolution warn) --");
  w(`  fault warn visible at DEFAULT info level:        ${warnVisibleAtInfo ? "YES" : "NO"}`);
  w(`  structured fields present (io/paths/hint):       ${jsonFieldsOk ? "YES" : "NO"}`);
  w(`  faulted files kept OUT of bootstrap set:         ${!extraLeakedAfterFault ? "YES" : "NO"}`);
  w(`  benign skip stays silent at info (no over-warn): ${noWarnOnBenign ? "YES" : "NO"}`);
  w(`  benign diagnostic exists as debug-only:          ${benignExistsAsDebug ? "YES" : "NO"}`);
  w(`  PART A:                                          ${partAPass ? "PASS" : "FAIL"}`);
  w("-- PART B (slow bootstrap-context summary warn) --");
  w(
    `  real assembly exceeded 2000ms (production totalMs): ${slowOverThreshold ? `YES (${slowTotalMs.toFixed(1)}ms)` : "NO"}`,
  );
  w(`  substage breakdown warn visible at DEFAULT info:    ${slowWarnVisible ? "YES" : "NO"}`);
  w(
    `  breakdown names substages incl. hook-overrides + provenance: ${slowHasSubstages ? "YES" : "NO"}`,
  );
  w(`  fast run (<2s) stays silent (gated on slowness):    ${fastStaysSilent ? "YES" : "NO"}`);
  w(`  PART B:                                             ${partBPass ? "PASS" : "FAIL"}`);
  w("");
  w(`VERDICT:                                             ${pass ? "PASS" : "FAIL"}`);
  w(
    "==================================================================================================",
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
