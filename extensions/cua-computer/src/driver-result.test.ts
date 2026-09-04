import { describe, expect, it } from "vitest";
import {
  CUA_DRIVER_CONTRACT_FIXTURES,
  cuaToolResult,
} from "./cua-driver-contract.test-fixtures.js";
import type { CuaToolResult } from "./driver-client.js";
import { browserObservation, windowObservation } from "./driver-result.js";

const observations = [
  { kind: "window", mimeType: "image/png", fields: CUA_DRIVER_CONTRACT_FIXTURES.windowState },
  { kind: "zoom", mimeType: "image/jpeg", fields: { width: 300, height: 200, format: "jpeg" } },
  { kind: "browser", mimeType: "image/png", fields: CUA_DRIVER_CONTRACT_FIXTURES.browserSnapshot },
] as const;

function project(kind: (typeof observations)[number]["kind"], result: CuaToolResult) {
  const state = { generation: "test-generation" };
  return kind === "browser"
    ? browserObservation(result, state, {
        browserRef: "test-browser",
        pageRef: "test-page",
        targetId: CUA_DRIVER_CONTRACT_FIXTURES.browserSnapshot.target_id,
        tabId: CUA_DRIVER_CONTRACT_FIXTURES.browserSnapshot.tab_id,
      })
    : windowObservation(result, state, "test-window", { fromZoom: kind === "zoom" });
}

describe.each(observations)("CUA $kind observation images", ({ kind, mimeType, fields }) => {
  it("keeps an observation without inventing an image when capture is absent", () => {
    const result = project(kind, cuaToolResult(fields));
    expect(result.observation?.observationId).toMatch(/^cua:v2:observation:/);
    expect(result.observation).not.toHaveProperty("base64");
    expect(result.observation).not.toHaveProperty("format");
  });

  it("rejects malformed base64 for the supported image format", () => {
    const result = cuaToolResult(fields);
    result.images = [{ mimeType, dataBase64: "invalid base64!" }];
    expect(() => project(kind, result)).toThrow("COMPUTER_DRIVER_ERROR");
  });
});
