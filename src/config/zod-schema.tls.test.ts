// Schema-level tests for gateway.tls certPath and keyPath validation.
import { describe, expect, it } from "vitest";
import { validateConfigObject } from "./validation.js";

describe("gateway.tls schema", () => {
  it("rejects empty certPath", () => {
    const res = validateConfigObject({ gateway: { tls: { enabled: true, certPath: "" } } });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues[0]?.path).toMatch(/certPath/);
    }
  });

  it("rejects whitespace-only keyPath", () => {
    const res = validateConfigObject({ gateway: { tls: { enabled: true, keyPath: "   " } } });
    expect(res.ok).toBe(false);
  });

  it("accepts a non-empty certPath", () => {
    const res = validateConfigObject({
      gateway: { tls: { enabled: true, certPath: "/etc/ssl/cert.pem" } },
    });
    expect(res.ok).toBe(true);
  });

  it("preserves exact bytes of a non-empty certPath (no silent trim)", () => {
    const res = validateConfigObject({
      gateway: { tls: { enabled: true, certPath: "  /etc/ssl/cert.pem  " } },
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      // Schema must validate without transforming the string; runtime path
      // resolution owns normalization, so leading/trailing spaces are preserved.
      expect(res.config.gateway?.tls?.certPath).toBe("  /etc/ssl/cert.pem  ");
    }
  });

  it("preserves exact bytes of a non-empty keyPath (no silent trim)", () => {
    const res = validateConfigObject({
      gateway: { tls: { enabled: true, keyPath: "  /etc/ssl/private/server.key  " } },
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.config.gateway?.tls?.keyPath).toBe("  /etc/ssl/private/server.key  ");
    }
  });
});
