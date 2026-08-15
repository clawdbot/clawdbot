// Update restart handoff tests cover system-domain ownership checks at execution time.
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { prepareRestartScript } from "./restart-helper.js";

const execFileAsync = promisify(execFile);

describe("macOS update restart system ownership", () => {
  const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
  const originalGetuid = process.getuid;

  afterEach(() => {
    if (originalPlatformDescriptor) {
      Object.defineProperty(process, "platform", originalPlatformDescriptor);
    }
    process.getuid = originalGetuid;
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
