import { html } from "lit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { i18n, t } from "../i18n/index.ts";
import {
  OpenClawLightDomContentsElement,
  OpenClawLightDomElement,
  OpenClawLitElement,
} from "./openclaw-element.ts";

const LIGHT_ELEMENT_NAME = "test-openclaw-light-dom-element";
const LIGHT_CONTENTS_ELEMENT_NAME = "test-openclaw-light-dom-contents-element";
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

class TestLightDomContentsElement extends OpenClawLightDomContentsElement {
  override render() {
    return html`<span>contents</span>`;
  }
}

if (!customElements.get(LIGHT_ELEMENT_NAME)) {
  customElements.define(LIGHT_ELEMENT_NAME, TestLightDomElement);
}
if (!customElements.get(SHADOW_ELEMENT_NAME)) {
  customElements.define(SHADOW_ELEMENT_NAME, TestShadowDomElement);
}
if (!customElements.get(LIGHT_CONTENTS_ELEMENT_NAME)) {
  customElements.define(LIGHT_CONTENTS_ELEMENT_NAME, TestLightDomContentsElement);
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
    const contents = document.createElement(
      LIGHT_CONTENTS_ELEMENT_NAME,
    ) as TestLightDomContentsElement;
    const shadow = document.createElement(SHADOW_ELEMENT_NAME) as TestShadowDomElement;
    document.body.append(light, contents, shadow);

    await Promise.all([light.updateComplete, contents.updateComplete, shadow.updateComplete]);

    expect(light.shadowRoot).toBeNull();
    expect(light.textContent).toContain("Refresh");
    expect(contents.shadowRoot).toBeNull();
    expect(contents.style.display).toBe("contents");
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
