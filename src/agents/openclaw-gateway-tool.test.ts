// Verifies the read-only OpenClaw gateway tool schema and config reads.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GatewayClientRequestError } from "../gateway/client.js";
import { createGatewayTool } from "./tools/gateway-tool.js";
import { callGatewayTool } from "./tools/gateway.js";

const { callGatewayToolMock, readGatewayCallOptionsMock } = vi.hoisted(() => ({
  callGatewayToolMock: vi.fn(),
  readGatewayCallOptionsMock: vi.fn(() => ({})),
}));

vi.mock("./tools/gateway.js", () => ({
  callGatewayTool: callGatewayToolMock,
  readGatewayCallOptions: readGatewayCallOptionsMock,
}));

type GatewayCall = [method: string, options: unknown, params?: unknown];

function gatewayCall(method: string): GatewayCall {
  const call = (vi.mocked(callGatewayTool).mock.calls as GatewayCall[]).find(
    ([candidate]) => candidate === method,
  );
  if (!call) {
    throw new Error(`Expected gateway call for ${method}`);
  }
  return call;
}

function expectRecordFields(
  record: unknown,
  expected: Record<string, unknown>,
): Record<string, unknown> {
  if (!record || typeof record !== "object") {
    throw new Error("Expected record");
  }
  const actual = record as Record<string, unknown>;
  for (const [key, value] of Object.entries(expected)) {
    expect(actual[key]).toEqual(value);
  }
  return actual;
}

describe("gateway tool", () => {
  beforeEach(() => {
    callGatewayToolMock.mockClear();
    readGatewayCallOptionsMock.mockClear();
    callGatewayToolMock.mockImplementation(async (method: string) => {
      if (method === "config.get") {
        return {
          hash: "hash-1",
          config: {
            tools: {
              exec: {
                ask: "on-miss",
                security: "allowlist",
              },
            },
          },
        };
      }
      if (method === "config.schema.lookup") {
        return {
          path: "gateway.auth",
          schema: { type: "object" },
          hint: { label: "Gateway Auth" },
          hintPath: "gateway.auth",
          children: [
            {
              key: "token",
              path: "gateway.auth.token",
              type: "string",
              required: true,
              hasChildren: false,
              hint: { label: "Token", sensitive: true },
              hintPath: "gateway.auth.token",
            },
          ],
        };
      }
      return { ok: true };
    });
  });

  it("exposes only config read actions", () => {
    const tool = createGatewayTool();
    const parameters = tool.parameters as {
      properties?: { action?: { enum?: string[] } };
    };

    expect(parameters.properties?.action?.enum).toEqual(["config.get", "config.schema.lookup"]);
    expect(tool.description).toBe(
      "Read gateway config + schema. Writes/restart: use openclaw tool.",
    );
  });

  it("scopes config.get output to the requested path and keeps metadata compact", async () => {
    const result = await createGatewayTool().execute("call-config-get", {
      action: "config.get",
      path: "tools.exec",
    });

    expect(result.details).toEqual({ ok: true });
    expect(result.content).toEqual([
      {
        type: "text",
        text: JSON.stringify(
          {
            ok: true,
            result: {
              hash: "hash-1",
              path: "tools.exec",
              config: {
                ask: "on-miss",
                security: "allowlist",
              },
            },
          },
          null,
          2,
        ),
      },
    ]);
  });

  it.each([
    ["tools.missing", "config path not found: tools.missing"],
    ["...", "config path not found: ..."],
    ["constructor.prototype", "config path not found: constructor.prototype"],
  ])("rejects invalid config.get path %s", async (path, message) => {
    await expect(
      createGatewayTool().execute("call-invalid-config-path", {
        action: "config.get",
        path,
      }),
    ).rejects.toThrow(message);
  });

  it("reads config.get paths with bracketed array indexes", async () => {
    callGatewayToolMock.mockResolvedValueOnce({
      config: {
        agents: {
          list: [{ id: "ops" }],
        },
      },
    });

    const result = await createGatewayTool().execute("call-indexed-config-path", {
      action: "config.get",
      path: "agents.list[0].id",
    });

    expect(result.content).toEqual([
      {
        type: "text",
        text: JSON.stringify(
          {
            ok: true,
            result: {
              path: "agents.list[0].id",
              config: "ops",
            },
          },
          null,
          2,
        ),
      },
    ]);
  });

  it("requires a narrower config.get path for oversized output", async () => {
    callGatewayToolMock.mockResolvedValueOnce({
      config: { oversized: "x".repeat(100_000) },
    });

    await expect(
      createGatewayTool().execute("call-large-config", {
        action: "config.get",
      }),
    ).rejects.toThrow(
      "config.get response is too large; use path to request a narrower config subtree",
    );
  });

  it("returns a path-scoped schema lookup result", async () => {
    const result = await createGatewayTool().execute("call-schema", {
      action: "config.schema.lookup",
      path: "gateway.auth",
    });

    expect(gatewayCall("config.schema.lookup")[2]).toEqual({ path: "gateway.auth" });
    const details = expectRecordFields(result.details, { ok: true });
    const lookupResult = expectRecordFields(details.result, {
      path: "gateway.auth",
      hintPath: "gateway.auth",
    });
    const children = lookupResult.children as Array<unknown>;
    expect(children).toHaveLength(1);
    expectRecordFields(children[0], {
      key: "token",
      path: "gateway.auth.token",
      required: true,
      hintPath: "gateway.auth.token",
    });
  });

  it("returns an in-band schema lookup miss for unknown paths", async () => {
    callGatewayToolMock.mockRejectedValueOnce(
      new GatewayClientRequestError({
        code: "INVALID_REQUEST",
        message: "config schema path not found",
      }),
    );

    const result = await createGatewayTool().execute("call-missing-schema", {
      action: "config.schema.lookup",
      path: "agents.main.authorizedSenders",
    });

    expect(gatewayCall("config.schema.lookup")[2]).toEqual({
      path: "agents.main.authorizedSenders",
    });
    expect(result.details).toEqual({
      ok: false,
      code: "schema_path_not_found",
      path: "agents.main.authorizedSenders",
      message: "config schema path not found",
    });
  });
});
