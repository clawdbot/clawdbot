import AjvModule from "ajv";
import { describe, expect, it } from "vitest";
import { AgentParamsSchema } from "./agent.js";
import { internalProtocolField, stripInternalProtocolFields } from "./internal-fields.js";

type ValidateFunction = ((value: unknown) => boolean) & { errors?: unknown };
type AjvConstructor = new (options: { allErrors: boolean }) => {
  compile: (schema: object) => ValidateFunction;
};

function isAjvConstructor(value: unknown): value is AjvConstructor {
  return typeof value === "function";
}

function resolveAjvConstructor(value: unknown): AjvConstructor {
  if (isAjvConstructor(value)) {
    return value;
  }
  if (
    typeof value === "object" &&
    value !== null &&
    "default" in value &&
    isAjvConstructor(value.default)
  ) {
    return value.default;
  }
  throw new TypeError("Ajv module did not expose a constructor");
}

const Ajv = resolveAjvConstructor(AjvModule);
const ajv = new Ajv({ allErrors: true });
const validate = ajv.compile(AgentParamsSchema);

describe("AgentParamsSchema", () => {
  const baseParams = {
    message: "test message",
    idempotencyKey: "test-key-123",
  };
  const traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

  it("accepts minimal valid params", () => {
    const valid = validate(baseParams);
    expect(valid).toBe(true);
  });

  it("accepts drainsContinuationDelegateQueue: true", () => {
    const valid = validate({
      ...baseParams,
      drainsContinuationDelegateQueue: true,
    });
    expect(valid).toBe(true);
    expect(validate.errors).toBeNull();
  });

  it("accepts drainsContinuationDelegateQueue: false", () => {
    const valid = validate({
      ...baseParams,
      drainsContinuationDelegateQueue: false,
    });
    expect(valid).toBe(true);
  });

  it("marks runner-only knobs as internal for public protocol generators", () => {
    const properties = AgentParamsSchema.properties as Record<
      string,
      { "x-openclaw-internal"?: boolean }
    >;

    expect(properties.continuationTrigger?.["x-openclaw-internal"]).toBe(true);
    expect(properties.drainsContinuationDelegateQueue?.["x-openclaw-internal"]).toBe(true);
    expect(properties.traceparent?.["x-openclaw-internal"]).toBe(true);
  });

  it("omits runner-only knobs from public generated schema copies", () => {
    const publicSchema = stripInternalProtocolFields(AgentParamsSchema);

    expect(publicSchema).not.toBe(AgentParamsSchema);
    if (!publicSchema) {
      throw new Error("expected public AgentParams schema");
    }
    expect(publicSchema.properties).not.toHaveProperty("continuationTrigger");
    expect(publicSchema.properties).not.toHaveProperty("drainsContinuationDelegateQueue");
    expect(publicSchema.properties).not.toHaveProperty("traceparent");
    expect(AgentParamsSchema.properties).toHaveProperty("continuationTrigger");
    expect(AgentParamsSchema.properties).toHaveProperty("drainsContinuationDelegateQueue");
    expect(AgentParamsSchema.properties).toHaveProperty("traceparent");
  });

  it("omits whole schemas marked internal", () => {
    const publicSchema = stripInternalProtocolFields(
      internalProtocolField({
        type: "object",
        properties: { secret: { type: "string" } },
      }),
    );

    expect(publicSchema).toBeUndefined();
  });

  it("accepts params without drainsContinuationDelegateQueue (optional)", () => {
    const valid = validate(baseParams);
    expect(valid).toBe(true);
  });

  it("rejects unknown additional properties", () => {
    const valid = validate({
      ...baseParams,
      notARealField: "should fail",
    });
    expect(valid).toBe(false);
  });

  it("accepts the full spawn payload shape from spawnSubagentDirect", () => {
    const valid = validate({
      ...baseParams,
      deliver: false,
      lane: "subagent",
      drainsContinuationDelegateQueue: true,
      continuationTrigger: "delegate-return",
      traceparent,
    });
    expect(valid).toBe(true);
    expect(validate.errors).toBeNull();
  });

  it("rejects malformed inherited traceparent values", () => {
    const valid = validate({
      ...baseParams,
      traceparent: "not-a-traceparent",
    });
    expect(valid).toBe(false);
  });
});
