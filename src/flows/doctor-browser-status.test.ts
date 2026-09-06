// Real browser contribution, facade, and structured repair contract; synthetic profiles only.
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { maybeRepairOwnedChromeExtensionNativeHosts } from "../commands/doctor-browser.js";
import { createDoctorPrompter } from "../commands/doctor-prompter.js";
import { useAutoCleanupTempDirTracker } from "../plugin-sdk/test-env.js";
import { loadBundledPluginPublicSurface } from "../plugin-sdk/test-helpers/public-surface-loader.js";
import { CORE_HEALTH_CHECKS } from "./doctor-core-checks.js";
import { runBrowserHealth } from "./doctor-health-contribution-runners.gateway.js";
import type { DoctorHealthFlowContext } from "./doctor-health-contribution-types.js";
import { runDoctorHealthRepairs } from "./doctor-repair-flow.js";

const capture = vi.hoisted(() => ({ note: vi.fn(), load: vi.fn(), surface: {} }));
vi.mock("../../packages/terminal-core/src/note.js", () => ({ note: capture.note }));
vi.mock(import("../plugin-sdk/facade-loader.js"), async (importOriginal) => ({
  ...(await importOriginal()),
  loadBundledPluginPublicSurfaceModuleSyncCore: capture.load,
}));
// Load the real public artifact through the shared test loader, keeping plugin
// implementation types out of the core typecheck graph.
const browserDoctor = await loadBundledPluginPublicSurface<
  typeof import("../commands/doctor-browser.js")
>({ pluginId: "browser", artifactBasename: "browser-doctor.js" });
const dirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

beforeEach(() => {
  capture.note.mockClear();
  capture.load.mockReset().mockImplementation(() => capture.surface);
  const home = dirs.make("doctor-browser-flow-");
  const configDir = path.join(home, ".openclaw");
  const extensionDir = path.join(configDir, "browser", "chrome-extension");
  const profileRoot = path.join(home, "Library", "Application Support", "Google", "Chrome");
  fs.mkdirSync(extensionDir, { recursive: true });
  fs.writeFileSync(path.join(extensionDir, ".openclaw-owned.json"), '{"v":1}');
  fs.mkdirSync(path.join(profileRoot, "Default"), { recursive: true });
  for (const name of ["Preferences", "Secure Preferences"]) {
    fs.writeFileSync(path.join(profileRoot, "Default", name), "{}");
  }
  vi.spyOn(os, "homedir").mockReturnValue(home);
  vi.stubEnv("HOME", home);
  vi.stubEnv("OPENCLAW_STATE_DIR", configDir);
  accesses = [];
  const deny = (target: unknown) => {
    if (
      ["Local State", "Preferences", "Secure Preferences", "Cookies"].includes(
        path.basename(String(target)),
      )
    ) {
      accesses.push(String(target));
      throw Object.assign(new Error("synthetic permission denial"), { code: "EACCES" });
    }
  };
  const syncRead = fs.readFileSync;
  vi.spyOn(fs, "readFileSync").mockImplementation((...args) => {
    deny(args[0]);
    return syncRead(...args);
  });
  const asyncRead = fsp.readFile;
  vi.spyOn(fsp, "readFile").mockImplementation(async (...args) => {
    deny(args[0]);
    return await asyncRead(...args);
  });
  capture.surface = {
    ...browserDoctor,
    noteChromeMcpBrowserReadiness: (
      cfg: Parameters<typeof browserDoctor.noteChromeMcpBrowserReadiness>[0],
      deps?: Parameters<typeof browserDoctor.noteChromeMcpBrowserReadiness>[1],
    ) =>
      browserDoctor.noteChromeMcpBrowserReadiness(cfg, {
        platform: "darwin",
        configDir,
        env: { HOME: home },
        ...deps,
      }),
  };
  const readdir = fsp.readdir;
  vi.spyOn(fsp, "readdir").mockImplementation(async (...args) => {
    if (String(args[0]) === profileRoot) {
      accesses.push(String(args[0]));
    }
    return await readdir(...args);
  });
  const cfg = { browser: { extensionRelay: { allowLegacyAuth: false } } };
  const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
  const options = { nonInteractive: true };
  ctx = {
    cfg,
    cfgForPersistence: cfg,
    runtime,
    options,
    prompter: createDoctorPrompter({ runtime, options }),
    configResult: { cfg },
    sourceConfigValid: true,
    configPath: path.join(configDir, "openclaw.json"),
    env: { HOME: home, OPENCLAW_STATE_DIR: configDir },
  };
});

let ctx: DoctorHealthFlowContext;
let accesses: string[];
const check = CORE_HEALTH_CHECKS.find((entry) => entry.id === "core/doctor/browser")!;
function repairContext() {
  return { cfg: ctx.cfg, runtime: ctx.runtime, mode: "fix" as const, configPath: ctx.configPath };
}

