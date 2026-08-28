import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildWindowsCmdExeCommandLine,
  resolveTrustedWindowsCmdExe,
} from "../process/windows-command.js";
import { withTempDir } from "../test-utils/temp-dir.js";
import {
  createSourceCliFixture,
  runSourceCliProbe,
} from "./openclaw-cli-invocation.test-support.js";
import { clearGatewayAgentCliShim, prepareGatewayAgentCliShim } from "./openclaw-cli-shim.js";

afterEach(() => {
  clearGatewayAgentCliShim();
});

describe.skipIf(process.platform !== "win32")("native Windows source CLI shim", () => {
  it.each(["off", "on"])(
    "preserves source paths and caller cwd with delayed expansion %s",
    async (delayedExpansion) => {
      await withTempDir("openclaw-source-cli-win-", async (root) => {
        const fixture = await createSourceCliFixture(root);
        const control = runSourceCliProbe(
          fixture.invocation.command,
          [...fixture.invocation.args, "--profile", "work", "probe"],
          fixture.checkout,
        );
        expect(control.status, control.stderr).toBe(0);
        expect(JSON.parse(control.stdout)).toMatchObject({
          source: "gateway",
          args: ["--profile", "work", "probe"],
          cwd: fixture.checkout,
        });

        const stateDir = path.join(root, "state");
        await prepareGatewayAgentCliShim({
          env: { OPENCLAW_PROFILE: "work" },
          invocation: fixture.invocation,
          stateDir,
        });
        const shimPath = path.join(stateDir, "tmp", "agent-cli", "openclaw.cmd");
        const command = buildWindowsCmdExeCommandLine(shimPath, ["probe"]);
        const result = runSourceCliProbe(
          resolveTrustedWindowsCmdExe(),
          ["/d", `/v:${delayedExpansion}`, "/s", "/c", command],
          fixture.callerCwd,
          { windowsVerbatimArguments: true },
        );
        expect(result.status, result.stderr).toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({
          source: "gateway",
          args: ["--profile", "work", "probe"],
          cwd: fixture.callerCwd,
          tsconfigPath: path.join(fixture.checkout, "tsconfig.json"),
        });
      });
    },
  );
});
