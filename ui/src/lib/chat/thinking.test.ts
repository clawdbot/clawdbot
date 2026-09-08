import { describe, expect, it } from "vitest";
import type { ModelCatalogEntry } from "../../api/types.ts";
import {
  formatThinkingCommandOptionsForSession,
  isThinkingLevelOptionForSession,
  resolveChatThinkingSelectState,
  resolveThinkingCommandArgOptionsForSession,
  resolveThinkingLevelInput,
} from "./thinking.ts";

describe("chat thinking helpers", () => {
  it("keeps a ready empty thinking profile empty for the selected model", () => {
    const model: ModelCatalogEntry = {
      provider: "metadata-fixture",
      id: "no-effort",
      name: "No selectable effort",
      reasoning: true,
      agentRuntime: { id: "openclaw", source: "model" },
      thinkingLevels: [],
      thinkingDefault: "off",
    };
    const session = {
      modelProvider: model.provider,
      model: model.id,
      agentRuntime: model.agentRuntime,
      thinkingLevels: model.thinkingLevels,
      thinkingOptions: [],
      thinkingDefault: model.thinkingDefault,
    };
    const state = resolveChatThinkingSelectState({
      catalog: [model],
      session,
      sessionKey: "agent:main:main",
      sessionsResult: null,
    });

    expect({
      options: state.options.map((option) => option.value),
      acceptsHigh: isThinkingLevelOptionForSession(session, undefined, "high", [model]),
      inherited: state.inherited.value,
    }).toEqual({ options: [], acceptsHigh: false, inherited: "off" });
    expect(formatThinkingCommandOptionsForSession(session, undefined, [model])).toBe("default");
    expect(resolveThinkingCommandArgOptionsForSession(session, undefined, [model])).toEqual([]);
  });

  it.each(["catalog", "defaults", "session labels", "default labels"] as const)(
    "preserves explicitly empty %s metadata",
    (source) => {
      const model: ModelCatalogEntry = {
        provider: "metadata-fixture",
        id: "no-effort",
        name: "No selectable effort",
        reasoning: true,
        agentRuntime: { id: "openclaw", source: "model" },
        thinkingDefault: "off",
        ...(source === "catalog" ? { thinkingLevels: [] } : {}),
      };
      const session = {
        modelProvider: model.provider,
        model: model.id,
        agentRuntime: model.agentRuntime,
        thinkingDefault: model.thinkingDefault,
        ...(source === "session labels" ? { thinkingOptions: [] } : {}),
      };
      const defaults = {
        modelProvider: model.provider,
        model: model.id,
        agentRuntime: model.agentRuntime,
        contextTokens: null,
        thinkingDefault: model.thinkingDefault,
        ...(source === "defaults" ? { thinkingLevels: [] } : {}),
        ...(source === "default labels" ? { thinkingOptions: [] } : {}),
      };
      const state = resolveChatThinkingSelectState({
        catalog: [model],
        defaults,
        session,
        sessionKey: "agent:main:main",
        sessionsResult: null,
      });

      expect(state.options).toEqual([]);
      expect(isThinkingLevelOptionForSession(session, defaults, "high", [model])).toBe(false);
    },
  );

  it("retains generic choices while thinking metadata is missing", () => {
    const state = resolveChatThinkingSelectState({
      catalog: [],
      session: { modelProvider: "metadata-fixture", model: "loading" },
      sessionKey: "agent:main:main",
      sessionsResult: null,
    });

    expect(state.options.map((option) => option.value)).toEqual([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
    ]);
  });

  it("keeps non-reasoning Off-only metadata distinct from an empty profile", () => {
    const model: ModelCatalogEntry = {
      provider: "metadata-fixture",
      id: "plain",
      name: "Plain model",
      reasoning: false,
      thinkingLevels: [{ id: "off", label: "off" }],
      thinkingDefault: "off",
    };
    const session = { modelProvider: model.provider, model: model.id };
    const state = resolveChatThinkingSelectState({
      catalog: [model],
      session,
      sessionKey: "agent:main:main",
      sessionsResult: null,
    });

    expect(state.options).toEqual([]);
    expect(isThinkingLevelOptionForSession(session, undefined, "off", [model])).toBe(true);
    expect(isThinkingLevelOptionForSession(session, undefined, "high", [model])).toBe(false);
  });

  const lunaModel: ModelCatalogEntry = {
    id: "gpt-5.6-luna",
    name: "GPT-5.6 Luna",
    provider: "openai",
    reasoning: true,
    agentRuntime: { id: "openclaw", source: "model" },
    thinkingLevels: [
      { id: "max", label: "max" },
      { id: "ultra", label: "ultra" },
    ],
    thinkingDefault: "ultra",
  };

  it("normalizes canonical Ultra command input", () => {
    expect(
      resolveThinkingLevelInput(
        "ultra",
        {
          thinkingLevels: [{ id: "ultra", label: "Ultra" }],
        },
        undefined,
      ),
    ).toBe("ultra");
  });

  it("does not promote an unsupported persisted Ultra override into a slider stop", () => {
    const state = resolveChatThinkingSelectState({
      catalog: [],
      sessionKey: "agent:main:main",
      sessionsResult: {
        ts: 1,
        path: "",
        count: 1,
        defaults: { modelProvider: null, model: null, contextTokens: null },
        sessions: [
          {
            key: "agent:main:main",
            kind: "direct",
            updatedAt: 1,
            thinkingLevel: "ultra",
            thinkingLevels: [{ id: "max", label: "max" }],
          },
        ],
      },
    });

    expect(state.selection).toEqual({
      kind: "unanchored",
      source: "override",
      value: "ultra",
      displayLabel: "Ultra",
    });
    expect(state.options.map((option) => option.value)).toEqual(["max"]);
  });

  it.each([false, true])(
    "does not inherit same-model thinking metadata from a different runtime (catalog: %s)",
    (includeCatalog) => {
      const state = resolveChatThinkingSelectState({
        catalog: includeCatalog ? [lunaModel] : [],
        sessionKey: "agent:main:main",
        sessionsResult: {
          ts: 1,
          path: "",
          count: 1,
          defaults: {
            modelProvider: "openai",
            model: "gpt-5.6-luna",
            contextTokens: null,
            agentRuntime: { id: "openclaw", source: "model" },
            thinkingLevels: lunaModel.thinkingLevels,
            thinkingDefault: lunaModel.thinkingDefault,
          },
          sessions: [
            {
              key: "agent:main:main",
              kind: "direct",
              updatedAt: 1,
              modelProvider: "openai",
              model: "gpt-5.6-luna",
              agentRuntime: { id: "codex", source: "session-key" },
            },
          ],
        },
      });

      expect(state.options.map((option) => option.value)).not.toContain("ultra");
      expect(state.inherited.value).not.toBe("ultra");
    },
  );

  it.each([
    { sessionRuntime: "openclaw", catalogRuntime: "openclaw" },
    { sessionRuntime: undefined, catalogRuntime: "openclaw" },
    { sessionRuntime: "codex", catalogRuntime: undefined },
  ])(
    "inherits catalog thinking metadata when runtimes do not conflict ($sessionRuntime / $catalogRuntime)",
    ({ sessionRuntime, catalogRuntime }) => {
      const state = resolveChatThinkingSelectState({
        catalog: [
          {
            ...lunaModel,
            agentRuntime: catalogRuntime ? { id: catalogRuntime, source: "model" } : undefined,
          },
        ],
        sessionKey: "agent:main:main",
        session: {
          modelProvider: "openai",
          model: "gpt-5.6-luna",
          agentRuntime: sessionRuntime ? { id: sessionRuntime, source: "session-key" } : undefined,
        },
        sessionsResult: null,
      });

      expect(state.options.map((option) => option.value)).toEqual(["max", "ultra"]);
      expect(state.inherited.value).toBe("ultra");
    },
  );
});
