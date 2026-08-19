import { describe, expect, it } from "vitest";
import {
  bindGatewayContextResolver,
  getGatewayContextResolver,
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
});
