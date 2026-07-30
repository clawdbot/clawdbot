import { describe, expect, it } from "vitest";
import {
  buildSandboxHostContentSecurityPolicy,
  buildSandboxHostProxyHtml,
  decodeSandboxHostCsp,
} from "../agents/sandbox-host.js";
import type { BoardWidgetDocument } from "../boards/board-store.js";
import {
  buildBoardWidgetContentSecurityPolicy,
  buildBoardWidgetSandboxPath,
} from "./board-sandbox.js";

function document(
  grantState: "pending" | "granted",
  netOrigins = ["https://api.open-meteo.com"],
): BoardWidgetDocument {
  return {
    html: "<!doctype html>",
    revision: 1,
    sha256: "a".repeat(64),
    viewGeneration: "b".repeat(32),
    grantState,
    declared: { netOrigins },
  };
}

describe("board widget sandbox CSP", () => {
  it("emits no network authority while a declaration is pending", () => {
    const path = buildBoardWidgetSandboxPath(document("pending"));
    const encoded = new URL(path, "https://sandbox.example").searchParams.get("csp");

    expect(decodeSandboxHostCsp(encoded)).toEqual({ blockDescendantFrames: true });
    expect(buildSandboxHostContentSecurityPolicy()).toContain("connect-src 'none'");
    expect(buildSandboxHostContentSecurityPolicy()).toContain("webrtc 'block'");
    expect(buildBoardWidgetContentSecurityPolicy(document("pending"))).toContain(
      "connect-src 'none'",
    );
    expect(buildBoardWidgetContentSecurityPolicy(document("pending"))).toContain("webrtc 'block'");
  });

  it("emits only the granted widget origins", () => {
    const path = buildBoardWidgetSandboxPath(
      document("granted", [
        "https://api.open-meteo.com",
        "https://status.example:8443",
        "https://[2001:db8::1]:9443",
      ]),
    );
    const encoded = new URL(path, "https://sandbox.example").searchParams.get("csp");
    const csp = decodeSandboxHostCsp(encoded);

    expect(csp).toEqual({
      connectDomains: [
        "https://api.open-meteo.com",
        "https://status.example:8443",
        "https://[2001:db8::1]:9443",
      ],
      blockDescendantFrames: true,
    });
    expect(buildSandboxHostContentSecurityPolicy(csp)).toContain(
      "connect-src https://api.open-meteo.com https://status.example:8443 https://[2001:db8::1]:9443",
    );
    expect(
      buildBoardWidgetContentSecurityPolicy(document("granted", csp?.connectDomains)),
    ).toContain(
      "connect-src https://api.open-meteo.com https://status.example:8443 https://[2001:db8::1]:9443",
    );
  });

  it("adds the best-effort descendant-frame guard only for board documents", () => {
    const proxy = buildSandboxHostProxyHtml({ blockDescendantFrames: true });
    const genericProxy = buildSandboxHostProxyHtml();

    expect(proxy).toContain("const blockDescendantFrames = true");
    expect(proxy).toContain("sandbox descendant browsing contexts are disabled");
    expect(proxy).toContain('lock(Document.prototype,\\"createElement\\"');
    expect(proxy).toContain('wrapSetter(Element.prototype,\\"innerHTML\\"');
    expect(proxy).toContain('wrapMethod(Element.prototype,\\"setHTMLUnsafe\\"');
    expect(proxy).toContain('lock(globalThis,\\"open\\",undefined)');
    const guardedHtmlIndex = proxy.indexOf("const guardedHtml = guardDocument(params.html)");
    expect(guardedHtmlIndex).toBeGreaterThan(-1);
    expect(proxy.indexOf("widgetBridgePortOffered = false", guardedHtmlIndex)).toBeGreaterThan(
      guardedHtmlIndex,
    );
    expect(proxy).toContain("const apply=Reflect.apply");
    expect(proxy).toContain('if (html.slice(index, index + 4) !== "<!--") break');
    expect(proxy).toContain('const commentEnd = html.indexOf("-->", index + 4)');
    expect(genericProxy).toContain("const blockDescendantFrames = false");
    expect(genericProxy).not.toContain('lock(Document.prototype,\\"createElement\\"');
  });
});
