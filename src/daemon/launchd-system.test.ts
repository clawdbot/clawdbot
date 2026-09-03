// System launchd ownership tests cover loaded, installed, and unverifiable states.
import { execFileSync } from "node:child_process";
import { chmodSync, constants, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";

const state = vi.hoisted(() => ({
  launchctl: { stdout: "", stderr: "Could not find service", code: 113 },
  files: new Map<string, string>(),
  accessErrors: new Map<string, string>(),
  readdirError: "",
  plutilValues: new Map<string, unknown>(),
  plutilErrors: new Map<string, string>(),
}));

function fsError(code: string, target: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: ${target}`), { code });
}

vi.mock("node:fs/promises", () => {
  const mocked = {
    constants,
    access: vi.fn(async (target: string, mode?: number) => {
      const code = state.accessErrors.get(target);
      if (code && mode === constants.R_OK) {
        throw fsError(code, target);
      }
      if (!state.files.has(target)) {
        throw fsError("ENOENT", target);
      }
    }),
    readdir: vi.fn(async (dir: string) => {
      if (state.readdirError) {
        throw fsError(state.readdirError, dir);
      }
      const prefix = `${dir}/`;
      return Array.from(state.files.keys())
        .filter((file) => file.startsWith(prefix) && !file.slice(prefix.length).includes("/"))
        .map((file) => file.slice(prefix.length));
    }),
    readFile: vi.fn(async (target: string) => {
      const contents = state.files.get(target);
      if (contents === undefined) {
        throw fsError("ENOENT", target);
      }
      return contents;
    }),
  };
  return { ...mocked, default: mocked };
});

const execLaunchctl = vi.hoisted(() => vi.fn(async () => state.launchctl));

vi.mock("./launchd-exec.js", () => ({
  execLaunchctl,
  isLaunchctlNotLoaded: (result: { stdout: string; stderr: string }) =>
    /could not find service|no such process|not found/i.test(result.stderr || result.stdout),
  formatLaunchctlResultDetail: (result: { stdout: string; stderr: string }) =>
    (result.stderr || result.stdout).trim(),
}));

const execFileUtf8 = vi.hoisted(() =>
  vi.fn(async (_command: string, args: string[]) => {
    const target = args.at(-1) ?? "";
    const error = state.plutilErrors.get(target);
    return error
      ? { stdout: "", stderr: error, code: 1 }
      : { stdout: JSON.stringify(state.plutilValues.get(target) ?? {}), stderr: "", code: 0 };
  }),
);

vi.mock("./exec-file.js", () => ({ execFileUtf8 }));

import {
  assertNoSystemLaunchDaemonOwnership,
  inspectSystemLaunchDaemonOwnership,
  renderSystemLaunchDaemonOwnershipShellProbe,
} from "./launchd-system.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const hostPlatform = process.platform;
const absentQuery = 'printf "%s\\n" "Could not find service" >&2\nexit 113';

function runRenderedProbe(
  plistName: string,
  plistMode: "unlabeled" | "same-label" | "malformed" | "unreadable",
  launchctlBody = absentQuery,
) {
  const root = tempDirs.make("openclaw-launchd-probe-");
  const daemonsDir = path.join(root, "daemons");
  const binDir = path.join(root, "bin");
  const probeLog = path.join(root, "probe.log");
  mkdirSync(daemonsDir);
  mkdirSync(binDir);
  writeFileSync(probeLog, "");
  writeFileSync(path.join(root, "non-executable"), "#!/bin/sh\nexit 0\n", { mode: 0o600 });
  writeFileSync(path.join(daemonsDir, plistName), `${plistMode}\n`);
  const plutilShim = path.join(binDir, "plutil");
  writeFileSync(
    plutilShim,
    `#!/bin/sh
printf 'scan\\n' >> "$OPENCLAW_TEST_PROBE_LOG"
mode=$1
for last; do :; done
case "$last" in
  *unreadable*)
    printf '%s\\n' "Operation not permitted" >&2
    exit 1
    ;;
esac
fixture=$(/bin/cat "$last")
if [ "$mode" = "-extract" ]; then
  if [ "$fixture" = "same-label" ]; then
    printf '%s\\n' "ai.openclaw.gateway"
    exit 0
  fi
  printf '%s\\n' "No value at that key path: Label" >&2
  exit 1
fi
if [ "$mode" = "-lint" ] && [ "$fixture" != "malformed" ]; then
  exit 0
fi
exit 1
`,
    { mode: 0o700 },
  );
  const launchctlShim = path.join(binDir, "launchctl");
  writeFileSync(
    launchctlShim,
    `#!/bin/sh
printf 'query\\n' >> "$OPENCLAW_TEST_PROBE_LOG"
query_count=$(/usr/bin/grep -c '^query$' "$OPENCLAW_TEST_PROBE_LOG")
${launchctlBody}
`,
    { mode: 0o700 },
  );
  chmodSync(plutilShim, 0o700);
  chmodSync(launchctlShim, 0o700);
  if (plistMode === "unreadable") {
    chmodSync(path.join(daemonsDir, plistName), 0o000);
  }
  const script = renderSystemLaunchDaemonOwnershipShellProbe("ai.openclaw.gateway")
    .replaceAll("/Library/LaunchDaemons", daemonsDir)
    .replaceAll("/usr/bin/plutil", plutilShim)
    .concat(
      'printf "conflict=%s\\ndetail=%s\\n" "$openclaw_system_launchd_conflict" "$openclaw_system_launchd_detail"\n',
    );
  const shell = hostPlatform === "darwin" ? "/bin/sh" : "/bin/bash";
  const output = execFileSync(shell, ["-c", script], {
    encoding: "utf8",
    env: {
      HOME: root,
      TMPDIR: root,
      PATH: binDir,
      OPENCLAW_TEST_PROBE_LOG: probeLog,
      OPENCLAW_TEST_PROBE_DIR: root,
    },
  });
  return {
    conflict: output.match(/^conflict=(.*)$/m)?.[1],
    detail: output.match(/^detail=(.*)$/m)?.[1],
    events: readFileSync(probeLog, "utf8").trim().split("\n").filter(Boolean),
  };
}

describe("system LaunchDaemon ownership", () => {
  const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");

  beforeEach(() => {
    vi.clearAllMocks();
    state.launchctl = { stdout: "", stderr: "Could not find service", code: 113 };
    state.files.clear();
    state.accessErrors.clear();
    state.readdirError = "";
    state.plutilValues.clear();
    state.plutilErrors.clear();
    if (originalPlatformDescriptor) {
      Object.defineProperty(process, "platform", {
        ...originalPlatformDescriptor,
        value: "darwin",
      });
    }
  });

  afterEach(() => {
    if (originalPlatformDescriptor) {
      Object.defineProperty(process, "platform", originalPlatformDescriptor);
    }
  });

  it("uses the readable system-domain query and reports a loaded owner", async () => {
    state.launchctl = { stdout: "state = running", stderr: "", code: 0 };

    await expect(inspectSystemLaunchDaemonOwnership("ai.openclaw.gateway")).resolves.toEqual({
      status: "loaded",
      serviceTarget: "system/ai.openclaw.gateway",
    });
    expect(execLaunchctl).toHaveBeenCalledWith(["print", "system/ai.openclaw.gateway"], undefined);
  });

  it("fails closed when launchctl cannot classify system ownership", async () => {
    state.launchctl = { stdout: "", stderr: "Operation not permitted", code: 1 };

    await expect(inspectSystemLaunchDaemonOwnership("ai.openclaw.gateway")).resolves.toEqual({
      status: "unverifiable",
      serviceTarget: "system/ai.openclaw.gateway",
      operation: "launchctl",
      detail: "Operation not permitted",
    });
  });

  it("detects the canonical unloaded plist by its structural Label", async () => {
    const plistPath = "/Library/LaunchDaemons/ai.openclaw.gateway.plist";
    state.files.set(plistPath, "bplist00-binary-payload");
    state.plutilValues.set(plistPath, { Label: "ai.openclaw.gateway" });

    await expect(inspectSystemLaunchDaemonOwnership("ai.openclaw.gateway")).resolves.toEqual({
      status: "installed",
      serviceTarget: "system/ai.openclaw.gateway",
      plistPath,
    });
  });

  it("detects a noncanonical XML plist by its decoded Label", async () => {
    const plistPath = "/Library/LaunchDaemons/vendor-openclaw.plist";
    state.files.set(
      plistPath,
      "<plist><dict><key>Label</key><string>ai.openclaw.gateway</string></dict></plist>",
    );
    state.plutilValues.set(plistPath, { Label: "ai.openclaw.gateway" });

    const ownership = await inspectSystemLaunchDaemonOwnership("ai.openclaw.gateway");

    expect(ownership).toMatchObject({ status: "installed", plistPath });
    expect(execFileUtf8).toHaveBeenCalled();
  });

  it("uses the native top-level Label instead of an earlier nested XML key", async () => {
    const plistPath = "/Library/LaunchDaemons/nested-label.plist";
    state.files.set(
      plistPath,
      "<plist><dict><key>EnvironmentVariables</key><dict><key>Label</key><string>nested</string></dict><key>Label</key><string>ai.openclaw.gateway</string></dict></plist>",
    );
    state.plutilValues.set(plistPath, { Label: "ai.openclaw.gateway" });

    await expect(inspectSystemLaunchDaemonOwnership("ai.openclaw.gateway")).resolves.toMatchObject({
      status: "installed",
      plistPath,
    });
  });

  it("uses native plutil for binary and non-XML plist formats", async () => {
    const plistPath = "/Library/LaunchDaemons/binary-openclaw.plist";
    state.files.set(plistPath, "bplist00-binary-payload");
    state.plutilValues.set(plistPath, { Label: "ai.openclaw.gateway" });

    const ownership = await inspectSystemLaunchDaemonOwnership("ai.openclaw.gateway");

    expect(ownership).toMatchObject({ status: "installed", plistPath });
    expect(execFileUtf8).toHaveBeenCalledWith("/usr/bin/plutil", [
      "-convert",
      "json",
      "-o",
      "-",
      "--",
      plistPath,
    ]);
  });

  it("skips a valid plist without a string Label and detects a later owner", async () => {
    const unrelated = "/Library/LaunchDaemons/com.google.keystone.daemon.plist";
    const owner = "/Library/LaunchDaemons/vendor-openclaw.plist";
    state.files.set(unrelated, "<plist><dict><key>RunAtLoad</key><true/></dict></plist>");
    state.plutilValues.set(unrelated, { RunAtLoad: true });
    state.files.set(owner, "<plist/>");
    state.plutilValues.set(owner, { Label: "ai.openclaw.gateway" });

    await expect(inspectSystemLaunchDaemonOwnership("ai.openclaw.gateway")).resolves.toEqual({
      status: "installed",
      serviceTarget: "system/ai.openclaw.gateway",
      plistPath: owner,
    });
    expect(execFileUtf8).toHaveBeenCalledTimes(2);
  });

  it("treats a valid non-string Label as unable to own the gateway label", async () => {
    const unrelated = "/Library/LaunchDaemons/com.vendor.numeric-label.plist";
    state.files.set(unrelated, "<plist/>");
    state.plutilValues.set(unrelated, { Label: 42 });

    await expect(inspectSystemLaunchDaemonOwnership("ai.openclaw.gateway")).resolves.toEqual({
      status: "absent",
      serviceTarget: "system/ai.openclaw.gateway",
    });
    expect(execLaunchctl).toHaveBeenCalledTimes(2);
  });

  it("skips an unreadable foreign plist", async () => {
    const unrelated = "/Library/LaunchDaemons/com.vendor.locked.plist";
    state.files.set(unrelated, "<plist/>");
    state.accessErrors.set(unrelated, "EACCES");
    state.plutilErrors.set(unrelated, "Operation not permitted");

    await expect(inspectSystemLaunchDaemonOwnership("ai.openclaw.gateway")).resolves.toEqual({
      status: "absent",
      serviceTarget: "system/ai.openclaw.gateway",
    });
    await expect(
      assertNoSystemLaunchDaemonOwnership("ai.openclaw.gateway"),
    ).resolves.toBeUndefined();
  });

  it("detects a readable owner after an unreadable foreign plist", async () => {
    const unrelated = "/Library/LaunchDaemons/com.vendor.locked.plist";
    const owner = "/Library/LaunchDaemons/vendor-openclaw.plist";
    state.files.set(unrelated, "<plist/>");
    state.accessErrors.set(unrelated, "EACCES");
    state.plutilErrors.set(unrelated, "Operation not permitted");
    state.files.set(owner, "<plist/>");
    state.plutilValues.set(owner, { Label: "ai.openclaw.gateway" });

    await expect(inspectSystemLaunchDaemonOwnership("ai.openclaw.gateway")).resolves.toEqual({
      status: "installed",
      serviceTarget: "system/ai.openclaw.gateway",
      plistPath: owner,
    });
  });

  it("rechecks the system domain after a negative plist snapshot", async () => {
    execLaunchctl
      .mockResolvedValueOnce({ stdout: "", stderr: "Could not find service", code: 113 })
      .mockResolvedValueOnce({ stdout: "state = running", stderr: "", code: 0 });

    await expect(inspectSystemLaunchDaemonOwnership("ai.openclaw.gateway")).resolves.toEqual({
      status: "loaded",
      serviceTarget: "system/ai.openclaw.gateway",
    });
    expect(execLaunchctl).toHaveBeenCalledTimes(2);
  });

  it("can skip the installed-plist scan for read-only status probes", async () => {
    const plistPath = "/Library/LaunchDaemons/ai.openclaw.gateway.plist";
    state.files.set(plistPath, "<plist/>");

    await expect(
      inspectSystemLaunchDaemonOwnership("ai.openclaw.gateway", {
        scanInstalledPlists: false,
      }),
    ).resolves.toEqual({
      status: "absent",
      serviceTarget: "system/ai.openclaw.gateway",
    });
  });

  it("throws one typed recovery error and documents that force cannot bypass it", async () => {
    state.launchctl = { stdout: "state = running", stderr: "", code: 0 };

    const error = await assertNoSystemLaunchDaemonOwnership("ai.openclaw.gateway").catch(
      (caught: unknown) => caught,
    );

    expect(error).toMatchObject({
      name: "SystemLaunchDaemonOwnershipError",
      code: "SYSTEM_LAUNCH_DAEMON_OWNERSHIP",
      ownership: { status: "loaded", serviceTarget: "system/ai.openclaw.gateway" },
    });
    expect(String(error)).toContain("duplicate KeepAlive managers can restart-loop the gateway");
    expect(String(error)).toContain("--force does not override system ownership");
    expect(String(error)).toContain("sudo launchctl bootout system/ai.openclaw.gateway");
  });

  it("renders a standalone loaded and structural same-label plist probe", () => {
    const script = renderSystemLaunchDaemonOwnershipShellProbe("ai.openclaw.gateway");

    expect(script).toContain('launchctl print "$openclaw_system_launchd_target"');
    expect(script).toContain(
      '/usr/bin/plutil -extract Label raw -o - -- "$openclaw_system_launchd_plist"',
    );
    expect(script).toContain(
      '/usr/bin/plutil -lint -- "$openclaw_system_launchd_plist" >/dev/null 2>&1',
    );
    expect(script).toContain(
      "/usr/bin/find \"$openclaw_system_launchd_dir\" -mindepth 1 -maxdepth 1 -name '*.plist' -print0",
    );
    expect(script).toContain("while IFS= read -r -d '' openclaw_system_launchd_plist");
    expect(script).toContain('[ ! -r "$openclaw_system_launchd_plist" ]');
    expect(script).toContain('[ ! -x "$openclaw_system_launchd_dir" ]');
    expect(script).not.toContain('"$openclaw_system_launchd_dir"/*.plist');
    expect(script).toContain(
      'if [ "$openclaw_system_launchd_plist_label" != "$openclaw_system_launchd_label" ]',
    );
    expect(script).not.toContain("|| true");
  });

  it("executes the rendered probe across readable and unreadable plists", () => {
    expect(runRenderedProbe("com.google.keystone.daemon.plist", "unlabeled").conflict).toBe("");
    expect(runRenderedProbe("com.vendor.unreadable.plist", "unreadable").conflict).toBe("");
    expect(runRenderedProbe("vendor-openclaw.plist", "same-label").conflict).toContain(
      "vendor-openclaw.plist",
    );
    expect(runRenderedProbe("com.vendor.broken.plist", "malformed").conflict).toContain(
      "com.vendor.broken.plist",
    );
  });

  it.each([
    ["loaded", "exit 0", 1, "loaded system LaunchDaemon"],
    ["absent", absentQuery, 2, ""],
    ["query error", 'printf "Operation not permitted\\n" >&2\nexit 1', 1, "could not verify"],
    ["signal", 'printf "Could not find service\\n" >&2\nkill -TERM $$', 1, "could not verify"],
    [
      "execution failure",
      'printf "Could not find service\\n" >&2\nexec "$OPENCLAW_TEST_PROBE_DIR/non-executable"',
      1,
      "could not verify",
    ],
    [
      "missing command",
      'printf "Could not find service\\n" >&2\nexec "$OPENCLAW_TEST_PROBE_DIR/missing"',
      1,
      "could not verify",
    ],
    [
      "signal after scan",
      `if [ "$query_count" -eq 1 ]; then\n${absentQuery}\nfi\nprintf "Could not find service\\n" >&2\nkill -TERM $$`,
      2,
      "could not verify",
    ],
    [
      "loaded after scan",
      `if [ "$query_count" -eq 2 ]; then exit 0; fi\n${absentQuery}`,
      2,
      "loaded system LaunchDaemon",
    ],
  ] as const)(
    "executes the rendered ownership query with %s outcome",
    (_, body, queries, detail) => {
      const result = runRenderedProbe("foreign.plist", "unlabeled", body);
      expect(result.conflict).toBe(detail ? "system/ai.openclaw.gateway" : "");
      if (detail) {
        expect(result.detail).toContain(detail);
      } else {
        expect(result.detail).toBe("");
      }
      expect(result.events).toEqual(queries === 1 ? ["query"] : ["query", "scan", "scan", "query"]);
    },
  );
});
