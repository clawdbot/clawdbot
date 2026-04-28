import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearRuntimeAuthProfileStoreSnapshots } from "../agents/auth-profiles/store.js";
import { maybeRepairLegacyFlatAuthProfileStores } from "./doctor-auth-flat-profiles.js";
import type { DoctorPrompter } from "./doctor-prompter.js";

const roots: string[] = [];

function makeTempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-doctor-flat-auth-"));
  roots.push(root);
  return root;
}

function makePrompter(shouldRepair: boolean): DoctorPrompter {
  return {
    confirm: vi.fn(async () => shouldRepair),
    confirmAutoFix: vi.fn(async () => shouldRepair),
    confirmAggressiveAutoFix: vi.fn(async () => shouldRepair),
    confirmRuntimeRepair: vi.fn(async () => shouldRepair),
    select: vi.fn(async (_params, fallback) => fallback),
    shouldRepair,
    shouldForce: false,
    repairMode: {
      shouldRepair,
      shouldForce: false,
      nonInteractive: false,
      canPrompt: true,
      updateInProgress: false,
    },
  };
}

function withStateDir<T>(root: string, run: () => T): T {
  const previousStateDir = process.env.OPENCLAW_STATE_DIR;
  const previousAgentDir = process.env.OPENCLAW_AGENT_DIR;
  process.env.OPENCLAW_STATE_DIR = root;
  delete process.env.OPENCLAW_AGENT_DIR;
  try {
    return run();
  } finally {
    if (previousStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
    if (previousAgentDir === undefined) {
      delete process.env.OPENCLAW_AGENT_DIR;
    } else {
      process.env.OPENCLAW_AGENT_DIR = previousAgentDir;
    }
  }
}

afterEach(() => {
  clearRuntimeAuthProfileStoreSnapshots();
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("maybeRepairLegacyFlatAuthProfileStores", () => {
  it("rewrites legacy flat auth-profiles.json stores with a backup", async () => {
    const root = makeTempRoot();
    await withStateDir(root, async () => {
      const agentDir = path.join(root, "agents", "main", "agent");
      fs.mkdirSync(agentDir, { recursive: true });
      const authPath = path.join(agentDir, "auth-profiles.json");
      const legacy = {
        "ollama-windows": {
          apiKey: "ollama-local",
          baseUrl: "http://10.0.2.2:11434/v1",
        },
      };
      fs.writeFileSync(authPath, `${JSON.stringify(legacy)}\n`, "utf8");

      const result = await maybeRepairLegacyFlatAuthProfileStores({
        cfg: {},
        prompter: makePrompter(true),
        now: () => 123,
      });

      expect(result.detected).toEqual([authPath]);
      expect(result.changes).toHaveLength(1);
      expect(result.warnings).toEqual([]);
      expect(JSON.parse(fs.readFileSync(authPath, "utf8"))).toEqual({
        version: 1,
        profiles: {
          "ollama-windows:default": {
            type: "api_key",
            provider: "ollama-windows",
            key: "ollama-local",
          },
        },
      });
      expect(JSON.parse(fs.readFileSync(`${authPath}.legacy-flat.123.bak`, "utf8"))).toEqual(
        legacy,
      );
    });
  });

  it("reports legacy flat stores without rewriting when repair is declined", async () => {
    const root = makeTempRoot();
    await withStateDir(root, async () => {
      const agentDir = path.join(root, "agents", "main", "agent");
      fs.mkdirSync(agentDir, { recursive: true });
      const authPath = path.join(agentDir, "auth-profiles.json");
      const legacy = {
        openai: {
          apiKey: "sk-openai",
        },
      };
      fs.writeFileSync(authPath, `${JSON.stringify(legacy)}\n`, "utf8");

      const result = await maybeRepairLegacyFlatAuthProfileStores({
        cfg: {},
        prompter: makePrompter(false),
      });

      expect(result.detected).toEqual([authPath]);
      expect(result.changes).toEqual([]);
      expect(result.warnings).toEqual([]);
      expect(JSON.parse(fs.readFileSync(authPath, "utf8"))).toEqual(legacy);
    });
  });
});
