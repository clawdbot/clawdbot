import { describe, expect, it } from "vitest";
import type { GatewayRequestContext } from "../../../gateway/server-methods/types.js";
import {
  bindGatewayContextResolver,
  getGatewayContextResolver,
  getSharedGatewayContextResolver,
} from "../../../plugins/runtime/gateway-request-scope.js";
import { createSubagentRunRecord } from "../../subagent-test-fixtures.test-helpers.js";
import {
  getGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "../../tools/gateway-caller-context.js";

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
      if (mode !== "first-unbound") {
        bindGatewayContextResolver(first, () => firstContext);
      }
      if (mode !== "second-unbound") {
        bindGatewayContextResolver(second, () => secondContext);
      }

      const shared = getSharedGatewayContextResolver([first, second]);
      expect(shared).toBeTypeOf("function");
      expect(() => shared?.()).toThrow("incompatible Gateway");
    },
  );

  it.each([
    { retired: 0, closure: "closed" },
    { retired: 1, closure: "closed" },
    { retired: 0, closure: "replaced" },
    { retired: 1, closure: "replaced" },
    { retired: 0, closure: "throwing" },
    { retired: 1, closure: "throwing" },
  ])("rechecks caller $retired after its source is $closure", async ({ retired, closure }) => {
    const context = {} as GatewayRequestContext;
    const replacement = {} as GatewayRequestContext;
    const sources: Array<GatewayRequestContext | undefined> = [context, context];
    const owners = [{}, {}];
    let throwing = false;
    for (const [index, owner] of owners.entries()) {
      const resolver = await withGatewayToolCallerIdentity(
        {
          agentId: "main",
          sessionKey: "agent:main:main",
          gatewayContextResolver: () => {
            if (throwing && index === retired) {
              throw new Error("source closed");
            }
            return sources[index];
          },
        },
        () => getGatewayToolCallerIdentity()?.gatewayContextResolver,
      );
      bindGatewayContextResolver(owner, resolver);
    }
    expect(getGatewayContextResolver(owners[0]!)).not.toBe(getGatewayContextResolver(owners[1]!));
    const shared = getSharedGatewayContextResolver(owners);
    expect(shared?.()).toBe(context);
    // Rebinding a row cannot retarget a composition already captured by delivery.
    bindGatewayContextResolver(owners[retired]!, () => replacement);
    expect(shared?.()).toBe(context);
    throwing = closure === "throwing";
    sources[retired] = closure === "replaced" ? replacement : undefined;
    expect(shared?.()).toBeUndefined();
  });

  it("preserves a shared owner and leaves wholly unbound batches unbound", () => {
    const first = {};
    const second = {};
    const context = {} as GatewayRequestContext;
    let closed = false;
    const resolver = () => {
      if (closed) {
        throw new Error("source closed");
      }
      return context;
    };
    expect(getSharedGatewayContextResolver([])).toBeUndefined();
    expect(getSharedGatewayContextResolver([first, second])).toBeUndefined();
    bindGatewayContextResolver(first, resolver);
    bindGatewayContextResolver(second, resolver);
    const shared = getSharedGatewayContextResolver([first, second]);
    expect(shared?.()).toBe(context);
    closed = true;
    expect(shared?.()).toBeUndefined();
  });
});
