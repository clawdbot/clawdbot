/** Tests pure Code Mode config without loading the guest or test runtime. */

import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveCodeModeConfig } from "./code-mode-runtime.js";

describe("Code Mode configuration", () => {
  it.each<{
    name: string;
    global: boolean | "auto";
    model?: boolean;
    agent?: boolean | "auto";
    agentModel?: boolean;
    expected: boolean | "auto";
  }>([
    { name: "inherits the global default", global: "auto", expected: "auto" },
    { name: "model on overrides global off", global: false, model: true, expected: true },
    { name: "model off overrides global on", global: true, model: false, expected: false },
    {
      name: "agent default overrides model default",
      global: false,
      model: true,
      agent: false,
      expected: false,
    },
    {
      name: "agent model overrides agent default",
      global: false,
      model: false,
      agent: false,
      agentModel: true,
      expected: true,
    },
    {
      name: "agent model off overrides agent on",
      global: true,
      model: true,
      agent: true,
      agentModel: false,
      expected: false,
    },
    {
      name: "unset agent model inherits model default",
      global: false,
      model: true,
      expected: true,
    },
    {
      name: "agent auto overrides model default",
      global: false,
      model: true,
      agent: "auto",
      expected: "auto",
    },
  ])("$name", ({ global, model, agent, agentModel, expected }) => {
    const cfg: OpenClawConfig = {
      tools: { codeMode: { enabled: global, timeoutMs: 1234, maxOutputBytes: 4096 } },
      agents: {
        defaults: { models: { "test/model-a": { codeMode: model } } },
        entries: {
          ops: {
            tools: {
              codeMode: { ...(agent === undefined ? {} : { enabled: agent }), timeoutMs: 2345 },
            },
            models: { "test/model-a": { codeMode: agentModel, alias: "A" } },
          },
        },
      },
    };
    expect(
      resolveCodeModeConfig(cfg, "ops", { provider: "test", modelId: "model-a" }),
    ).toMatchObject({
      enabled: expected,
      timeoutMs: 2345,
      maxOutputBytes: 4096,
    });
    // A fallback model gets its own setting rather than the primary's override.
    expect(
      resolveCodeModeConfig(cfg, "ops", { provider: "test", modelId: "model-b" }).enabled,
    ).toBe(agent ?? global);
  });

  it("resolves object config defaults", () => {
    expect(resolveCodeModeConfig({ tools: { codeMode: true } } as never).enabled).toBe(true);
    const resolved = resolveCodeModeConfig({
      tools: {
        codeMode: {
          timeoutMs: 1234,
          languages: ["typescript"],
        },
      },
    } as never);
    expect(resolved.enabled).toBe(false);
    expect(resolveCodeModeConfig({ tools: { codeMode: { enabled: true } } } as never).enabled).toBe(
      true,
    );
    expect(resolved.runtime).toBe("quickjs-wasi");
    expect(resolved.mode).toBe("only");
    expect(resolved.timeoutMs).toBe(1234);
    expect(resolved.languages).toEqual(["typescript"]);
    const limitedSearch = resolveCodeModeConfig({
      tools: {
        codeMode: {
          enabled: true,
          maxSearchLimit: 3,
        },
      },
    } as never);
    expect(limitedSearch.searchDefaultLimit).toBe(3);
    expect(limitedSearch.maxSearchLimit).toBe(3);
  });

  it("resolves active-agent code mode over the runtime default", () => {
    const config = {
      tools: {
        codeMode: {
          enabled: false,
          timeoutMs: 1234,
          searchDefaultLimit: 6,
        },
      },
      agents: {
        list: [
          {
            id: "ops",
            tools: {
              codeMode: {
                enabled: true,
                searchDefaultLimit: 4,
              },
            },
          },
          {
            id: "chat",
            tools: {
              codeMode: false,
            },
          },
        ],
      },
    } as never;

    const ops = resolveCodeModeConfig(config, "ops");
    expect(ops.enabled).toBe(true);
    expect(ops.timeoutMs).toBe(1234);
    expect(ops.searchDefaultLimit).toBe(4);

    expect(resolveCodeModeConfig(config, "chat").enabled).toBe(false);
    expect(resolveCodeModeConfig(config, "missing").enabled).toBe(false);

    const configuredAgent = resolveCodeModeConfig(
      {
        agents: {
          entries: {
            ops: { tools: { codeMode: { timeoutMs: 2345 } } },
          },
        },
      } as never,
      "ops",
    );
    expect(configuredAgent.enabled).toBe(false);
    expect(configuredAgent.timeoutMs).toBe(2345);
  });
});
