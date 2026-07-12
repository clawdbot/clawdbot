import { afterEach, describe, expect, it } from "vitest";
import { i18n } from "../i18n/index.ts";
import { McpAppView } from "./mcp-app-view.ts";

const MCP_APP_VIEW_ELEMENT_NAME = `test-mcp-app-view-${crypto.randomUUID()}`;

// Keep the mounted view and i18n controller in the current module graph when
// the non-isolated runner has retained an earlier production registration.
class TestMcpAppView extends McpAppView {}

customElements.define(MCP_APP_VIEW_ELEMENT_NAME, TestMcpAppView);

describe("mcp-app-view localization", () => {
  afterEach(async () => {
    document.body.replaceChildren();
    await i18n.setLocale("en");
  });

  it("renders gateway failures with localized copy", async () => {
    i18n.registerTranslation("pt-BR", {
      mcpApp: {
        title: "Aplicativo MCP",
        unavailable: "Aplicativo MCP indisponível: {error}",
      },
    });
    await i18n.setLocale("pt-BR");

    const view = document.createElement(MCP_APP_VIEW_ELEMENT_NAME) as McpAppView;
    view.sessionKey = "agent:main:main";
    view.viewId = "view-1";
    document.body.append(view);

    await expect
      .poll(() => view.shadowRoot?.querySelector(".error")?.textContent)
      .toBe("Aplicativo MCP indisponível: MCP App gateway unavailable");
  });
});
