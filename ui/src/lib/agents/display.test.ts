// Control UI tests cover agents utils behavior.
import { describe, expect, it } from "vitest";
import { AVATAR_MAX_DATA_URL_CHARS } from "../../../../src/shared/avatar-limits.js";
import {
  assistantAvatarFallbackUrl,
  isRenderableControlUiAvatarUrl,
  resolveAgentAvatarUrl,
  resolveAssistantTextAvatar,
  resolveChatAvatarRenderUrl,
} from "../avatar.ts";
import { buildAgentContext, formatBytes, resolveEffectiveModelFallbacks } from "./display.ts";

describe("formatBytes", () => {
  it("preserves the Control UI byte-size display contract", () => {
    expect(formatBytes(undefined)).toBe("-");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(12 * 1024)).toBe("12 KB");
    expect(formatBytes(2 * 1024 * 1024)).toBe("2.0 MB");
  });
});

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

    expect(resolveEffectiveModelFallbacks(entryModel, defaultModel)).toStrictEqual([]);
  });
});

describe("assistantAvatarFallbackUrl", () => {
  it("uses the bundled Molty png for assistant profile fallbacks", () => {
    expect(assistantAvatarFallbackUrl("/ui")).toBe("/ui/apple-touch-icon.png");
    expect(assistantAvatarFallbackUrl("")).toBe("/apple-touch-icon.png");
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
  it("accepts image data URLs only through the shared encoded-size boundary", () => {
    const prefix = "data:image/svg+xml;base64,";
    const exact = `${prefix}${"A".repeat(AVATAR_MAX_DATA_URL_CHARS - prefix.length)}`;

    expect(isRenderableControlUiAvatarUrl(exact)).toBe(true);
    expect(isRenderableControlUiAvatarUrl(`${exact}A`)).toBe(false);
    expect(isRenderableControlUiAvatarUrl("data:text/plain,avatar")).toBe(false);
  });

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
          fallbacks: ["openai/gpt-5.2-codex"],
        },
        agentRuntime: { id: "claude-cli", fallback: "none", source: "agent" },
      },
      null,
      null,
      "main",
      null,
    );

    expect(context.workspace).toBe("/tmp/agent-workspace");
    expect(context.model).toBe("openai/gpt-5.5 (+1 fallback)");
    expect(context.runtime).toBe("claude-cli (fallback none)");
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
              fallbacks: ["openai/gpt-5.2-codex"],
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