it.each([false, undefined, true])(
  "preserves full/facade/structured browser skip (import %s)",
  async (allowSystemProfileImport) => {
    ctx.cfg = { browser: { ...ctx.cfg.browser, allowSystemProfileImport } };
    await runBrowserHealth(ctx);
    expect(accesses).toEqual([]);
    const notes = capture.note.mock.calls.map(([message]) => String(message)).join("\n");
    expect(notes).toContain("profile discovery skipped");
    expect(notes).toContain("native bootstrap was not inspected");
    const findings = await check.detect(repairContext());
    const findingText = findings
      .map((finding) => [finding.message, finding.fixHint].join("\n"))
      .join("\n");
    expect(findingText).toContain("profile discovery skipped");
    expect(findingText).toContain("native bootstrap was not inspected");
    const result = await check.repair?.(repairContext(), findings);
    expect(result?.changes).toEqual([]);
    expect(result?.warnings?.join("\n")).toContain("native-host repair skipped");
    expect(result?.status).toBe("skipped");
    expect(result?.reason).toContain("Doctor does not inspect personal browser profiles");
    await expect(maybeRepairOwnedChromeExtensionNativeHosts()).resolves.toEqual(result);
    const run = await runDoctorHealthRepairs(repairContext(), { checks: [check] });
    expect(run).toMatchObject({
      checksRun: 1,
      checksRepaired: 0,
      checksValidated: 0,
      changes: [],
      effects: [],
    });
    expect(run.remainingFindings).toEqual(run.findings);
    expect(run.warnings).toEqual([
      ...result!.warnings!,
      `core/doctor/browser repair skipped: ${result!.reason}`,
    ]);
    expect(accesses).toEqual([]);
  },
);

it.each([
  {
    label: "warning-only failure, even if the text says skipped",
    output: { changes: [], warnings: ["native-host repair skipped: invalid registration"] },
    status: "failed",
    reason: "native-host repair skipped: invalid registration",
  },
  {
    label: "explicit failure",
    output: {
      status: "failed",
      reason: "registration integrity failure",
      changes: [],
      warnings: [],
    },
    status: "failed",
    reason: "registration integrity failure",
  },
  {
    label: "completed repair",
    output: { changes: ["Repaired registration."], warnings: [] },
    status: undefined,
    reason: undefined,
  },
])("preserves $label through the facade and adapter", async ({ output, status, reason }) => {
  capture.surface = {
    ...capture.surface,
    maybeRepairOwnedChromeExtensionNativeHosts: vi.fn().mockResolvedValue(output),
  };
  await expect(maybeRepairOwnedChromeExtensionNativeHosts()).resolves.toEqual(output);
  const result = await check.repair?.(repairContext(), []);
  expect(result).toMatchObject({ changes: output.changes, warnings: output.warnings });
  expect(result?.status).toBe(status);
  expect(result?.reason).toBe(reason);
  const run = await runDoctorHealthRepairs(repairContext(), { checks: [check] });
  expect(run.checksRepaired).toBe(status === "failed" ? 0 : 1);
  expect(run.remainingFindings).toEqual(run.findings);
  expect(run.warnings.join("\n")).toContain(
    status === "failed" ? `repair failed: ${reason}` : "repair left",
  );
  expect(accesses).toEqual([]);
});

it.each(["loader", "repair hook"])("keeps %s errors as failures", async (source) => {
  const fail = () => {
    throw new Error("synthetic browser repair unavailable");
  };
  if (source === "loader") {
    capture.load.mockImplementation(fail);
  } else {
    capture.surface = { ...capture.surface, maybeRepairOwnedChromeExtensionNativeHosts: fail };
  }
  const result = await check.repair?.(repairContext(), []);
  expect(result).toMatchObject({ status: "failed", changes: [] });
  expect(result?.warnings?.join("\n")).toContain("synthetic browser repair unavailable");
  const run = await runDoctorHealthRepairs(repairContext(), { checks: [check] });
  expect(run.checksRepaired).toBe(0);
  expect(run.remainingFindings).toEqual(run.findings);
  expect(run.warnings.join("\n")).toContain("repair failed:");
  expect(accesses).toEqual([]);
});

it("does not load or invoke native-host repair in dry-run", async () => {
  const repair = vi.fn().mockRejectedValue(new Error("must not invoke repair"));
  capture.surface = { ...capture.surface, maybeRepairOwnedChromeExtensionNativeHosts: repair };
  const result = await check.repair?.({ ...repairContext(), dryRun: true }, []);
  expect(result).toEqual({
    status: "skipped",
    reason: "native-host repair requires filesystem writes",
    changes: [],
  });
  expect(capture.load).not.toHaveBeenCalled();
  const run = await runDoctorHealthRepairs(repairContext(), { checks: [check], dryRun: true });
  expect(run).toMatchObject({ checksRepaired: 0, checksValidated: 0, changes: [], effects: [] });
  expect(run.remainingFindings).toEqual(run.findings);
  expect(run.warnings).toEqual([`core/doctor/browser repair skipped: ${result!.reason}`]);
  expect(repair).not.toHaveBeenCalled();
  expect(accesses).toEqual([]);
});
