/** Tests pure Code Mode config without loading the guest or test runtime. */

import { describe, expect, it } from "vitest";
import { resolveCodeModeConfig } from "./code-mode-runtime.js";

describe("Code Mode configuration", () => {
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
    expect(resolved.enabled).toBe("auto");
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
    expect(configuredAgent.enabled).toBe("auto");
    expect(configuredAgent.timeoutMs).toBe(2345);
  });
});
