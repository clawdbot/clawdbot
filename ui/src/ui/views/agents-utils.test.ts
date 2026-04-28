import { describe, expect, it } from "vitest";
import {
  agentLogoUrl,
  assistantAvatarFallbackUrl,
  buildAgentContext,
  resolveConfiguredCronModelSuggestions,
  resolveAgentAvatarUrl,
  resolveAssistantTextAvatar,
  resolveChatAvatarRenderUrl,
  resolveEffectiveModelFallbacks,
  sortLocaleStrings,
} from "./agents-utils.ts";

describe("resolveEffectiveModelFallbacks", () => {
  it("inherits defaults when no entry fallbacks are configured", () => {
    const entryModel = undefined;
    const defaultModel = {
      primary: "openai/gpt-5-nano",
      fallbacks: ["google/gemini-2.0-flash"],
    };

    expect(resolveEffectiveModelFallbacks(entryModel, defaultModel)).toEqual([
      "google/gemini-2.0-flash",
    ]);
  });

  it("prefers entry fallbacks over defaults", () => {
    const entryModel = {
      primary: "openai/gpt-5-mini",
      fallbacks: ["openai/gpt-5-nano"],
    };
    const defaultModel = {
      primary: "openai/gpt-5",
      fallbacks: ["google/gemini-2.0-flash"],
    };

    expect(resolveEffectiveModelFallbacks(entryModel, defaultModel)).toEqual(["openai/gpt-5-nano"]);
  });

  it("keeps explicit empty entry fallback lists", () => {
    const entryModel = {
      primary: "openai/gpt-5-mini",
      fallbacks: [],
    };
    const defaultModel = {
      primary: "openai/gpt-5",
      fallbacks: ["google/gemini-2.0-flash"],
    };

    expect(resolveEffectiveModelFallbacks(entryModel, defaultModel)).toEqual([]);
  });
});

describe("resolveConfiguredCronModelSuggestions", () => {
  it("collects defaults primary/fallbacks, alias map keys, and per-agent model entries", () => {
    const result = resolveConfiguredCronModelSuggestions({
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-5.2",
            fallbacks: ["google/gemini-2.5-pro", "openai/gpt-5.2-mini"],
          },
          models: {
            "anthropic/claude-sonnet-4-5": { alias: "smart" },
            "openai/gpt-5.2": { alias: "main" },
          },
        },
        list: {
          writer: {
            model: { primary: "xai/grok-4", fallbacks: ["openai/gpt-5.2-mini"] },
          },
          planner: {
            model: "google/gemini-2.5-flash",
          },
        },
      },
    });

    expect(result).toEqual([
      "anthropic/claude-sonnet-4-5",
      "google/gemini-2.5-flash",
      "google/gemini-2.5-pro",
      "openai/gpt-5.2",
      "openai/gpt-5.2-mini",
      "xai/grok-4",
    ]);
  });

  it("returns empty array for invalid or missing config shape", () => {
    expect(resolveConfiguredCronModelSuggestions(null)).toEqual([]);
    expect(resolveConfiguredCronModelSuggestions({})).toEqual([]);
    expect(resolveConfiguredCronModelSuggestions({ agents: { defaults: { model: "" } } })).toEqual(
      [],
    );
  });
});

describe("sortLocaleStrings", () => {
  it("sorts values using localeCompare without relying on Array.prototype.toSorted", () => {
    expect(sortLocaleStrings(["z", "b", "a"])).toEqual(["a", "b", "z"]);
  });

  it("accepts any iterable input, including sets", () => {
    expect(sortLocaleStrings(new Set(["beta", "alpha"]))).toEqual(["alpha", "beta"]);
  });
});

describe("agentLogoUrl", () => {
  it("keeps base-mounted control UI logo paths absolute to the mount", () => {
    expect(agentLogoUrl("/ui")).toBe("/ui/favicon.svg");
    expect(agentLogoUrl("/apps/openclaw/")).toBe("/apps/openclaw/favicon.svg");
  });

  it("uses a route-relative fallback before basePath bootstrap finishes", () => {
    expect(agentLogoUrl("")).toBe("favicon.svg");
  });
});

describe("assistantAvatarFallbackUrl", () => {
  it("uses the bundled Molty png for assistant profile fallbacks", () => {
    expect(assistantAvatarFallbackUrl("/ui")).toBe("/ui/apple-touch-icon.png");
    expect(assistantAvatarFallbackUrl("")).toBe("apple-touch-icon.png");
  });
});

