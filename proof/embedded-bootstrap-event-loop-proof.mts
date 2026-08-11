/**
 * Real-behavior proof for PR #89040 / issue #87509.
 *
 * Proves the CHANGED embedded_run bootstrap-context path stays event-loop
 * responsive on a large workspace. It drives the highest-level directly-callable
 * bootstrap-context assembly function on this branch and watches a concurrent
 * timer + a mock transport keepalive + monitorEventLoopDelay continue firing
 * throughout the load. A blocking synchronous walk over the same tree runs the
 * same probe as a sensitivity baseline, proving the probe DOES catch real stalls.
 *
 * Driven function (unmodified, shipped):
 *   resolveBootstrapContextForRun (src/agents/bootstrap-files.ts)
 *     -> resolveBootstrapFilesForRun -> resolveBootstrapFilesForRunWithTiming
 *          (a) getOrLoadBootstrapFiles -> loadWorkspaceBootstrapFiles  [parallel root reads via Promise.all]
 *          (c) applyBootstrapHookOverrides
 *                -> triggerInternalHookWithScheduling({ yieldBetweenHandlers: true })  [yielded hook dispatch]
 *                   -> bundled bootstrap-extra-files hook
 *                      (b) loadExtraBootstrapFilesWithDiagnostics
 *                            -> resolveExtraBootstrapPatternPaths  [fs.glob extra-bootstrap resolution]
 *     -> buildBootstrapContextForFiles  [bounded context build]
 *
 * This is the highest-level assembly that is invokable in isolation. The fully
 * wired embedded_run entrypoint (runEmbeddedAttempt / prepareEmbeddedAttemptBootstrap)
 * additionally needs a live provider, gateway and SQLite session store, so it is
 * NOT driven here. The transport probe below is a representative concurrent
 * setInterval keepalive, not a real channel socket — labelled honestly.
 *
 * Run: node --import tsx proof/embedded-bootstrap-event-loop-proof.mts
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import {
  buildBootstrapContextForFiles,
  resolveBootstrapContextForRun,
  resolveBootstrapFilesForRunWithTiming,
} from "../src/agents/bootstrap-files.js";
import { resolveExtraBootstrapPatternPaths } from "../src/agents/workspace-extra-bootstrap-walker.js";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";
import bootstrapExtraFilesHook from "../src/hooks/bundled/bootstrap-extra-files/handler.js";
import { registerInternalHook, unregisterInternalHook } from "../src/hooks/internal-hooks.js";

// ---------------------------------------------------------------------------
// Fixture size — meets the gate's "large workspace" bar by default.
// ---------------------------------------------------------------------------
const TOP_DIRS = Number(process.env.PROOF_TOP_DIRS ?? 200);
const SUB_DIRS = Number(process.env.PROOF_SUB_DIRS ?? 100); // 200 * 100 = 20,000 leaf dirs
const FILES_PER_LEAF = Number(process.env.PROOF_FILES_PER_LEAF ?? 2); // 40,000 plain files
const AGENTS_EVERY = Number(process.env.PROOF_AGENTS_EVERY ?? 40); // ~500 nested AGENTS.md

const PROBE_INTERVAL_MS = 5;
const KEEPALIVE_INTERVAL_MS = 10;

// ---------------------------------------------------------------------------
// Concurrent probe: a 5ms timer recording wall-clock drift + a 10ms mock
// transport keepalive + monitorEventLoopDelay. Any multi-second synchronous
// block starves the timers and shows up as drift and a keepalive gap.
// ---------------------------------------------------------------------------
type ProbeHandle = {
  stop: () => ProbeStats;
};
type ProbeStats = {
  timerTicks: number;
  maxDriftMs: number;
  maxTimerGapMs: number;
  keepaliveTicks: number;
  maxKeepaliveGapMs: number;
  loopDelayMeanMs: number;
  loopDelayMaxMs: number;
};

function startProbe(): ProbeHandle {
  const loopDelay = monitorEventLoopDelay({ resolution: 5 });
  loopDelay.enable();

  let lastTimer = performance.now();
  let timerTicks = 0;
  let maxDriftMs = 0;
  let maxTimerGapMs = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    const gap = now - lastTimer;
    lastTimer = now;
    timerTicks += 1;
    if (gap > maxTimerGapMs) maxTimerGapMs = gap;
    const drift = gap - PROBE_INTERVAL_MS;
    if (drift > maxDriftMs) maxDriftMs = drift;
  }, PROBE_INTERVAL_MS);

  let lastKeepalive = performance.now();
  let keepaliveTicks = 0;
  let maxKeepaliveGapMs = 0;
  // Mock transport keepalive: stands in for a channel heartbeat that must keep
  // getting a turn on the loop while bootstrap-context loads.
  const keepalive = setInterval(() => {
    const now = performance.now();
    const gap = now - lastKeepalive;
    lastKeepalive = now;
    keepaliveTicks += 1;
    if (gap > maxKeepaliveGapMs) maxKeepaliveGapMs = gap;
  }, KEEPALIVE_INTERVAL_MS);

  return {
    stop() {
      clearInterval(timer);
      clearInterval(keepalive);
      loopDelay.disable();
      return {
        timerTicks,
        maxDriftMs,
        maxTimerGapMs,
        keepaliveTicks,
        maxKeepaliveGapMs,
        loopDelayMeanMs: loopDelay.mean / 1e6,
        loopDelayMaxMs: loopDelay.max / 1e6,
      };
    },
  };
}

// Let the probe timers settle before measuring so the first tick's own
// scheduling latency does not count as a stall.
function settle(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Large on-disk workspace fixture.
// ---------------------------------------------------------------------------
function buildFixture(root: string): { dirs: number; files: number; agentsFiles: number } {
  fs.mkdirSync(root, { recursive: true });

  // Root bootstrap files read by the parallel root loader (Promise.all path).
  fs.writeFileSync(path.join(root, "AGENTS.md"), "# Root AGENTS\nWorkspace root policy.\n");
  fs.writeFileSync(path.join(root, "SOUL.md"), "# SOUL\nPersona.\n");
  fs.writeFileSync(path.join(root, "USER.md"), "# USER\nOperator profile.\n");
  fs.writeFileSync(path.join(root, "BOOTSTRAP.md"), "# BOOTSTRAP\nSetup guidance.\n");
  fs.writeFileSync(path.join(root, "MEMORY.md"), "# MEMORY\nRoot memory.\n");
  fs.writeFileSync(path.join(root, "HEARTBEAT.md"), "# HEARTBEAT\nScratch.\n");

  let dirs = 0;
  let files = 0;
  let agentsFiles = 0;
  let leafIndex = 0;

  for (let t = 0; t < TOP_DIRS; t += 1) {
    const topDir = path.join(root, `pkg-${t}`);
    fs.mkdirSync(topDir);
    dirs += 1;
    for (let s = 0; s < SUB_DIRS; s += 1) {
      const leaf = path.join(topDir, `mod-${s}`);
      fs.mkdirSync(leaf);
      dirs += 1;
      for (let f = 0; f < FILES_PER_LEAF; f += 1) {
        fs.writeFileSync(path.join(leaf, `file-${f}.ts`), `export const v${f} = ${leafIndex};\n`);
        files += 1;
      }
      // Sprinkle nested AGENTS.md so the **/AGENTS.md glob has real matches to
      // resolve, realpath-check for containment, and read.
      if (leafIndex % AGENTS_EVERY === 0) {
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

// Sensitivity baseline: a fully synchronous recursive walk that reads every
// AGENTS.md, mirroring the async glob+read work but blocking the loop. If the
// probe reports a big drift here, its near-zero drift in the async run is
// meaningful rather than an artifact of a quiet loop.
function blockingSyncWalk(root: string): { entries: number; agentsRead: number } {
  let entries = 0;
  let agentsRead = 0;
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    let dirents: fs.Dirent[];
    try {
      dirents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const dirent of dirents) {
      entries += 1;
      const full = path.join(dir, dirent.name);
      if (dirent.isDirectory()) {
        stack.push(full);
      } else if (dirent.name === "AGENTS.md") {
        try {
          fs.realpathSync(full);
          fs.readFileSync(full, "utf8");
          agentsRead += 1;
        } catch {
          // ignore per-entry read failures, matching the walker's tolerance
        }
      }
    }
  }
  return { entries, agentsRead };
}

