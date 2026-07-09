import { LitElement } from "lit";
import { I18nController } from "../i18n/lib/lit-controller.ts";

/** Lit base that refreshes the element when the active locale changes. */
export abstract class OpenClawLitElement extends LitElement {
  protected readonly i18nController = new I18nController(this);
}

/** OpenClaw Lit base for components styled by the shared light-DOM stylesheet. */
export abstract class OpenClawLightDomElement extends OpenClawLitElement {
  override createRenderRoot() {
    return this;
  }
}
