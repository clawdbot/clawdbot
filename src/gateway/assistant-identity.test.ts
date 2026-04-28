import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { DEFAULT_ASSISTANT_IDENTITY, resolveAssistantIdentity } from "./assistant-identity.js";

describe("resolveAssistantIdentity avatar normalization", () => {
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

    expect(resolveAssistantIdentity({ cfg, agentId: "main", workspaceDir: "" })).toMatchObject({
      agentId: "main",
      name: "Main assistant",
      avatar: "M",
    });
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

    expect(resolveAssistantIdentity({ cfg, agentId: "fs-daying", workspaceDir: "" })).toMatchObject(
      {
        agentId: "fs-daying",
        name: "大颖",
        avatar: "D",
      },
    );
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

    expect(resolveAssistantIdentity({ cfg, agentId: "worker", workspaceDir: "" })).toMatchObject({
      agentId: "worker",
      name: "Main assistant",
      avatar: "M",
    });
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
});
