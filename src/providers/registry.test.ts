import { describe, expect, it } from "vitest";

import {
  formatProviderSelectionLine,
  listChatProviders,
  normalizeChatProviderId,
} from "./registry.js";

describe("provider registry", () => {
  it("normalizes aliases", () => {
    expect(normalizeChatProviderId("imsg")).toBe("imessage");
    expect(normalizeChatProviderId("teams")).toBe("msteams");
    expect(normalizeChatProviderId("web")).toBeNull();
  });

  it("keeps Telegram first in the default order", () => {
    const providers = listChatProviders();
    expect(providers[0]?.id).toBe("telegram");
  });

  it("formats selection lines with docs labels", () => {
    const providers = listChatProviders();
    const first = providers[0];
    if (!first) throw new Error("Missing provider metadata.");
    const line = formatProviderSelectionLine(first, (path, label) =>
      [label, path].filter(Boolean).join(":"),
    );
    expect(line).not.toContain("Docs:");
    expect(line).toContain("/telegram");
    expect(line).toContain("https://clawd.bot");
  });
});
