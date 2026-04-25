import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../runtime.js";
import { runCrestodian } from "./crestodian.js";

function createRuntime(): { runtime: RuntimeEnv; lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    runtime: {
      log: (...args) => lines.push(args.join(" ")),
      error: (...args) => lines.push(args.join(" ")),
      exit: (code) => {
        throw new Error(`exit ${code}`);
      },
    },
  };
}

describe("runCrestodian", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses the assistant planner only to choose typed operations", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "crestodian-run-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", tempDir);
    vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(tempDir, "openclaw.json"));
    const { runtime, lines } = createRuntime();
    const runGatewayRestart = vi.fn(async () => {});

    await runCrestodian(
      {
        message: "the local bridge looks sleepy, poke it",
        deps: { runGatewayRestart },
        planWithAssistant: async () => ({
          reply: "I can queue a Gateway restart.",
          command: "restart gateway",
          modelLabel: "openai/gpt-5.5",
        }),
      },
      runtime,
    );

    expect(runGatewayRestart).not.toHaveBeenCalled();
    expect(lines.join("\n")).toContain("[crestodian] planner: openai/gpt-5.5");
    expect(lines.join("\n")).toContain("[crestodian] interpreted: restart gateway");
    expect(lines.join("\n")).toContain("Plan: restart the Gateway. Say yes to apply.");
  });

  it("keeps deterministic parsing ahead of the assistant planner", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "crestodian-run-deterministic-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", tempDir);
    vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(tempDir, "openclaw.json"));
    const { runtime, lines } = createRuntime();
    const planner = vi.fn(async () => ({ command: "restart gateway" }));

    await runCrestodian(
      {
        message: "models",
        planWithAssistant: planner,
      },
      runtime,
    );

    expect(planner).not.toHaveBeenCalled();
    expect(lines.join("\n")).toContain("Default model:");
  });
});
