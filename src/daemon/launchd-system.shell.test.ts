// Executes the rendered ownership shell probe end-to-end so the skip/fail-closed
// policy is proven in a real shell, not just via string assertions on the template.
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { renderSystemLaunchDaemonOwnershipShellProbe } from "./launchd-system.js";

const execFileAsync = promisify(execFile);
const GATEWAY_LABEL = "ai.openclaw.gateway";

// chmod 000 does not block root, and the probe never runs as root in production.
const runningAsRoot = typeof process.getuid === "function" && process.getuid() === 0;

type PlistFixture = { label: string } | { unreadable: true } | { danglingSymlink: true };
type ProbeRun = { conflict: string; detail: string; inspected: string[] };

const tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-launchd-sh-")));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

async function runRenderedProbe(params: {
  plists: Record<string, PlistFixture>;
  launchctlMode: "never-loaded" | "loaded-after-scan";
}): Promise<ProbeRun> {
  const root = await makeTempRoot();
  const daemonsDir = path.join(root, "daemons");
  const binDir = path.join(root, "bin");
  await fs.mkdir(daemonsDir);
  await fs.mkdir(binDir);

  for (const [name, spec] of Object.entries(params.plists)) {
    const plistPath = path.join(daemonsDir, name);
    if ("danglingSymlink" in spec) {
      await fs.symlink(path.join(root, "missing-target"), plistPath);
    } else if ("unreadable" in spec) {
      await fs.writeFile(plistPath, "locked\n", { mode: 0o000 });
    } else {
      await fs.writeFile(plistPath, `${spec.label}\n`);
    }
  }

  // Stand-in for plutil -extract Label: records each inspected path, emits the
  // file body as the label, and fails exactly when the plist cannot be read.
  const plutilLog = path.join(root, "plutil-inspected");
  const plutilShim = path.join(binDir, "plutil");
  await fs.writeFile(
    plutilShim,
    `#!/bin/bash\nfor last; do :; done\nprintf '%s\\n' "$last" >>"${plutilLog}"\ncat -- "$last"\n`,
    { mode: 0o755 },
  );

  // Directory read order is filesystem-dependent; re-emit find's NUL records
  // sorted so skip-then-detect traversal cases are deterministic.
  const findShim = path.join(binDir, "find");
  await fs.writeFile(
    findShim,
    `#!/bin/bash
paths=()
while IFS= read -r -d '' p; do paths+=("$p"); done < <(/usr/bin/find "$@")
while IFS= read -r p; do printf '%s\\0' "$p"; done < <(printf '%s\\n' "\${paths[@]}" | LC_ALL=C /usr/bin/sort)
`,
    { mode: 0o755 },
  );

  // First print call reports not-found so the plist scan runs; in
  // loaded-after-scan mode the post-scan re-query then reports a loaded daemon.
  const launchctlShim = path.join(binDir, "launchctl");
  const countFile = path.join(root, "launchctl-calls");
  await fs.writeFile(
    launchctlShim,
    `#!/bin/bash
n=0
[ -f "${countFile}" ] && n=$(cat "${countFile}")
n=$((n + 1))
printf '%s' "$n" >"${countFile}"
if [ "${params.launchctlMode}" = "loaded-after-scan" ] && [ "$n" -ge 2 ]; then
  echo "state = running"
  exit 0
fi
echo "Could not find service" >&2
exit 113
`,
    { mode: 0o755 },
  );

  // The probe hardcodes the macOS daemon dir and tool paths; retarget them at
  // the temp fixtures (mkdtemp paths contain only shell-safe characters) while
  // keeping every other rendered byte intact.
  const script = renderSystemLaunchDaemonOwnershipShellProbe(GATEWAY_LABEL)
    .replaceAll("/Library/LaunchDaemons", daemonsDir)
    .replaceAll("/usr/bin/plutil", plutilShim)
    .replaceAll("/usr/bin/find", findShim)
    .concat(
      'printf "conflict=%s\\n" "$openclaw_system_launchd_conflict"\n',
      'printf "detail=%s\\n" "$openclaw_system_launchd_detail"\n',
    );

  // Production executes this probe via /bin/sh on macOS (restart handoff and
  // update restart scripts); run the same interpreter there. Linux dash lacks
  // read -d '', so non-darwin dev runs use bash as the closest stand-in.
  const shell = process.platform === "darwin" ? "/bin/sh" : "bash";
  const { stdout } = await execFileAsync(shell, ["-c", script], {
    env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` },
  });
  const conflict = stdout.match(/^conflict=(.*)$/m)?.[1] ?? "";
  const detail = stdout.match(/^detail=(.*)$/m)?.[1] ?? "";
  const inspected = await fs.readFile(plutilLog, "utf8").then(
    (contents) => contents.split("\n").filter(Boolean),
    () => [] as string[],
  );
  return { conflict, detail, inspected };
}

describe.skipIf(process.platform === "win32" || runningAsRoot)(
  "rendered ownership probe under a real shell",
  () => {
    it("skips an unreadable vendor plist whose filename cannot own the gateway label", async () => {
      const run = await runRenderedProbe({
        plists: { "com.nordvpn.macos.helper.plist": { unreadable: true } },
        launchctlMode: "never-loaded",
      });

      expect(run.inspected).toHaveLength(1);
      expect(run.inspected[0]).toContain("com.nordvpn.macos.helper.plist");
      expect(run.conflict).toBe("");
      expect(run.detail).toBe("");
    });

    it("fails closed when an unreadable plist filename matches the gateway label", async () => {
      const run = await runRenderedProbe({
        plists: { [`${GATEWAY_LABEL}.plist`]: { unreadable: true } },
        launchctlMode: "never-loaded",
      });

      expect(run.conflict).toContain(`${GATEWAY_LABEL}.plist`);
      expect(run.detail).toContain("could not inspect system LaunchDaemon plist");
    });

    it("skips a dangling same-label symlink like the Node probe's missing status", async () => {
      const run = await runRenderedProbe({
        plists: { [`${GATEWAY_LABEL}.plist`]: { danglingSymlink: true } },
        launchctlMode: "never-loaded",
      });

      expect(run.inspected).toHaveLength(1);
      expect(run.conflict).toBe("");
      expect(run.detail).toBe("");
    });

    it("still finds an installed same-label plist after skipping an unreadable vendor plist", async () => {
      const run = await runRenderedProbe({
        plists: {
          "com.nordvpn.macos.helper.plist": { unreadable: true },
          "zz-vendor.plist": { label: GATEWAY_LABEL },
        },
        launchctlMode: "never-loaded",
      });

      // Sorted traversal guarantees the unreadable plist is inspected first.
      expect(run.inspected).toHaveLength(2);
      expect(run.inspected[0]).toContain("com.nordvpn.macos.helper.plist");
      expect(run.inspected[1]).toContain("zz-vendor.plist");
      expect(run.conflict).toContain("zz-vendor.plist");
      expect(run.detail).toContain("installed same-label system LaunchDaemon plist");
    });

    it("re-queries launchctl after the scan so a loaded same-label daemon is still refused", async () => {
      const run = await runRenderedProbe({
        plists: { "com.nordvpn.macos.helper.plist": { unreadable: true } },
        launchctlMode: "loaded-after-scan",
      });

      expect(run.conflict).toBe(`system/${GATEWAY_LABEL}`);
      expect(run.detail).toContain(`loaded system LaunchDaemon system/${GATEWAY_LABEL}`);
    });
  },
);
