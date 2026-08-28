import { describe, expect, it } from "vitest";
import {
  bindGatewayContextResolver,
  getGatewayContextResolver,
  getSharedGatewayContextResolver,
} from "../../../plugins/runtime/gateway-request-scope.js";
import { createSubagentRunRecord } from "../../subagent-test-fixtures.test-helpers.js";

describe("subagent Gateway context binding", () => {
  it("keeps successor routing private and excludes restored rows", () => {
    const context = { owner: "gateway-a" } as never;
    const resolver = () => context;
    const source = createSubagentRunRecord({ runId: "run-source" });
    const successor = createSubagentRunRecord({ runId: "run-successor" });
    const restored = structuredClone(source);

    bindGatewayContextResolver(source, resolver);
    bindGatewayContextResolver(successor, getGatewayContextResolver(source));

    expect(getGatewayContextResolver(successor)?.()).toBe(context);
    expect(getGatewayContextResolver(restored)).toBeUndefined();
  });

  it.each(["distinct", "first-unbound", "second-unbound"])(
    "rejects a %s settle batch without losing its binding",
    (mode) => {
      const first = createSubagentRunRecord({ runId: "run-first" });
      const second = createSubagentRunRecord({ runId: "run-second" });
      const firstContext = { owner: "gateway-a" } as never;
      const secondContext = { owner: "gateway-b" } as never;
      if (mode !== "first-unbound") bindGatewayContextResolver(first, () => firstContext);
      if (mode !== "second-unbound") bindGatewayContextResolver(second, () => secondContext);

      const shared = getSharedGatewayContextResolver([first, second]);
      expect(shared).toBeTypeOf("function");
      expect(shared?.()).toBeUndefined();
    },
  );

  it("preserves a shared owner and leaves wholly unbound batches unbound", () => {
    const first = {};
    const second = {};
    const resolver = () => ({ owner: "gateway-a" }) as never;
    expect(getSharedGatewayContextResolver([])).toBeUndefined();
    expect(getSharedGatewayContextResolver([first, second])).toBeUndefined();
    bindGatewayContextResolver(first, resolver);
    bindGatewayContextResolver(second, resolver);
    expect(getSharedGatewayContextResolver([first, second])).toBe(resolver);
  });
});
