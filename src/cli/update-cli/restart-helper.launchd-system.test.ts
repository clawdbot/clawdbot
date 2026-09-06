// Update restart handoff tests cover macOS launchd path and ownership handling.
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareRestartScript } from "./restart-helper.js";

const execFileAsync = promisify(execFile);
const fsState = vi.hoisted(() => ({ externalHome: undefined as string | undefined }));

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  const statSync = ((target: string) => {
    if (fsState.externalHome) {
      if (target === "/") {
        return { dev: 1 };
      }
      if (target === fsState.externalHome) {
        return { dev: 2 };
      }
      if (target === "/Users/test") {
        return { dev: 1 };
      }
    }
    return actual.statSync(target);
  }) as typeof actual.statSync;
  return { ...actual, statSync, default: { ...actual, statSync } };
});

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  const userInfo = () => ({ ...actual.userInfo(), username: "test" });
  return { ...actual, userInfo, default: { ...actual, userInfo } };
});

describe("macOS update restart", () => {
  const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
  const originalGetuid = process.getuid;

  afterEach(() => {
    if (originalPlatformDescriptor) {
      Object.defineProperty(process, "platform", originalPlatformDescriptor);
    }
    process.getuid = originalGetuid;
    fsState.externalHome = undefined;
  });

  it("bootstraps the boot-volume plist when HOME is on an external volume", async () => {
    Object.defineProperty(process, "platform", {
      ...originalPlatformDescriptor,
      value: "darwin",
    });
    process.getuid = () => 501;
    fsState.externalHome = "/Volumes/MainDataDrive";

    const scriptPath = await prepareRestartScript({
      HOME: fsState.externalHome,
      USER: "test",
      OPENCLAW_PROFILE: "default",
    });
    if (!scriptPath) {
      throw new Error("expected restart script path");
    }
    try {
      const content = await fs.readFile(scriptPath, "utf8");
      expect(content).toContain(
        "openclaw_launch_agent_plist='/Users/test/Library/LaunchAgents/ai.openclaw.gateway.plist'",
      );
      expect(content).toContain(`launchctl bootstrap 'gui/501' "$openclaw_launch_agent_plist"`);
      expect(content).not.toContain(
        "/Volumes/MainDataDrive/Library/LaunchAgents/ai.openclaw.gateway.plist",
      );
    } finally {
      await fs.rm(path.dirname(scriptPath), { recursive: true, force: true });
    }
  });

  it("refuses the detached handoff before user activation when a system owner appears", async () => {
    Object.defineProperty(process, "platform", {
      ...originalPlatformDescriptor,
      value: "darwin",
    });
    process.getuid = () => 501;
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-restart-system-"));
    const fakeBinDir = path.join(tmpDir, "bin");
    const stateDir = path.join(tmpDir, "state");
    const activationMarker = path.join(tmpDir, "activation-ran");
    await fs.mkdir(fakeBinDir, { recursive: true });
    await fs.writeFile(path.join(fakeBinDir, "sleep"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    await fs.writeFile(
      path.join(fakeBinDir, "launchctl"),
      `#!/bin/sh
if [ "$1" = "print" ] && [ "$2" = "system/ai.openclaw.gateway" ]; then
  exit 0
fi
printf activated > "$ACTIVATION_MARKER"
exit 0
`,
      { mode: 0o755 },
    );

    try {
      const scriptPath = await prepareRestartScript({
        OPENCLAW_PROFILE: "default",
        HOME: path.join(tmpDir, "home"),
        OPENCLAW_STATE_DIR: stateDir,
      });
      if (!scriptPath) {
        throw new Error("expected restart script path");
      }
      let exitCode: number | null = null;
      try {
        await execFileAsync("/bin/sh", [scriptPath], {
          env: {
            ...process.env,
            ACTIVATION_MARKER: activationMarker,
            PATH: `${fakeBinDir}:${process.env.PATH ?? ""}`,
          },
        });
      } catch (error) {
        const code = (error as { code?: unknown }).code;
        exitCode = typeof code === "number" ? code : null;
      }
      const log = await fs.readFile(path.join(stateDir, "logs", "gateway-restart.log"), "utf8");

      expect(exitCode).toBe(78);
      await expect(fs.access(activationMarker)).rejects.toMatchObject({ code: "ENOENT" });
      expect(log).toContain("openclaw restart blocked source=update");
      expect(log).toContain("loaded system LaunchDaemon system/ai.openclaw.gateway");
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
