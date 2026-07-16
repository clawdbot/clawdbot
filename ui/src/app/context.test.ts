import { consume } from "@lit/context";
import { LitElement } from "lit";
import { afterEach, describe, expect, it } from "vitest";
import type { RouteId } from "../app-route-paths.ts";
import { createApplicationContextProvider } from "../test-helpers/application-context.ts";
import { applicationContext, type ApplicationContext } from "./context.ts";

const CONSUMER_ELEMENT_NAME = "test-application-context-consumer";

class TestApplicationContextConsumer extends LitElement {
  @consume({ context: applicationContext, subscribe: true })
  context?: ApplicationContext<RouteId>;
}

if (!customElements.get(CONSUMER_ELEMENT_NAME)) {
  customElements.define(CONSUMER_ELEMENT_NAME, TestApplicationContextConsumer);
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("application context consumption", () => {
  it("rebinds a retained consumer after its provider value changes while disconnected", async () => {
    const initialContext = { basePath: "/initial" } as ApplicationContext<RouteId>;
    const replacementContext = { basePath: "/replacement" } as ApplicationContext<RouteId>;
    const provider = createApplicationContextProvider(initialContext);
    const consumer = document.createElement(
      CONSUMER_ELEMENT_NAME,
    ) as TestApplicationContextConsumer;

    document.body.append(provider);
    provider.append(consumer);
    await consumer.updateComplete;
    expect(consumer.context).toBe(initialContext);

    consumer.remove();
    provider.setContext(replacementContext);
    provider.append(consumer);
    await consumer.updateComplete;

    expect(consumer.context).toBe(replacementContext);
  });
});
