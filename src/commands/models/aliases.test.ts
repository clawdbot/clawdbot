import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { RuntimeEnv } from "../../runtime.js";
import { modelsAliasesListCommand, modelsAliasesRemoveCommand } from "./aliases.js";

const mocks = vi.hoisted(() => ({
  readConfigFileSnapshot: vi.fn(),
  replaceConfigFile: vi.fn(),
  loadModelsConfig: vi.fn(),
}));

vi.mock("../../config/config.js", () => ({
  readConfigFileSnapshot: (...args: unknown[]) => mocks.readConfigFileSnapshot(...args),
  replaceConfigFile: (...args: unknown[]) => mocks.replaceConfigFile(...args),
}));

vi.mock("./load-config.js", () => ({
  loadModelsConfig: (...args: unknown[]) => mocks.loadModelsConfig(...args),
}));

function makeRuntime(): RuntimeEnv & { logs: string[] } {
  const logs: string[] = [];
  return {
    log: (...args: unknown[]) => {
      logs.push(args.map((a) => String(a)).join(" "));
    },
    error: () => {},
    exit: () => {},
    logs,
  };
}

function snapshot(sourceConfig: OpenClawConfig) {
  return {
    valid: true,
    hash: "snapshot-hash",
    sourceConfig,
    config: sourceConfig,
    runtimeConfig: sourceConfig,
  };
}

describe("modelsAliasesRemoveCommand", () => {
  beforeEach(() => {
    mocks.readConfigFileSnapshot.mockReset();
    mocks.replaceConfigFile.mockReset();
    mocks.loadModelsConfig.mockReset();
  });

  it("removes a user-added alias from the source config", async () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          models: {
            "openai/gpt-5.4-mini": { alias: "my-fav" },
          },
        },
      },
    } as unknown as OpenClawConfig;
    mocks.readConfigFileSnapshot.mockResolvedValue(snapshot(cfg));
    mocks.replaceConfigFile.mockResolvedValue(undefined);

    await modelsAliasesRemoveCommand("my-fav", makeRuntime());

    expect(mocks.replaceConfigFile).toHaveBeenCalledOnce();
    const [replaceParams] = mocks.replaceConfigFile.mock.calls[0] ?? [];
    const written = replaceParams?.nextConfig as OpenClawConfig;
    expect(written.agents?.defaults?.models?.["openai/gpt-5.4-mini"]?.alias).toBeUndefined();
  });

  it("rejects removal of a built-in alias visible only via materialized defaults", async () => {
    // Source config: model entry exists but no user-set alias. applyModelDefaults
    // would materialize `gpt-mini -> openai/gpt-5.4-mini` into the resolved config,
    // so `list` shows it, but it is not stored in the source config.
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          models: {
            "openai/gpt-5.4-mini": {},
          },
        },
      },
    } as unknown as OpenClawConfig;
    mocks.readConfigFileSnapshot.mockResolvedValue(snapshot(cfg));

    await expect(modelsAliasesRemoveCommand("gpt-mini", makeRuntime())).rejects.toThrow(
      /built-in alias for "openai\/gpt-5\.4-mini"/,
    );
    expect(mocks.replaceConfigFile).not.toHaveBeenCalled();
  });

  it("rejects removal of a built-in alias whose target only matches after key normalization", async () => {
    // Source config holds a retired Google preview key. applyModelDefaults normalizes
    // `google/gemini-3-pro-preview` to `google/gemini-3.1-pro-preview` before materializing
    // the `gemini` built-in alias (see src/config/model-alias-defaults.test.ts:135-144), so
    // `list` shows `gemini`. `remove gemini` must compare against the normalized key and
    // return the actionable built-in error, not the misleading generic "Alias not found".
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          models: {
            "google/gemini-3-pro-preview": {},
          },
        },
      },
    } as unknown as OpenClawConfig;
    mocks.readConfigFileSnapshot.mockResolvedValue(snapshot(cfg));

    await expect(modelsAliasesRemoveCommand("gemini", makeRuntime())).rejects.toThrow(
      /built-in alias for "google\/gemini-3\.1-pro-preview"/,
    );
    expect(mocks.replaceConfigFile).not.toHaveBeenCalled();
  });

  it("falls back to 'Alias not found' when the user explicitly disables a built-in via alias: \"\"", async () => {
    // Source config sets an explicit empty alias on the target. applyModelDefaults
    // honors the opt-out (see src/config/defaults.ts:337 and src/config/model-alias-defaults.test.ts:106),
    // so `list` does not show `gemini` and `remove gemini` should return the plain
    // not-found error rather than the "built-in alias" error.
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          models: {
            "google/gemini-3.1-pro-preview": { alias: "" },
          },
        },
      },
    } as unknown as OpenClawConfig;
    mocks.readConfigFileSnapshot.mockResolvedValue(snapshot(cfg));

    await expect(modelsAliasesRemoveCommand("gemini", makeRuntime())).rejects.toThrow(
      /Alias not found: gemini/,
    );
    expect(mocks.replaceConfigFile).not.toHaveBeenCalled();
  });

  it("falls back to 'Alias not found' when the alias is neither user-added nor a materialized built-in", async () => {
    const cfg: OpenClawConfig = {
      agents: { defaults: { models: {} } },
    } as unknown as OpenClawConfig;
    mocks.readConfigFileSnapshot.mockResolvedValue(snapshot(cfg));

    await expect(modelsAliasesRemoveCommand("does-not-exist", makeRuntime())).rejects.toThrow(
      /Alias not found: does-not-exist/,
    );
    // gpt-mini is a built-in alias *name* but its target model isn't in source config,
    // so list wouldn't show it and the error should be the plain "Alias not found".
    await expect(modelsAliasesRemoveCommand("gpt-mini", makeRuntime())).rejects.toThrow(
      /Alias not found: gpt-mini/,
    );
  });

  it("removes a user alias that shadows a built-in name (user-set wins)", async () => {
    // User has explicitly set `gpt-mini` as the alias for a different target.
    // applyModelDefaults skips entries with an existing alias, so the user-set
    // alias is what `list` shows and `remove` should remove it normally.
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          models: {
            "openai/gpt-5.4-nano": { alias: "gpt-mini" },
          },
        },
      },
    } as unknown as OpenClawConfig;
    mocks.readConfigFileSnapshot.mockResolvedValue(snapshot(cfg));
    mocks.replaceConfigFile.mockResolvedValue(undefined);

    await modelsAliasesRemoveCommand("gpt-mini", makeRuntime());

    expect(mocks.replaceConfigFile).toHaveBeenCalledOnce();
    const [replaceParams] = mocks.replaceConfigFile.mock.calls[0] ?? [];
    const written = replaceParams?.nextConfig as OpenClawConfig;
    expect(written.agents?.defaults?.models?.["openai/gpt-5.4-nano"]?.alias).toBeUndefined();
  });
});

