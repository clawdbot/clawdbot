import { describe, expect, it } from "vitest";
import { normalizeLlamaServerPayload } from "./stream.js";

describe("llama-server stream payload", () => {
  it("maps OpenAI nested JSON Schema to llama-server's direct schema field", () => {
    expect(
      normalizeLlamaServerPayload({
        model: "model",
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "openclaw_response",
            schema: {
              type: "object",
              properties: { ok: { type: "boolean" } },
              required: ["ok"],
            },
          },
        },
      }),
    ).toEqual({
      model: "model",
      response_format: {
        type: "json_object",
        schema: {
          type: "object",
          properties: { ok: { type: "boolean" } },
          required: ["ok"],
        },
      },
    });
  });

  it("maps llama-server's direct response-format schema to json_object", () => {
    expect(
      normalizeLlamaServerPayload({
        response_format: {
          type: "json_schema",
          schema: { type: "object", properties: { ok: { type: "boolean" } } },
        },
      }),
    ).toEqual({
      response_format: {
        type: "json_object",
        schema: { type: "object", properties: { ok: { type: "boolean" } } },
      },
    });
  });

  it("injects a requested schema when the shared transport omits it", () => {
    expect(
      normalizeLlamaServerPayload(
        { model: "model" },
        {
          type: "object",
          properties: { ok: { type: "boolean" } },
          required: ["ok"],
        },
      ),
    ).toEqual({
      model: "model",
      response_format: {
        type: "json_object",
        schema: {
          type: "object",
          properties: { ok: { type: "boolean" } },
          required: ["ok"],
        },
      },
    });
  });

  it("keeps non-schema response formats unchanged", () => {
    const payload = { response_format: { type: "json_object" } };
    expect(normalizeLlamaServerPayload(payload)).toEqual(payload);
  });
});
