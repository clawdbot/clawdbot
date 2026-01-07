import { describe, expect, it } from "vitest";

import { resolveOutboundTarget } from "./targets.js";

describe("resolveOutboundTarget", () => {
  it("falls back to whatsapp allowFrom", () => {
    const res = resolveOutboundTarget({
      provider: "whatsapp",
      to: "",
      allowFrom: ["+1555"],
    });
    expect(res).toEqual({ ok: true, to: "+1555" });
  });

  it("normalizes whatsapp target when provided", () => {
    const res = resolveOutboundTarget({
      provider: "whatsapp",
      to: " (555) 123-4567 ",
    });
    if (!res.ok) throw res.error;
    expect(res.to).toBe("+5551234567");
  });

  it("rejects telegram with missing target", () => {
    const res = resolveOutboundTarget({ provider: "telegram", to: " " });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.message).toContain("Telegram");
    }
  });

  it("rejects matrix with missing target", () => {
    const res = resolveOutboundTarget({ provider: "matrix", to: " " });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.message).toContain("Matrix");
    }
  });

  it("rejects webchat delivery", () => {
    const res = resolveOutboundTarget({ provider: "webchat", to: "x" });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.message).toContain("WebChat");
    }
  });
});
