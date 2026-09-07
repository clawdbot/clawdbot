/** Tests storage scan path discovery for non-main configured default agents. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { listAgentModelsJsonPaths } from "./storage-scan.js";

describe("storage scan default agent paths", () => {
  let rootDir: string;
  let stateDir: string;

  beforeEach(() => {
    rootDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-storage-scan-default-")),
    );
    stateDir = path.join(rootDir, ".openclaw");
    fs.mkdirSync(path.join(stateDir, "agents", "nova", "agent"), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it("uses the configured default agent dir instead of hardcoded main for models", () => {
    const config = {
      agents: {
        list: [{ id: "utility" }, { id: "nova", default: true }],
      },
    } satisfies OpenClawConfig;

    expect(listAgentModelsJsonPaths(config, stateDir, {})).toContain(
      path.join(stateDir, "agents", "nova", "agent", "models.json"),
    );
    expect(listAgentModelsJsonPaths(config, stateDir, {})).not.toContain(
      path.join(stateDir, "agents", "main", "agent", "models.json"),
    );
  });

  it("keeps discovered legacy and configured external model paths", () => {
    const externalAgentDir = path.join(rootDir, "external-agent");
    fs.mkdirSync(path.join(stateDir, "agents", "main", "agent"), { recursive: true });
    const config = {
      agents: {
        list: [
          { id: "nova", default: true },
          { id: "external", agentDir: externalAgentDir },
        ],
      },
    } satisfies OpenClawConfig;

    expect(listAgentModelsJsonPaths(config, stateDir, {})).toEqual(
      expect.arrayContaining([
        path.join(stateDir, "agents", "main", "agent", "models.json"),
        path.join(externalAgentDir, "models.json"),
      ]),
    );
  });

  it("scans explicitly owned agents without requiring a default", () => {
    const externalAgentDir = path.join(rootDir, "external-agent");
    const activeAgentDir = path.join(rootDir, "active-agent");
    fs.mkdirSync(path.join(stateDir, "agents", "discovered", "agent"), { recursive: true });
    const config = {
      agents: {
        ownership: "explicit",
        entries: {
          utility: {},
          external: { agentDir: externalAgentDir },
        },
      },
    } satisfies OpenClawConfig;

    const paths = listAgentModelsJsonPaths(config, stateDir, {
      OPENCLAW_AGENT_DIR: activeAgentDir,
    });

    expect(paths).toEqual(
      expect.arrayContaining([
        path.join(stateDir, "agents", "utility", "agent", "models.json"),
        path.join(stateDir, "agents", "discovered", "agent", "models.json"),
        path.join(externalAgentDir, "models.json"),
        path.join(activeAgentDir, "models.json"),
      ]),
    );
    expect(paths).not.toContain(path.join(stateDir, "agents", "main", "agent", "models.json"));
  });
});