describe("resolveAssistantTextAvatar", () => {
  it("rejects unsafe invisible controls in assistant text avatars", () => {
    expect(resolveAssistantTextAvatar("VC")).toBe("VC");
    expect(resolveAssistantTextAvatar("\u{1F43E}")).toBe("\u{1F43E}");
    expect(resolveAssistantTextAvatar("V\u202eC")).toBeNull();
    expect(resolveAssistantTextAvatar("V\u200bC")).toBeNull();
  });
});

describe("resolveAgentAvatarUrl", () => {
  it("prefers a runtime avatar URL over non-URL identity avatars", () => {
    expect(
      resolveAgentAvatarUrl(
        { identity: { avatar: "A", avatarUrl: "/avatar/main" } },
        {
          agentId: "main",
          avatar: "A",
          name: "Main",
        },
      ),
    ).toBe("/avatar/main");
  });

  it("ignores remote http avatars so the control UI falls back to a local badge", () => {
    expect(
      resolveAgentAvatarUrl({
        identity: { avatarUrl: "https://example.com/avatar.png" },
      }),
    ).toBeNull();
  });

  it("ignores protocol-relative avatars so the control UI cannot be tricked into a cross-origin fetch", () => {
    expect(
      resolveAgentAvatarUrl({
        identity: { avatarUrl: "//evil.example/avatar.png" },
      }),
    ).toBeNull();
  });

  it("returns null for initials or emoji avatar values without a URL", () => {
    expect(resolveAgentAvatarUrl({ identity: { avatar: "A" } })).toBeNull();
    expect(resolveAgentAvatarUrl({ identity: { avatar: "🦞" } })).toBeNull();
  });
});

describe("resolveChatAvatarRenderUrl", () => {
  it("accepts a blob: URL produced by an authenticated avatar fetch", () => {
    expect(
      resolveChatAvatarRenderUrl("blob:http://localhost/uuid-123", {
        identity: { avatarUrl: "/avatar/main" },
      }),
    ).toBe("blob:http://localhost/uuid-123");
  });

  it("falls back to the config-sanitized avatar when no blob candidate is present", () => {
    expect(
      resolveChatAvatarRenderUrl(null, {
        identity: { avatarUrl: "/avatar/main" },
      }),
    ).toBe("/avatar/main");
  });

  it("rejects remote URLs passed as the render candidate", () => {
    expect(
      resolveChatAvatarRenderUrl("https://example.com/avatar.png", {
        identity: { avatarUrl: "/avatar/main" },
      }),
    ).toBe("/avatar/main");
  });
});

describe("buildAgentContext", () => {
  it("falls back to agent payload workspace/model when config form is unavailable", () => {
    const context = buildAgentContext(
      {
        id: "main",
        workspace: "/tmp/agent-workspace",
        model: {
          primary: "openai/gpt-5.5",
          fallbacks: ["openai-codex/gpt-5.2-codex"],
        },
      },
      null,
      null,
      "main",
      null,
    );

    expect(context.workspace).toBe("/tmp/agent-workspace");
    expect(context.model).toBe("openai/gpt-5.5 (+1 fallback)");
    expect(context.isDefault).toBe(true);
  });

  it("uses configured defaults when agent-specific overrides are absent", () => {
    const context = buildAgentContext(
      { id: "main" },
      {
        agents: {
          defaults: {
            workspace: "/tmp/default-workspace",
            model: {
              primary: "openai/gpt-5.5",
              fallbacks: ["openai-codex/gpt-5.2-codex"],
            },
          },
          list: [{ id: "main" }],
        },
      },
      null,
      "main",
      null,
    );

    expect(context.workspace).toBe("/tmp/default-workspace");
    expect(context.model).toBe("openai/gpt-5.5 (+1 fallback)");
  });

  it("prefers per-agent configured identity over runtime global identity in agent panels", () => {
    const context = buildAgentContext(
      {
        id: "fs-daying",
        name: "File-system agent",
        identity: { name: "大颖", emoji: "⚙️" },
      },
      null,
      null,
      "main",
      {
        agentId: "fs-daying",
        name: "AI大管家",
        avatar: "M",
        emoji: "🤖",
      },
    );

    expect(context.identityName).toBe("大颖");
    expect(context.identityAvatar).toBe("⚙️");
  });
});
