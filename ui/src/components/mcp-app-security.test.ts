import { describe, expect, it } from "vitest";
import {
  buildMcpAppHostCapabilities,
  dispatchWidgetPrompt,
  resolveMcpAppSandboxUrl,
} from "./mcp-app-security.ts";

describe("MCP App sandbox security", () => {
  it("advertises the CSP applied to MCP Apps", () => {
    expect(
      buildMcpAppHostCapabilities({ connectDomains: ["https://api.example.com"] }),
    ).toMatchObject({ sandbox: { csp: { connectDomains: ["https://api.example.com"] } } });
    expect(buildMcpAppHostCapabilities()).toMatchObject({ sandbox: { csp: {} } });
  });

  it("advertises update-model-context text support only when the handler path exists", () => {
    expect(buildMcpAppHostCapabilities(undefined, true, true)).toMatchObject({
      message: { text: {} },
      updateModelContext: { text: {} },
    });
    expect(buildMcpAppHostCapabilities(undefined, true, false)).not.toHaveProperty(
      "updateModelContext",
    );
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

  it("keeps the per-view prompt budget across iframe remounts", () => {
    const key = `agent:main:main\0view-${crypto.randomUUID()}`;
    const first = document.createElement("iframe");
    document.body.append(first);
    first.checkVisibility = () => true;
    Object.defineProperty(document, "activeElement", { get: () => first, configurable: true });
    for (let index = 0; index < 10; index += 1) {
      expect(dispatchWidgetPrompt(first, `Prompt ${index}`, key)).toBe(true);
    }

    first.remove();
    const replacement = document.createElement("iframe");
    document.body.append(replacement);
    replacement.checkVisibility = () => true;
    Object.defineProperty(document, "activeElement", {
      get: () => replacement,
      configurable: true,
    });
    expect(dispatchWidgetPrompt(replacement, "Prompt after remount", key)).toBe(false);
    replacement.remove();
    delete (document as unknown as Record<string, unknown>).activeElement;
  });
});
