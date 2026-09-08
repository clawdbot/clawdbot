import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  createBuiltRuntime,
  runBuiltRuntime,
} from "./doctor-config-preflight.process.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterAll);

describe("Doctor CLI migration refusal", () => {
  it.each([false, true])(
    "honors the ordered graph with valid TUI=%s",
    async (validTui) => {
      const root = fs.realpathSync(tempDirs.make("openclaw-doctor-refusal-"));
      const stateDir = path.join(root, "state");
      const configPath = path.join(root, "openclaw.json");
      const tuiPath = path.join(stateDir, "tui", "last-session.json");
      const approvalsPath = path.join(stateDir, "exec-approvals.json");
      const tuiRaw = validTui
        ? JSON.stringify({
            terminal: { sessionKey: "agent:main:tui:behavior-validator", updatedAt: 100 },
          }) + "\n"
        : "not json\n";
      const approvalsRaw =
        JSON.stringify({
          version: 1,
          defaults: { security: "allowlist", ask: "on-miss" },
          agents: { main: { allowlist: [{ pattern: "/usr/bin/rg" }] } },
        }) + "\n";
      fs.mkdirSync(path.dirname(tuiPath), { recursive: true });
      fs.writeFileSync(configPath, "{}\n");
      fs.writeFileSync(tuiPath, tuiRaw);
      fs.writeFileSync(approvalsPath, approvalsRaw);
      const runtimeRoot = createBuiltRuntime(root);
      const result = runBuiltRuntime(
        runtimeRoot,
        {
          PATH: process.env.PATH,
          HOME: root,
          USERPROFILE: root,
          OPENCLAW_STATE_DIR: stateDir,
          OPENCLAW_CONFIG_PATH: configPath,
          OPENCLAW_SERVICE_REPAIR_POLICY: "external",
          NO_COLOR: "1",
          CI: "1",
        },
        ["doctor", "--fix", "--non-interactive", "--no-workspace-suggestions"],
        60_000,
      );
      const output = `${result.stdout}\n${result.stderr}`;
      expect(result.error, output).toBeUndefined();
      expect(result.signal, output).toBeNull();
      const db = new DatabaseSync(path.join(stateDir, "state", "openclaw.sqlite"), {
        readOnly: true,
      });
      try {
        const approvals = db
          .prepare("SELECT raw_json FROM exec_approvals_config WHERE config_key = 'current'")
          .all();
        if (validTui) {
          expect(result.status, output).toBe(0);
          expect(output).toContain("Doctor complete.");
          expect(output.indexOf("TUI last-session pointer(s)")).toBeGreaterThanOrEqual(0);
          expect(output.indexOf("Imported legacy exec approvals")).toBeGreaterThan(
            output.indexOf("TUI last-session pointer(s)"),
          );
          expect(fs.existsSync(tuiPath)).toBe(false);
          expect(fs.existsSync(approvalsPath)).toBe(false);
          expect(approvals).toHaveLength(1);
        } else {
          expect(fs.existsSync(approvalsPath), output).toBe(true);
          expect(fs.readFileSync(approvalsPath, "utf8")).toBe(approvalsRaw);
          expect(fs.readFileSync(tuiPath, "utf8")).toBe(tuiRaw);
          expect(approvals).toEqual([]);
          expect(result.status, output).toBe(1);
          expect(output).toContain("Failed reading legacy TUI last-session state");
          expect(output).not.toContain("Imported legacy exec approvals");
          expect(output).not.toContain("Doctor complete.");
          expect(output).not.toContain("rerun doctor --fix");
        }
      } finally {
        db.close();
      }
    },
    60_000,
  );
});
