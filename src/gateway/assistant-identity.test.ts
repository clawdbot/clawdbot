import { describe, expect, it } from "vitest";

import type { ClawdbotConfig } from "../config/config.js";
import { DEFAULT_ASSISTANT_IDENTITY, resolveAssistantIdentity } from "./assistant-identity.js";

describe("resolveAssistantIdentity avatar normalization", () => {
  it("drops sentence-like avatar placeholders", () => {
    const cfg: ClawdbotConfig = {
      ui: {
        assistant: {
          avatar: "workspace-relative path, http(s) URL, or data URI",
        },
      },
    };

    expect(resolveAssistantIdentity({ cfg }).avatar).toBe(DEFAULT_ASSISTANT_IDENTITY.avatar);
  });

  it("keeps short text avatars", () => {
    const cfg: ClawdbotConfig = {
      ui: {
        assistant: {
          avatar: "PS",
        },
      },
    };

    expect(resolveAssistantIdentity({ cfg }).avatar).toBe("PS");
  });

  it("keeps path avatars", () => {
    const cfg: ClawdbotConfig = {
      ui: {
        assistant: {
          avatar: "avatars/clawd.png",
        },
      },
    };

    expect(resolveAssistantIdentity({ cfg }).avatar).toBe("avatars/clawd.png");
  });
});