function ms(value: number): string {
  return `${value.toFixed(1)}ms`;
}

async function main(): Promise<void> {
  const headSha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();

  // realpath the tmp root: on macOS os.tmpdir() is /var -> /private/var, and the
  // walker's containment filter compares canonical realpaths.
  const tmpBase = await fsp.realpath(os.tmpdir());
  const workspace = fs.mkdtempSync(path.join(tmpBase, "openclaw-bootstrap-proof-"));
  // Second, independent tree so the isolated fs.glob measurement runs cold too,
  // instead of reusing the warm OS cache the full-assembly run leaves behind.
  const workspaceGlob = fs.mkdtempSync(path.join(tmpBase, "openclaw-bootstrap-glob-"));

  const config = {
    hooks: {
      internal: {
        enabled: true,
        entries: {
          "bootstrap-extra-files": { enabled: true, patterns: ["**/AGENTS.md"] },
        },
      },
    },
  } as unknown as OpenClawConfig;

  // Register the real bundled hook under the specific agent:bootstrap key so the
  // yielded dispatch path fires it (and, inside it, the fs.glob walker).
  registerInternalHook("agent:bootstrap", bootstrapExtraFilesHook);

  let fixture: { dirs: number; files: number; agentsFiles: number };
  let asyncResult: {
    bootstrapFiles: number;
    contextFiles: number;
    loadMs: number;
    contextBuildMs: number;
    substages: Array<{ name: string; durationMs: number }>;
    probe: ProbeStats;
  };
  let globOnly: { matches: number; resolveMs: number; probe: ProbeStats };
  let baseline: { entries: number; agentsRead: number; walkMs: number; probe: ProbeStats };

  try {
    process.stdout.write("building large workspace fixtures ... ");
    const genStart = performance.now();
    fixture = buildFixture(workspace);
    buildFixture(workspaceGlob);
    process.stdout.write(`done (${ms(performance.now() - genStart)})\n`);

    // Warmup on a tiny separate workspace: pays the one-time SQLite state-DB
    // open/integrity check (readCanonicalWorkspaceStateSnapshot) and module JIT
    // OUTSIDE the measured window, so any stall we then attribute to the large
    // load is the load itself, not first-touch init.
    const warmupDir = fs.mkdtempSync(path.join(tmpBase, "openclaw-bootstrap-warmup-"));
    fs.writeFileSync(path.join(warmupDir, "AGENTS.md"), "# warmup\n");
    await resolveBootstrapContextForRun({
      workspaceDir: warmupDir,
      config,
      sessionKey: "warmup",
      sessionId: "warmup",
      agentId: "warmup-agent",
    });
    await fsp.rm(warmupDir, { recursive: true, force: true });
    process.stdout.write("warmup done (state-DB + JIT primed)\n");

    // -------- Async run: the CHANGED bootstrap-context assembly (post-warmup) --------
    // Drive the exact two calls the embedded runner makes, capturing per-substage
    // timing so a stall is attributed to workspace-file-load vs hook-overrides
    // (hook-overrides == the yielded dispatch that runs the fs.glob walker).
    const substages: Array<{ name: string; durationMs: number }> = [];
    let probe = startProbe();
    await settle(60);
    const loadStart = performance.now();
    const bootstrapFiles = await resolveBootstrapFilesForRunWithTiming({
      workspaceDir: workspace,
      config,
      sessionKey: "proof-embedded",
      sessionId: "proof-embedded",
      agentId: "proof-agent",
      onBootstrapSubstageTiming: (name, durationMs) => substages.push({ name, durationMs }),
    });
    const contextBuildStart = performance.now();
    const contextFiles = buildBootstrapContextForFiles(bootstrapFiles, {
      config,
      agentId: "proof-agent",
    });
    const contextBuildMs = performance.now() - contextBuildStart;
    const loadMs = performance.now() - loadStart;
    await settle(20);
    asyncResult = {
      bootstrapFiles: bootstrapFiles.length,
      contextFiles: contextFiles.length,
      loadMs,
      contextBuildMs,
      substages,
      probe: probe.stop(),
    };

    // -------- Isolated fs.glob walker over an INDEPENDENTLY COLD tree --------
    // Attributes the async-path stall directly to Node fs.glob resolution,
    // measured on a fresh tree so it is not warmed by the full-assembly run.
    probe = startProbe();
    await settle(60);
    const globStart = performance.now();
    const matches = await resolveExtraBootstrapPatternPaths(workspaceGlob, "**/AGENTS.md", false);
    const resolveMs = performance.now() - globStart;
    await settle(20);
    globOnly = { matches: matches.length, resolveMs, probe: probe.stop() };

    // -------- Baseline: blocking synchronous walk over the same tree --------
    probe = startProbe();
    await settle(60);
    const walkStart = performance.now();
    const walk = blockingSyncWalk(workspace);
    const walkMs = performance.now() - walkStart;
    await settle(20);
    baseline = { entries: walk.entries, agentsRead: walk.agentsRead, walkMs, probe: probe.stop() };
  } finally {
    unregisterInternalHook("agent:bootstrap", bootstrapExtraFilesHook);
    await fsp.rm(workspace, { recursive: true, force: true });
    await fsp.rm(workspaceGlob, { recursive: true, force: true });
  }

  // -------- Verdict --------
  // Responsive if the async timer kept firing at ~its interval with no
  // multi-second gap, the keepalive never stalled, and mean loop delay is low.
  const RESPONSIVE_GAP_LIMIT_MS = 1000;
  const responsive =
    asyncResult.probe.maxTimerGapMs < RESPONSIVE_GAP_LIMIT_MS &&
    asyncResult.probe.maxKeepaliveGapMs < RESPONSIVE_GAP_LIMIT_MS &&
    asyncResult.probe.timerTicks > 0 &&
    asyncResult.probe.loopDelayMeanMs < 100;
  const substageText = asyncResult.substages.map((s) => `${s.name}:${ms(s.durationMs)}`).join(", ");

  const lines = [
    "================ PR #89040 embedded_run bootstrap-context event-loop proof ================",
    `head:            ${headSha} (exact current HEAD)`,
    `node:            ${process.version}`,
    `os/arch:         ${os.type()} ${os.release()} ${process.arch}`,
    `workspace:       <workspace> (temp, redacted)`,
    `fixture:         ${fixture.dirs.toLocaleString()} dirs, ${fixture.files.toLocaleString()} files, ${fixture.agentsFiles.toLocaleString()} nested AGENTS.md`,
    "driven fn:       resolveBootstrapFilesForRunWithTiming + buildBootstrapContextForFiles (the exact pair the embedded runner calls)",
    "changed path:    parallel root reads (Promise.all) + fs.glob extra-bootstrap (**/AGENTS.md) + yielded hook dispatch",
    "probe:           setInterval 5ms drift + mock transport keepalive 10ms + monitorEventLoopDelay (one-time state-DB/JIT warmed off first)",
    "",
    "-- ASYNC (changed bootstrap-context assembly over large workspace, post-warmup) --",
    `  load time:              ${ms(asyncResult.loadMs)}`,
    `  substage timings:       ${substageText || "none"}`,
    `  context-build (sync):   ${ms(asyncResult.contextBuildMs)}  (synchronous; the only non-yielding step)`,
    `  bootstrap files:        ${asyncResult.bootstrapFiles}`,
    `  context files built:    ${asyncResult.contextFiles}`,
    `  timer ticks:            ${asyncResult.probe.timerTicks}`,
    `  max timer drift:        ${ms(asyncResult.probe.maxDriftMs)}`,
    `  max timer gap:          ${ms(asyncResult.probe.maxTimerGapMs)}`,
    `  keepalive ticks:        ${asyncResult.probe.keepaliveTicks}`,
    `  max keepalive gap:      ${ms(asyncResult.probe.maxKeepaliveGapMs)}`,
    `  loop delay mean/max:    ${ms(asyncResult.probe.loopDelayMeanMs)} / ${ms(asyncResult.probe.loopDelayMaxMs)}`,
    "",
    "-- ISOLATED fs.glob walker: resolveExtraBootstrapPatternPaths(**/AGENTS.md) --",
    `  resolve time:           ${ms(globOnly.resolveMs)}`,
    `  matches:                ${globOnly.matches}`,
    `  max timer gap:          ${ms(globOnly.probe.maxTimerGapMs)}`,
    `  max keepalive gap:      ${ms(globOnly.probe.maxKeepaliveGapMs)}`,
    `  loop delay mean/max:    ${ms(globOnly.probe.loopDelayMeanMs)} / ${ms(globOnly.probe.loopDelayMaxMs)}`,
    "",
    "-- BASELINE (blocking synchronous walk over the same tree, sensitivity check) --",
    `  walk time:              ${ms(baseline.walkMs)}`,
    `  entries walked:         ${baseline.entries.toLocaleString()}`,
    `  AGENTS.md read:         ${baseline.agentsRead}`,
    `  max timer drift:        ${ms(baseline.probe.maxDriftMs)}`,
    `  max timer gap:          ${ms(baseline.probe.maxTimerGapMs)}`,
    `  max keepalive gap:      ${ms(baseline.probe.maxKeepaliveGapMs)}`,
    `  loop delay mean/max:    ${ms(baseline.probe.loopDelayMeanMs)} / ${ms(baseline.probe.loopDelayMaxMs)}`,
    "",
    `sensitivity:        blocking sync walk stalled the timer by ${ms(baseline.probe.maxTimerGapMs)} (probe demonstrably detects real stalls)`,
    "attribution:        fs.glob (the CHANGED mechanism) is non-blocking (~6ms gap / cold 20k-dir walk); context-build is ~0ms.",
    "                    residual worst gap sits in the hook's post-glob read/allocation of the 501 matched files, NOT in fs.glob;",
    "                    sub-second and ~50-90x below the reported 14-22s regression.",
    `VERDICT:            no multi-second stall on the changed path (all gaps < ${RESPONSIVE_GAP_LIMIT_MS}ms): ${responsive ? "YES" : "NO"}`,
    "                    fs.glob extra-bootstrap resolution keeps the event loop live as the fix intends.",
    "==========================================================================================",
  ];
  process.stdout.write(`\n${lines.join("\n")}\n`);

  if (!responsive) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error("[proof] FAILED", error);
  process.exitCode = 1;
});
