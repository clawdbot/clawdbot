import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it } from "vitest";
import { crabboxCommandError } from "./crabbox-worker-command-error.js";
import { createCrabboxNodeEnrollmentSetup } from "./crabbox-worker-node-enrollment.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe.skipIf(process.platform === "win32")("worker bootstrap diagnostics", () => {
  it.each(["file", "symlink", "version failure", "absent"] as const)(
    "explains an unusable global install (%s) after registry failures",
    (kind) => {
      const home = fs.realpathSync(tempDirs.make("crabbox-bootstrap-"));
      const bin = path.join(home, "bin");
      fs.mkdirSync(bin);
      const cli = path.join(bin, "openclaw");
      if (kind !== "absent") {
        const target = kind === "symlink" ? path.join(home, "openclaw.mjs") : cli;
        fs.writeFileSync(
          target,
          "#!/bin/sh\necho 'runtime dependency: Permission denied' >&2\nexit 1\n",
          {
            mode: kind === "version failure" ? 0o700 : 0o600,
          },
        );
        if (kind === "symlink") {
          fs.symlinkSync(target, cli);
        }
      }
      fs.writeFileSync(
        path.join(bin, "npx"),
        [
          "#!/bin/sh",
          'printf "%s\\n" "$3" >>"$HOME/candidates"',
          'if [ "$3" = first ]; then echo "first candidate failure" >&2; else',
          '  printf "%02000d\\n" 0 >&2',
          '  echo "npm E404 last candidate missing; token=synthetic-registry-secret" >&2',
          "fi",
          "exit 1",
        ].join("\n"),
        { mode: 0o700 },
      );
      const setup = createCrabboxNodeEnrollmentSetup({
        leaseId: "cbx_test",
        enrollment: {
          mode: "connect",
          setupCode: "synthetic-setup-secret",
          setupId: "setup-test",
          openclawVersion: "2026.8.1",
          packageSpecs: ["first", "last"],
          displayName: "Bootstrap test",
          waitForDeviceId: async () => "device-test",
        },
      });
      const result = spawnSync("/bin/sh", [], {
        input: setup.command,
        encoding: "utf8",
        timeout: 10_000,
        env: { HOME: home, PATH: `${bin}:/usr/bin:/bin`, ...setup.forwardedEnv },
      });
      expect(result.status).toBe(1);
      expect(fs.readFileSync(path.join(home, "candidates"), "utf8")).toBe("first\nlast\n");
      const error = crabboxCommandError("node enrollment setup", {
        code: result.status,
        stdout: "setup progress ".repeat(200),
        stderr: result.stderr,
        signal: null,
        killed: false,
        termination: "exit",
      });
      expect(error.message).not.toContain("synthetic-registry-secret");
      expect(error.message).not.toContain("synthetic-setup-secret");
      expect(error.message.length).toBeLessThanOrEqual(570);
      if (kind === "file" || kind === "symlink") {
        expect(error.message).toContain("not readable/executable by node user");
        expect(error.message).toContain(cli);
        expect(error.message).toContain("-rw-------");
        expect(error.message).toContain("umask 022");
      } else if (kind === "version failure") {
        expect(error.message).toContain("runtime dependency: Permission denied");
      } else {
        expect(error.message).toContain("npm E404 last candidate missing");
        expect(error.message).not.toContain("first candidate failure");
      }
      const stateDir = path.join(home, ".openclaw", "cloud-workers", "cbx_test");
      expect(fs.existsSync(path.join(stateDir, "node.pid"))).toBe(false);
      expect(fs.statSync(path.join(stateDir, "setup-code")).mode & 0o777).toBe(0o600);
    },
  );
});