describe("modelsAliasesListCommand <-> modelsAliasesRemoveCommand agreement", () => {
  beforeEach(() => {
    mocks.readConfigFileSnapshot.mockReset();
    mocks.replaceConfigFile.mockReset();
    mocks.loadModelsConfig.mockReset();
  });

  it("any alias remove succeeds OR returns an explanatory error — never a misleading 'not found' for a listed alias", async () => {
    // Resolved config (what `list` reads) has the materialized built-in.
    const resolvedCfg: OpenClawConfig = {
      agents: {
        defaults: {
          models: {
            "google/gemini-3.1-pro-preview": { alias: "gemini" },
            "openai/gpt-5.4-mini": { alias: "my-fav" },
          },
        },
      },
    } as unknown as OpenClawConfig;
    // Source config (what `remove` mutates) only has the user-set alias.
    const sourceCfg: OpenClawConfig = {
      agents: {
        defaults: {
          models: {
            "google/gemini-3.1-pro-preview": {},
            "openai/gpt-5.4-mini": { alias: "my-fav" },
          },
        },
      },
    } as unknown as OpenClawConfig;

    mocks.loadModelsConfig.mockResolvedValue(resolvedCfg);
    mocks.readConfigFileSnapshot.mockResolvedValue({
      valid: true,
      hash: "h",
      sourceConfig: sourceCfg,
      config: sourceCfg,
      runtimeConfig: resolvedCfg,
    });
    mocks.replaceConfigFile.mockResolvedValue(undefined);

    const listRuntime = makeRuntime();
    await modelsAliasesListCommand({}, listRuntime);
    const listed = listRuntime.logs
      .filter((line) => line.startsWith("- "))
      .map((line) => line.slice(2).split(" -> ")[0]);
    expect(listed).toContain("gemini");
    expect(listed).toContain("my-fav");

    for (const alias of listed) {
      mocks.replaceConfigFile.mockClear();
      const removeRuntime = makeRuntime();
      const result = await modelsAliasesRemoveCommand(
        expectDefined(alias, "alias test invariant"),
        removeRuntime,
      ).then(
        () => ({ ok: true as const }),
        (err: unknown) => ({
          ok: false as const,
          message: err instanceof Error ? err.message : String(err),
        }),
      );
      if (result.ok) {
        // User-added: should have written the new config.
        expect(mocks.replaceConfigFile).toHaveBeenCalledOnce();
      } else {
        // Built-in: must NOT produce the misleading generic "Alias not found" error,
        // because `list` clearly showed it. Must be the actionable built-in message.
        expect(result.message).not.toMatch(/^Alias not found:/);
        expect(result.message).toMatch(/built-in alias/);
      }
    }
  });
});
