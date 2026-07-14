import { describe, expect, it } from "vitest";
import { buildMcpAppHostCapabilities, resolveMcpAppSandboxUrl } from "./mcp-app-security.ts";

describe("MCP App sandbox security", () => {
  it("advertises the CSP applied to MCP Apps", () => {
    expect(
      buildMcpAppHostCapabilities({ connectDomains: ["https://api.example.com"] }),
    ).toMatchObject({ sandbox: { csp: { connectDomains: ["https://api.example.com"] } } });
    expect(buildMcpAppHostCapabilities()).toMatchObject({ sandbox: { csp: {} } });
  });

  it("accepts only the dedicated-origin sandbox endpoint", () => {
    expect(
      resolveMcpAppSandboxUrl(
        "/mcp-app-sandbox?csp=abc",
        8444,
        undefined,
        "wss://gateway.example:8443/openclaw",
        "https://gateway.example:8443",
      ),
    ).toBe("https://gateway.example:8444/mcp-app-sandbox?csp=abc");
    expect(
      resolveMcpAppSandboxUrl(
        "/mcp-app-sandbox",
        18790,
        "https://apps.example.com",
        "wss://gateway.example",
        "https://gateway.example",
      ),
    ).toBe("https://apps.example.com/mcp-app-sandbox");

    const invalid = [
      [
        "https://attacker.example/mcp-app-sandbox",
        8444,
        undefined,
        "wss://gateway.example:8443/openclaw",
        "https://gateway.example:8443",
      ],
      [
        "data:text/html;base64,cHJveHk=",
        8444,
        undefined,
        "wss://gateway.example:8443/openclaw",
        "https://gateway.example:8443",
      ],
      [
        "/mcp-app-sandbox",
        8443,
        undefined,
        "wss://gateway.example:8443/openclaw",
        "https://gateway.example:8443",
      ],
      [
        "/mcp-app-sandbox",
        8444,
        "https://gateway.example:8443",
        "wss://gateway.example:8443/openclaw",
        "https://control.example",
      ],
    ] as const;
    for (const args of invalid) {
      expect(() => resolveMcpAppSandboxUrl(args[0], args[1], args[2], args[3], args[4])).toThrow(
        "MCP App sandbox URL is invalid",
      );
    }
  });
});
