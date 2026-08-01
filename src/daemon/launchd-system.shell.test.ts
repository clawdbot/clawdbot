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

type ProbeRun = { conflict: string; detail: string };

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
  plists: Record<string, { label: string } | { danglingSymlink: true }>;
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
    } else {
      await fs.writeFile(plistPath, `${spec.label}\n`);
    }
  }

  // Stand-in for plutil -extract Label: emits the file body as the label and
  // fails exactly when the plist cannot be read (dangling symlink / EPERM).
  const plutilShim = path.join(binDir, "plutil");
  await fs.writeFile(plutilShim, '#!/bin/bash\nfor last; do :; done\ncat -- "$last"\n', {
    mode: 0o755,
  });

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

  // The probe hardcodes the macOS daemon dir and plutil path; retarget both at
  // the temp fixtures while keeping every other rendered byte intact. bash is
  // used because the probe's read -d '' loop needs it (macOS /bin/sh is bash).
  const script = renderSystemLaunchDaemonOwnershipShellProbe(GATEWAY_LABEL)
    .replaceAll("/Library/LaunchDaemons", daemonsDir)
    .replaceAll("/usr/bin/plutil", plutilShim)
    .concat(
      'printf "conflict=%s\\n" "$openclaw_system_launchd_conflict"\n',
      'printf "detail=%s\\n" "$openclaw_system_launchd_detail"\n',
    );

  const { stdout } = await execFileAsync("bash", ["-c", script], {
    env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` },
  });
  const conflict = stdout.match(/^conflict=(.*)$/m)?.[1] ?? "";
  const detail = stdout.match(/^detail=(.*)$/m)?.[1] ?? "";
  return { conflict, detail };
}

describe.skipIf(process.platform === "win32")("rendered ownership probe under a real shell", () => {
  it("skips an unreadable vendor plist whose filename cannot own the gateway label", async () => {
    const run = await runRenderedProbe({
      plists: { "com.nordvpn.macos.helper.plist": { danglingSymlink: true } },
      launchctlMode: "never-loaded",
    });

    expect(run.conflict).toBe("");
    expect(run.detail).toBe("");
  });

  it("fails closed when an unreadable plist filename matches the gateway label", async () => {
    const run = await runRenderedProbe({
      plists: { [`${GATEWAY_LABEL}.plist`]: { danglingSymlink: true } },
      launchctlMode: "never-loaded",
    });

    expect(run.conflict).toContain(`${GATEWAY_LABEL}.plist`);
    expect(run.detail).toContain("could not inspect system LaunchDaemon plist");
  });

  it("still finds an installed same-label plist after skipping an unreadable vendor plist", async () => {
    const run = await runRenderedProbe({
      plists: {
        "com.nordvpn.macos.helper.plist": { danglingSymlink: true },
        "zz-vendor.plist": { label: GATEWAY_LABEL },
      },
      launchctlMode: "never-loaded",
    });

    expect(run.conflict).toContain("zz-vendor.plist");
    expect(run.detail).toContain("installed same-label system LaunchDaemon plist");
  });

  it("re-queries launchctl after the scan so a loaded same-label daemon is still refused", async () => {
    const run = await runRenderedProbe({
      plists: { "com.nordvpn.macos.helper.plist": { danglingSymlink: true } },
      launchctlMode: "loaded-after-scan",
    });

    expect(run.conflict).toBe(`system/${GATEWAY_LABEL}`);
    expect(run.detail).toContain(`loaded system LaunchDaemon system/${GATEWAY_LABEL}`);
  });
});
