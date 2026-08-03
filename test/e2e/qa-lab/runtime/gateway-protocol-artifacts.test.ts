import { describe, expect, it } from "vitest";
import {
  assertPublishedProtocolSchema,
  buildCanonicalProtocolSchema,
  buildSwiftProtocolCompatibilityHarness,
  parseGatewayProtocolArtifactOptions,
} from "./gateway-protocol-artifacts.js";

describe("Gateway protocol artifact producer", () => {
  it("parses one artifact directory", () => {
    expect(
      parseGatewayProtocolArtifactOptions(["--artifact-base", ".artifacts/protocol"], "/repo"),
    ).toEqual({
      artifactBase: "/repo/.artifacts/protocol",
      repoRoot: "/repo",
    });
    expect(() => parseGatewayProtocolArtifactOptions([])).toThrow("--artifact-base is required");
    expect(() =>
      parseGatewayProtocolArtifactOptions(["--artifact-base", "one", "--artifact-base", "two"]),
    ).toThrow("--artifact-base was provided more than once");
  });

  it("builds the same schema envelope as the protocol generator", () => {
    const request = { type: "object", properties: { type: { const: "req" } } };
    const canonical = buildCanonicalProtocolSchema(
      {
        ConnectParams: { type: "object" },
        EventFrame: { type: "object" },
        RequestFrame: request,
        ResponseFrame: { type: "object" },
      },
      [{ name: "health", scope: "operator.read", since: 1 }],
    );

    expect(canonical.definitions.RequestFrame).toEqual(request);
    expect(canonical.methods.health).toEqual({ scope: "operator.read", since: 1 });
    expect(canonical.discriminator.mapping.req).toBe("#/definitions/RequestFrame");
  });

  it("requires the published schema and built registry to match canonical definitions", () => {
    const definitions = {
      ConnectParams: { type: "object" },
      EventFrame: { type: "object" },
      RequestFrame: { type: "object" },
      ResponseFrame: { type: "object" },
    };
    const canonical = buildCanonicalProtocolSchema(definitions, []);

    expect(() =>
      assertPublishedProtocolSchema({
        builtSchemas: definitions,
        canonical,
        published: canonical,
      }),
    ).not.toThrow();
    expect(() =>
      assertPublishedProtocolSchema({
        builtSchemas: definitions,
        canonical,
        published: {
          ...canonical,
          definitions: {
            ...definitions,
            EventFrame: { type: "string" },
          },
        },
      }),
    ).toThrow("published protocol.schema.json differs");
  });

  it("builds a standalone Swift compatibility harness for the generated model artifact", () => {
    const harness = buildSwiftProtocolCompatibilityHarness();

    expect(harness).toContain("@main");
    expect(harness).toContain("GatewayFrame.self");
    expect(harness).toContain("ConnectParams.self");
    expect(harness).toContain('"futureField":true');
  });
});
