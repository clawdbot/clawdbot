// Update restart handoff tests cover pre-migration LaunchAgent recovery.
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { prepareRestartScript } from "./restart-helper.js";

const execFileAsync = promisify(execFile);

describe("macOS update restart LaunchAgent recovery", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
  const originalGetuid = process.getuid;

  afterEach(() => {
    if (originalPlatformDescriptor) {
      Object.defineProperty(process, "platform", originalPlatformDescriptor);
    }
    process.getuid = originalGetuid;
  });

  it("bootstraps a verified relocated plist only while the canonical plist is absent", async () => {
    Object.defineProperty(process, "platform", {
      ...originalPlatformDescriptor,
      value: "darwin",
    });
    process.getuid = () => 501;
    const tmpDir = tempDirs.make("openclaw-restart-helper-");
    const fakeBinDir = path.join(tmpDir, "bin");
    const callsPath = path.join(tmpDir, "launchctl-calls.log");
    const home = path.join(tmpDir, "canonical-home");
    const canonicalPlist = path.join(home, "Library", "LaunchAgents", "ai.openclaw.gateway.plist");
    const relocatedPlist = path.join(
      tmpDir,
      "legacy home's data",
      "Library",
      "LaunchAgents",
      "ai.openclaw.gateway.plist",
    );
    await fs.mkdir(fakeBinDir, { recursive: true });
    await fs.mkdir(path.dirname(relocatedPlist), { recursive: true });
    await fs.writeFile(relocatedPlist, "legacy");
    await fs.writeFile(path.join(fakeBinDir, "sleep"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    await fs.writeFile(
      path.join(fakeBinDir, "launchctl"),
      `#!/bin/sh
if [ "$1" = "print" ]; then printf 'Could not find service\n' >&2; exit 113; fi
printf '%s\n' "$*" >> "$OPENCLAW_LAUNCHCTL_CALLS"
case "$1" in
  kickstart) exit 42 ;;
  enable|bootstrap) exit 0 ;;
esac
exit 0
`,
      { mode: 0o755 },
    );

    const runRestart = async () => {
      await fs.writeFile(callsPath, "");
      const scriptPath = await prepareRestartScript(
        {
          OPENCLAW_PROFILE: "default",
          HOME: home,
          OPENCLAW_STATE_DIR: path.join(tmpDir, "state"),
        },
        18789,
        [],
        relocatedPlist,
      );
      if (!scriptPath) {
        throw new Error("expected restart script path");
      }
      try {
        await execFileAsync("/bin/sh", [scriptPath], {
          env: {
            ...process.env,
            OPENCLAW_LAUNCHCTL_CALLS: callsPath,
            PATH: `${fakeBinDir}:${process.env.PATH ?? ""}`,
          },
        });
      } finally {
        await fs.rm(path.dirname(scriptPath), { recursive: true, force: true });
      }
      return await fs.readFile(callsPath, "utf8");
    };

    const withoutCanonical = await runRestart();
    expect(withoutCanonical).toContain(`bootstrap gui/501 ${relocatedPlist}`);
    expect(withoutCanonical).not.toContain(`bootstrap gui/501 ${canonicalPlist}`);

    await fs.mkdir(path.dirname(canonicalPlist), { recursive: true });
    await fs.symlink(path.join(tmpDir, "missing-plist-target"), canonicalPlist);
    const withCanonicalSymlink = await runRestart();
    expect(withCanonicalSymlink).toContain(`bootstrap gui/501 ${canonicalPlist}`);
    expect(withCanonicalSymlink).not.toContain(`bootstrap gui/501 ${relocatedPlist}`);
  });
});
