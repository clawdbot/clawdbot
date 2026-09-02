import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { formatCliProcessFailure, runCliProcessChild } from "./cli-process-child.test-helpers.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const fixture = fileURLToPath(
  new URL("./update-finalization-output.test-support.ts", import.meta.url),
);
const doctorDiagnostics = [
  "OpenClaw doctor",
  "Doctor panel diagnostic",
  "Doctor workspace diagnostic",
  "Doctor console diagnostic",
  "Doctor complete.",
];
const scenarios = [
  "json",
  "inherited-json",
  "doctor-error",
  "plugin-error",
  "human",
  "human-plugin-error",
  "human-plugin-warning",
];

describe.each(["repair", "finalize"])("update %s process output", (command) => {
  it.each(scenarios)(
    "%s preserves the output and exit contract without restarting",
    async (scenario) => {
      const root = tempDirs.make("openclaw-update-json-");
      const state = path.join(root, "state");
      const config = path.join(root, "openclaw.json");
      const workspace = path.join(root, "workspace");
      const server = net.createServer();
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Missing isolated port");
      }
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      expect(address.port).not.toBe(18789);
      await fs.mkdir(state);
      await fs.mkdir(workspace);
      await fs.writeFile(
        config,
        JSON.stringify({
          gateway: { mode: "local", port: address.port, auth: { mode: "none" } },
          plugins: { enabled: false, allow: [] },
          agents: { defaults: { workspace } },
          logging: { file: path.join(root, "openclaw.log") },
        }),
      );
      const json = !scenario.startsWith("human");
      const args = [
        "update",
        ...(scenario === "inherited-json" ? ["--json"] : []),
        command,
        "--channel",
        "dev",
        "--yes",
        "--no-restart",
        "--timeout",
        "9",
        ...(json && scenario !== "inherited-json" ? ["--json"] : []),
      ];
      const result = await runCliProcessChild({
        nodeArgs: ["--import", "tsx", fixture, scenario, ...args],
        env: {
          ESBUILD_WORKER_THREADS: "0",
          PATH: path.dirname(process.execPath),
          HOME: root,
          USERPROFILE: root,
          OPENCLAW_HOME: root,
          OPENCLAW_STATE_DIR: state,
          OPENCLAW_CONFIG_PATH: config,
          OPENCLAW_SERVICE_REPAIR_POLICY: "external",
          OPENCLAW_GATEWAY_PORT: String(address.port),
          XDG_CONFIG_HOME: path.join(root, "xdg-config"),
          XDG_DATA_HOME: path.join(root, "xdg-data"),
          XDG_CACHE_HOME: path.join(root, "xdg-cache"),
          XDG_STATE_HOME: path.join(root, "xdg-state"),
          XDG_RUNTIME_DIR: path.join(root, "xdg-runtime"),
          TMPDIR: root,
          NODE_DISABLE_COMPILE_CACHE: "1",
          NO_COLOR: "1",
          TERM: "dumb",
        },
      });
      const failure = formatCliProcessFailure({ reason: `${command} ${scenario}`, ...result });
      expect(result.signal, failure).toBeNull();
      expect(result.code, failure).toBe(scenario.endsWith("error") ? 1 : 0);
      const diagnostics = json ? result.stderr : result.stdout;
      for (const diagnostic of doctorDiagnostics) {
        expect(diagnostics, failure).toContain(diagnostic);
      }
      expect(diagnostics.match(/Doctor console diagnostic/gu), failure).toHaveLength(1);
      expect(result.stderr, failure).toContain("Doctor stderr diagnostic");
      const triageNotice = "Update failed. Entering triage...";
      if (!scenario.endsWith("error")) {
        expect(result.stdout + result.stderr, failure).not.toContain(triageNotice);
        expect(result.stdout + result.stderr, failure).not.toContain("triage-fixture-prompt.md");
      }
      if (!json) {
        const terminal =
          scenario === "human-plugin-error"
            ? "Update finalization failed."
            : scenario === "human-plugin-warning"
              ? "Update finalization completed with warnings."
              : "Update finalization completed.";
        if (scenario === "human-plugin-error") {
          expect(result.stdout, failure).toContain(terminal);
          const triageIndex = result.stdout.indexOf(triageNotice);
          const promptIndex = result.stdout.indexOf("Debugging prompt:");
          const guidanceIndex = result.stdout.indexOf("Ready-to-run agent handoffs:");
          expect(triageIndex, failure).toBeGreaterThan(result.stdout.indexOf(terminal));
          expect(promptIndex, failure).toBeGreaterThan(triageIndex);
          expect(guidanceIndex, failure).toBeGreaterThan(promptIndex);
          expect(result.stdout.trimEnd().endsWith("openclaw triage --run"), failure).toBe(true);
        } else {
          expect(result.stdout.trimEnd().endsWith(terminal), failure).toBe(true);
        }
        return;
      }
      // Parse the whole pipe: accepting a suffix would hide Clack's direct stdout writes.
      const output = JSON.parse(result.stdout);
      if (scenario.endsWith("error")) {
        expect(result.stderr, failure).toContain(triageNotice);
        expect(result.stderr, failure).toContain('"promptPath":');
        expect(result.stderr, failure).toContain("triage-fixture-prompt.md");
        expect(result.stderr, failure).not.toContain("Triage could not complete:");
        expect(result.stdout, failure).not.toContain("triage-fixture-prompt.md");
      }
      if (scenario === "doctor-error") {
        expect(output).toMatchObject({
          ok: false,
          error: { type: "cli_error", message: expect.stringContaining("Doctor repair failed") },
        });
      } else {
        expect(output).toMatchObject({
          status: scenario === "plugin-error" ? "error" : "ok",
          mode: "finalize",
          restart: false,
          channel: "dev",
          postUpdate: { doctor: { status: "ok" } },
        });
      }
    },
  );
});
