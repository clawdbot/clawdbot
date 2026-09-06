// Verifies chat-facing CLI snippets execute the OpenClaw CLI even from harness-hosted gateways.
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import {
  createSourceCliFixture,
  runSourceCliProbe,
  withSourceCliParent,
} from "../../infra/openclaw-cli-invocation.test-support.js";
import { withTempDir } from "../../test-utils/temp-dir.js";
import { buildCurrentOpenClawCliExecRequest } from "./commands-openclaw-cli.js";

describe("buildCurrentOpenClawCliExecRequest", () => {
  it("delegates launch policy while keeping shell rendering local", () => {
    const args = ["sessions", "export-trajectory"];
    const { argv, command } = buildCurrentOpenClawCliExecRequest(args);
    expect(argv.at(-2)).toBe("sessions");
    expect(argv.at(-1)).toBe("export-trajectory");
    expect(command).toBe(argv.map((value) => `'${value}'`).join(" "));
  });

  it("clears inherited Vitest runner environment for CLI child processes", () => {
    const { env } = buildCurrentOpenClawCliExecRequest([], {
      PATH: "/usr/bin",
      VITEST: "true",
      VITEST_POOL_ID: "pool",
      OPENCLAW_VITEST_MAX_WORKERS: "1",
    });
    expect(env).toMatchObject({
      VITEST: "",
      VITEST_POOL_ID: "",
      OPENCLAW_VITEST_MAX_WORKERS: "",
    });
    expect(env).not.toHaveProperty("PATH");
  });

  it("resolves source workspace imports in reconstructed commands outside the checkout", async () => {
    await withTempDir("openclaw-chat-cli-source-", async (root) => {
      const fixture = await createSourceCliFixture(root);
      const args = ["sessions", "export-trajectory"];
      const { argv, env } = withSourceCliParent(fixture, () =>
        buildCurrentOpenClawCliExecRequest(args),
      );
      const command = expectDefined(argv[0], "CLI invocation executable");
      const control = runSourceCliProbe(command, argv.slice(1), fixture.checkout, { env });
      expect(control.status, control.stderr).toBe(0);

      const external = runSourceCliProbe(command, argv.slice(1), fixture.callerCwd, { env });
      expect(external.status, external.stderr).toBe(0);
      expect(JSON.parse(external.stdout)).toMatchObject({
        source: "gateway",
        args,
        cwd: fixture.callerCwd,
      });
    });
  });

  it.skipIf(process.platform === "win32")(
    "resolves source workspace imports in a shell-rendered diagnostics command",
    async () => {
      await withTempDir("openclaw-chat-cli-shell-", async (root) => {
        const fixture = await createSourceCliFixture(root);
        const args = ["gateway", "diagnostics", "export", "--json"];
        const { command, env } = withSourceCliParent(fixture, () =>
          buildCurrentOpenClawCliExecRequest(args),
        );
        const result = runSourceCliProbe("/bin/sh", ["-c", command], fixture.callerCwd, { env });
        expect(result.status, result.stderr).toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({
          source: "gateway",
          args,
          cwd: fixture.callerCwd,
        });
      });
    },
  );
});
