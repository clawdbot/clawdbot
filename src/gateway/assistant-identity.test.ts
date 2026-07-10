/**
 * Assistant identity resolution tests for gateway-visible agents.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { AVATAR_MAX_BYTES, AVATAR_MAX_DATA_URL_CHARS } from "../shared/avatar-policy.js";
import { withTempDir } from "../test-helpers/temp-dir.js";
import { DEFAULT_ASSISTANT_IDENTITY, resolveAssistantIdentity } from "./assistant-identity.js";

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

  it("preserves an exact shared-cap IDENTITY.md data URL without truncation", async () => {
    await withTempDir({ prefix: "openclaw-assistant-identity-cap-" }, async (workspace) => {
      const dataUrl = `data:image/svg+xml;base64,${Buffer.alloc(AVATAR_MAX_BYTES).toString("base64")}`;
      expect(dataUrl).toHaveLength(AVATAR_MAX_DATA_URL_CHARS);
      await fs.writeFile(path.join(workspace, "IDENTITY.md"), `- Avatar: ${dataUrl}\n`);

      expect(resolveAssistantIdentity({ cfg: {}, workspaceDir: workspace }).avatar).toBe(dataUrl);
    });
  });

  it("rejects an oversized IDENTITY.md data URL without truncating it", async () => {
    await withTempDir({ prefix: "openclaw-assistant-identity-overflow-" }, async (workspace) => {
      const exact = `data:image/svg+xml;base64,${Buffer.alloc(AVATAR_MAX_BYTES).toString("base64")}`;
      const oversized = `${exact}A`;
      expect(oversized).toHaveLength(AVATAR_MAX_DATA_URL_CHARS + 1);
      await fs.writeFile(
        path.join(workspace, "IDENTITY.md"),
        `- Avatar: ${oversized}\n- Emoji: 🦞\n`,
      );

      expect(resolveAssistantIdentity({ cfg: {}, workspaceDir: workspace }).avatar).toBe("🦞");
    });
  });

  it("rejects a non-image IDENTITY.md data URL and uses its emoji fallback", async () => {
    await withTempDir({ prefix: "openclaw-assistant-identity-data-type-" }, async (workspace) => {
      await fs.writeFile(
        path.join(workspace, "IDENTITY.md"),
        "- Avatar: data:text/plain,avatar\n- Emoji: 🦞\n",
      );

      expect(resolveAssistantIdentity({ cfg: {}, workspaceDir: workspace }).avatar).toBe("🦞");
    });
  });

  it.each(["data:text/plain,avatar", "slack://avatar.png"])(
    "lets a valid agent avatar win when the UI override is unsupported: %s",
    (avatar) => {
      const cfg: OpenClawConfig = {
        ui: { assistant: { avatar } },
        agents: { list: [{ id: "main", identity: { avatar: "agent.png" } }] },
      };

      expect(resolveAssistantIdentity({ cfg, workspaceDir: "" }).avatar).toBe("agent.png");
    },
  );

  it("lets a valid IDENTITY.md avatar win when the agent URI scheme is unsupported", async () => {
    await withTempDir({ prefix: "openclaw-assistant-identity-fallback-" }, async (workspace) => {
      await fs.writeFile(path.join(workspace, "IDENTITY.md"), "- Avatar: identity.png\n");
      const cfg: OpenClawConfig = {
        agents: {
          list: [{ id: "main", workspace, identity: { avatar: "slack://avatar.png" } }],
        },
      };

      expect(resolveAssistantIdentity({ cfg, workspaceDir: workspace }).avatar).toBe(
        "identity.png",
      );
    });
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
