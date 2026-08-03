import { describe, expect, it } from "vitest";
import { renderTelegramMiniAppPage } from "./page.js";

describe("renderTelegramMiniAppPage", () => {
  it("builds the dashboard redirect from the authenticated payload", () => {
    const html = renderTelegramMiniAppPage({ accountId: "ops", scriptNonce: "nonce" });

    expect(html).toContain('const accountId = "ops";');
    expect(html).toContain("new URL(payload.controlUiUrl)");
    expect(html).not.toContain("const controlUiUrl =");
  });

  it("escapes the nonce for its quoted HTML attribute", () => {
    const html = renderTelegramMiniAppPage({ accountId: "ops", scriptNonce: `&<>"'` });

    expect(html).toContain('nonce="&amp;&lt;&gt;&quot;&#39;"');
  });
});
