// Process regression for Gateway startup signal ownership and lease cleanup.
import { execFile } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

describe("gateway startup signal owner", () => {
  it("aborts startup work on SIGTERM and releases the plugin lifecycle lease", async () => {
    const signalModule = new URL("./startup-signal.ts", import.meta.url).href;
    const leaseModule = new URL("../../plugins/plugin-lifecycle-lease.ts", import.meta.url).href;
    const script = `
      const { installGatewayStartupSignalOwner } = await import(${JSON.stringify(signalModule)});
      const { withPluginLifecycleLease } = await import(${JSON.stringify(leaseModule)});
      const { DatabaseSync } = await import("node:sqlite");
      const statePath = process.env.OPENCLAW_STATE_DIR + "/state/openclaw.sqlite";
      const owner = installGatewayStartupSignalOwner();
      const operation = withPluginLifecycleLease(
        { env: process.env, signal: owner.signal, leaseMs: 60_000, waitMs: 1_000 },
        async (lease) => {
          console.log("__LEASE_ACQUIRED__");
          setTimeout(() => process.kill(process.pid, "SIGTERM"), 25);
          await new Promise((resolve, reject) => {
            const timer = setTimeout(resolve, 30_000);
            lease.signal.addEventListener("abort", () => {
              clearTimeout(timer);
              reject(lease.signal.reason);
            }, { once: true });
          });
        },
      );
      await operation.catch((error) => {
        console.error("__ABORTED__", error?.code ?? error?.name ?? String(error));
      });
      const database = new DatabaseSync(statePath, { readOnly: true });
      const lease = database.prepare(
        "SELECT 1 FROM state_leases WHERE scope = 'core:plugin-lifecycle' AND lease_key = 'global'",
      ).get();
      database.close();
      console.log("__RESULT__" + JSON.stringify({
        aborted: owner.signal.aborted,
        exitCode: process.exitCode,
        leaseActive: Boolean(lease),
      }));
      owner.dispose();
      process.exitCode = 0;
    `;
    const root = path.resolve(".");
    const result = await execFileAsync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "--eval", script],
      {
        cwd: root,
        env: {
          ...process.env,
          HOME: process.env.HOME,
          OPENCLAW_STATE_DIR: `/tmp/openclaw-startup-signal-${process.pid}`,
          OPENCLAW_TEST_FAST: "1",
          NO_COLOR: "1",
        },
        encoding: "utf8",
        timeout: 10_000,
      },
    );
    const output = `${result.stderr}\n${result.stdout}`;
    expect(output).toContain("__LEASE_ACQUIRED__");
    expect(output).toContain("__ABORTED__");
    const resultLine = result.stdout.split("\n").find((line) => line.startsWith("__RESULT__"));
    expect(resultLine, output).toBeDefined();
    expect(JSON.parse(resultLine!.slice("__RESULT__".length))).toEqual({
      aborted: true,
      exitCode: 143,
      leaseActive: false,
    });
  }, 20_000);
});
