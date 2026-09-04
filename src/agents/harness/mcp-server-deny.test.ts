import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  collectHarnessDeniedMcpServers,
  resolveHarnessDeniableMcpServerPatterns,
} from "./mcp-server-deny.js";

const config = {
  mcp: {
    servers: {
      alpha: { url: "https://lox.example/mcp", transport: "streamable-http" },
      "Gamma Mail": { url: "https://mail.example/mcp", transport: "streamable-http" },
      "per-user": {
        url: "https://per-user.example/mcp",
        transport: "streamable-http",
        auth: "oauth",
        oauth: { identity: "per-requester" },
      },
    },
  },
} as unknown as OpenClawConfig;

describe("resolveHarnessDeniableMcpServerPatterns", () => {
  it("maps raw and sanitized whole-server patterns to static configured servers", () => {
    const patterns = resolveHarnessDeniableMcpServerPatterns(config);
    expect(patterns.get("alpha__*")).toBe("alpha");
    expect(patterns.get("gamma mail__*")).toBe("Gamma Mail");
    expect(patterns.get("gamma-mail__*")).toBe("Gamma Mail");
  });

  it("omits requester-scoped servers and intra-server patterns", () => {
    const patterns = resolveHarnessDeniableMcpServerPatterns(config);
    expect(patterns.has("per-user__*")).toBe(false);
    expect(patterns.has("alpha__get_*")).toBe(false);
    expect(patterns.has("alpha__status")).toBe(false);
  });

  it("omits patterns that could name more than one configured server", () => {
    const ambiguous = {
      mcp: {
        servers: {
          "Gamma Mail": { url: "https://mail.example/mcp", transport: "streamable-http" },
          "gamma-mail": { url: "https://other.example/mcp", transport: "streamable-http" },
          alpha: { url: "https://alpha.example/mcp", transport: "streamable-http" },
        },
      },
    } as unknown as OpenClawConfig;
    const patterns = resolveHarnessDeniableMcpServerPatterns(ambiguous);
    // "Gamma Mail" sanitizes to "Gamma-Mail", which normalizes onto the raw key
    // "gamma-mail" of the other server: neither server may claim that pattern.
    expect(patterns.has("gamma-mail__*")).toBe(false);
    expect(patterns.get("gamma mail__*")).toBe("Gamma Mail");
    expect(patterns.get("alpha__*")).toBe("alpha");
    expect(
      collectHarnessDeniedMcpServers([{ deny: ["gamma-mail__*", "alpha__*"] }], patterns),
    ).toEqual(["alpha"]);
  });

  it("never certifies a server whose key carries glob syntax", () => {
    const globbed = {
      mcp: {
        servers: {
          "prod*": { url: "https://prod.example/mcp", transport: "streamable-http" },
          "prod-east": { url: "https://east.example/mcp", transport: "streamable-http" },
        },
      },
    } as unknown as OpenClawConfig;
    const patterns = resolveHarnessDeniableMcpServerPatterns(globbed);
    expect(patterns.has("prod*__*")).toBe(false);
    expect(patterns.get("prod-east__*")).toBe("prod-east");
    // The sanitized alias of "prod*" is "prod-" -> "prod-__*", which is safe to certify.
    expect(patterns.get("prod-__*")).toBe("prod*");
  });

  it("returns no patterns without configured servers", () => {
    expect(resolveHarnessDeniableMcpServerPatterns(undefined).size).toBe(0);
    expect(resolveHarnessDeniableMcpServerPatterns({} as OpenClawConfig).size).toBe(0);
  });
});

describe("collectHarnessDeniedMcpServers", () => {
  it("collects whole-server denies across policies, case-insensitively and sorted", () => {
    const patterns = resolveHarnessDeniableMcpServerPatterns(config);
    expect(
      collectHarnessDeniedMcpServers(
        [{ deny: ["Gamma-Mail__*", "exec"] }, undefined, { deny: ["ALPHA__*", "alpha__*"] }],
        patterns,
      ),
    ).toEqual(["alpha", "Gamma Mail"]);
  });

  it("ignores denies the harness cannot enforce natively", () => {
    const patterns = resolveHarnessDeniableMcpServerPatterns(config);
    expect(
      collectHarnessDeniedMcpServers(
        [{ deny: ["alpha__get_*", "unknown__*", "per-user__*", "*"] }],
        patterns,
      ),
    ).toEqual([]);
    expect(collectHarnessDeniedMcpServers([{ deny: ["alpha__*"] }], undefined)).toEqual([]);
  });
});
