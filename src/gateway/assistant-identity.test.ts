/**
 * Assistant identity resolution tests for gateway-visible agents.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { withTempDir } from "../test-helpers/temp-dir.js";
import {
  DEFAULT_ASSISTANT_IDENTITY,
  resolveAssistantIdentity,
  resolvePublicAssistantIdentity,
} from "./assistant-identity.js";

describe("resolveAssistantIdentity", () => {
  it("keeps ui.assistant identity authoritative for the default agent", () => {
    const cfg: OpenClawConfig = {
      ui: {
        assistant: {
          name: "Main assistant",
          avatar: "M",
        },
      },
      agents: {
        list: [{ id: "main", identity: { name: "Main agent", avatar: "A" } }],
      },
    };

    const identity = resolveAssistantIdentity({ cfg, agentId: "main", workspaceDir: "" });
    expect(identity.agentId).toBe("main");
    expect(identity.name).toBe("Main assistant");
    expect(identity.avatar).toBe("M");
  });

  it("prefers non-default agent identity over global ui.assistant identity", () => {
    const cfg: OpenClawConfig = {
      ui: {
        assistant: {
          name: "AI大管家",
          avatar: "M",
        },
      },
      agents: {
        list: [{ id: "main" }, { id: "fs-daying", identity: { name: "大颖", avatar: "D" } }],
      },
    };

    const identity = resolveAssistantIdentity({ cfg, agentId: "fs-daying", workspaceDir: "" });
    expect(identity.agentId).toBe("fs-daying");
    expect(identity.name).toBe("大颖");
    expect(identity.avatar).toBe("D");
  });

  it("falls back to ui.assistant identity for non-default agents without their own identity", () => {
    const cfg: OpenClawConfig = {
      ui: {
        assistant: {
          name: "Main assistant",
          avatar: "M",
        },
      },
      agents: {
        list: [{ id: "worker" }],
      },
    };

    const identity = resolveAssistantIdentity({ cfg, agentId: "worker", workspaceDir: "" });
    expect(identity.agentId).toBe("worker");
    expect(identity.name).toBe("Main assistant");
    expect(identity.avatar).toBe("M");
  });

  it("drops sentence-like avatar placeholders", () => {
    const cfg: OpenClawConfig = {
      ui: {
        assistant: {
          avatar: "workspace-relative path, http(s) URL, or data URI",
        },
      },
    };

    expect(resolveAssistantIdentity({ cfg, workspaceDir: "" }).avatar).toBe(
      DEFAULT_ASSISTANT_IDENTITY.avatar,
    );
  });

  it("keeps short text avatars", () => {
    const cfg: OpenClawConfig = {
      ui: {
        assistant: {
          avatar: "PS",
        },
      },
    };

    expect(resolveAssistantIdentity({ cfg, workspaceDir: "" }).avatar).toBe("PS");
  });

  it("keeps path avatars", () => {
    const cfg: OpenClawConfig = {
      ui: {
        assistant: {
          avatar: "avatars/openclaw.png",
        },
      },
    };

    expect(resolveAssistantIdentity({ cfg, workspaceDir: "" }).avatar).toBe("avatars/openclaw.png");
  });

  it("preserves long image data URLs without truncating past 200 chars", () => {
    const dataUrl = `data:image/png;base64,${"A".repeat(50_000)}`;
    const cfg: OpenClawConfig = {
      ui: {
        assistant: {
          avatar: dataUrl,
        },
      },
    };

    expect(resolveAssistantIdentity({ cfg, workspaceDir: "" }).avatar).toBe(dataUrl);
  });

  it("does not leave a lone surrogate when truncating an overlong name", () => {
    const resolveName = (name: string) =>
      resolveAssistantIdentity({
        cfg: { agents: { list: [{ id: "main", identity: { name } }] } },
        agentId: "main",
        workspaceDir: "",
      }).name;
    const prefix = "x".repeat(49);
    const name = resolveName(`${prefix}🚀suffix`);
    expect(name).toBe(prefix);
    expect(name.endsWith("\ud83d")).toBe(false);
    expect(resolveName(`${"x".repeat(48)}🚀suffix`)).toBe(`${"x".repeat(48)}🚀`);
  });
});

describe("resolvePublicAssistantIdentity", () => {
  it("projects workspace avatars to bounded data URLs", async () => {
    await withTempDir({ prefix: "openclaw-public-avatar-" }, async (workspace) => {
      await fs.mkdir(path.join(workspace, "avatars"), { recursive: true });
      await fs.writeFile(path.join(workspace, "avatars", "main.png"), "avatar", "utf8");
      const identity = resolvePublicAssistantIdentity({
        cfg: {
          agents: {
            defaults: { workspace },
            list: [{ id: "main", identity: { avatar: "avatars/main.png" } }],
          },
        },
      });

      expect(identity).toMatchObject({
        avatar: `data:image/png;base64,${Buffer.from("avatar").toString("base64")}`,
        avatarSource: "avatars/main.png",
        avatarStatus: "local",
      });
      expect(identity.avatar).not.toContain("/avatar/main");
    });
  });

  it.each([
    ["remote", "https://example.com/avatar.png"],
    ["data", "data:image/png;base64,aaaa"],
    ["text", "PS"],
    ["emoji", "🦞"],
  ] as const)("preserves %s avatar presentation", (_kind, avatar) => {
    const identity = resolvePublicAssistantIdentity({
      cfg: { ui: { assistant: { avatar } } },
      workspaceDir: "",
    });

    expect(identity.avatar).toBe(avatar);
    if (_kind === "text" || _kind === "emoji") {
      expect(identity).toMatchObject({ avatarStatus: "none", avatarReason: undefined });
      expect(identity.avatarSource).toBeUndefined();
    }
  });

  it("preserves same-origin Control UI avatar routes", () => {
    expect(
      resolvePublicAssistantIdentity({
        cfg: { ui: { assistant: { avatar: "/avatar/main" } } },
        workspaceDir: "",
      }).avatar,
    ).toBe("/avatar/main");
    expect(
      resolvePublicAssistantIdentity({
        cfg: { ui: { assistant: { avatar: "/avatar/main" } } },
        workspaceDir: "",
        basePath: "/openclaw",
      }).avatar,
    ).toBe("/openclaw/avatar/main");
    expect(
      resolvePublicAssistantIdentity({
        cfg: { ui: { assistant: { avatar: "/openclaw/avatar/main" } } },
        workspaceDir: "",
        basePath: "/openclaw",
      }).avatar,
    ).toBe("/openclaw/avatar/main");
  });

  it("replaces rejected paths with the default while preserving repair metadata", async () => {
    await withTempDir({ prefix: "openclaw-public-avatar-missing-" }, async (workspace) => {
      const identity = resolvePublicAssistantIdentity({
        cfg: {
          agents: {
            defaults: { workspace },
            list: [{ id: "main", identity: { avatar: "avatars/missing.png" } }],
          },
        },
      });

      expect(identity).toMatchObject({
        avatar: DEFAULT_ASSISTANT_IDENTITY.avatar,
        avatarSource: "avatars/missing.png",
        avatarStatus: "none",
        avatarReason: "missing",
      });
      expect(identity.avatar).not.toContain("/avatar/main");
    });
  });
});
