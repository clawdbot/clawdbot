// Sandbox config tests cover resolved agent sandbox settings after config
// normalization and timer-safe clamping.
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { AgentSandboxSchema } from "../../config/zod-schema.agent-runtime.js";
import { resolveSandboxConfigForAgent } from "./config.js";

describe("sandbox config", () => {
  it("defaults environment capability roots to deny and accepts exact workspace MCP requirements", () => {
    expect(resolveSandboxConfigForAgent().environment.capabilityRoots).toEqual([]);
    const sandbox = {
      environment: {
        capabilityRoots: [
          {
            id: "project-tools",
            location: { type: "workspace" as const },
            mcpServers: {
              remote: {
                command: "remote-mcp",
                args: ["--serve"],
                cwd: ".",
                env: { MODE: "safe" },
              },
            },
          },
        ],
      },
    };
    expect(AgentSandboxSchema.safeParse(sandbox).success).toBe(true);
    expect(
      resolveSandboxConfigForAgent({ agents: { defaults: { sandbox } } }).environment
        .capabilityRoots,
    ).toEqual(sandbox.environment.capabilityRoots);
  });

  it("rejects duplicate capability root ids and empty server grants", () => {
    const root = {
      id: "project-tools",
      location: { type: "workspace" },
      mcpServers: { remote: { command: "remote-mcp" } },
    };
    expect(
      AgentSandboxSchema.safeParse({
        environment: { capabilityRoots: [root, root] },
      }).success,
    ).toBe(false);
    expect(
      AgentSandboxSchema.safeParse({
        environment: { capabilityRoots: [{ ...root, mcpServers: {} }] },
      }).success,
    ).toBe(false);
  });

  it("tracks whether tmpfs came from defaults or explicit config", () => {
    expect(resolveSandboxConfigForAgent().dockerTmpfsSource).toBe("default");
    expect(
      resolveSandboxConfigForAgent({
        agents: {
          defaults: {
            sandbox: {
              docker: { tmpfs: ["/run"] },
            },
          },
        },
      }).dockerTmpfsSource,
    ).toBe("configured");
  });

  it("caps browser autostart timeout to a timer-safe delay", () => {
    // Browser startup timeouts flow into Node timers; huge config values must
    // not overflow or become immediate delays.
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          sandbox: {
            browser: {
              autoStartTimeoutMs: Number.MAX_SAFE_INTEGER,
            },
          },
        },
      },
    };

    expect(resolveSandboxConfigForAgent(cfg, "main").browser.autoStartTimeoutMs).toBe(
      MAX_TIMER_TIMEOUT_MS,
    );
  });
});
