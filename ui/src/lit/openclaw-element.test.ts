import { html } from "lit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { i18n, t } from "../i18n/index.ts";
import { OpenClawLightDomElement, OpenClawLitElement } from "./openclaw-element.ts";

const LIGHT_ELEMENT_NAME = "test-openclaw-light-dom-element";
const SHADOW_ELEMENT_NAME = "test-openclaw-shadow-dom-element";

class TestLightDomElement extends OpenClawLightDomElement {
  renderCount = 0;

  override render() {
    this.renderCount += 1;
    return html`<span>${t("common.refresh")}</span>`;
  }
}

class TestShadowDomElement extends OpenClawLitElement {
  override render() {
    return html`<span>shadow content</span>`;
  }
}

if (!customElements.get(LIGHT_ELEMENT_NAME)) {
  customElements.define(LIGHT_ELEMENT_NAME, TestLightDomElement);
}
if (!customElements.get(SHADOW_ELEMENT_NAME)) {
  customElements.define(SHADOW_ELEMENT_NAME, TestShadowDomElement);
}

describe("OpenClaw Lit elements", () => {
  beforeEach(async () => {
    await i18n.setLocale("en");
  });

  afterEach(async () => {
    document.body.replaceChildren();
    await i18n.setLocale("en");
  });

  it("provides explicit light- and shadow-DOM bases", async () => {
    const light = document.createElement(LIGHT_ELEMENT_NAME) as TestLightDomElement;
    const shadow = document.createElement(SHADOW_ELEMENT_NAME) as TestShadowDomElement;
    document.body.append(light, shadow);

    await Promise.all([light.updateComplete, shadow.updateComplete]);

    expect(light.shadowRoot).toBeNull();
    expect(light.textContent).toContain("Refresh");
    expect(shadow.shadowRoot?.textContent).toContain("shadow content");
  });

  it("tracks locale changes across disconnect and reconnect", async () => {
    const element = document.createElement(LIGHT_ELEMENT_NAME) as TestLightDomElement;
    document.body.append(element);
    await element.updateComplete;

    const initialRenderCount = element.renderCount;
    await i18n.setLocale("zh-CN");
    await element.updateComplete;
    expect(element.textContent).toContain("刷新");
    expect(element.renderCount).toBe(initialRenderCount + 1);

    element.remove();
    const disconnectedRenderCount = element.renderCount;
    await i18n.setLocale("en");
    expect(element.renderCount).toBe(disconnectedRenderCount);

    document.body.append(element);
    await element.updateComplete;
    expect(element.textContent).toContain("Refresh");
    expect(element.renderCount).toBe(disconnectedRenderCount + 1);
  });
});
