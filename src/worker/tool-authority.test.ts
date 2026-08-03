import { describe, expect, it } from "vitest";
import { toWorkerExecConfig } from "./tool-authority.js";

describe("worker tool authority", () => {
  it("preserves auto identity without replaying other modes over resolved approval bounds", () => {
    expect(toWorkerExecConfig({ mode: "auto", security: "allowlist", ask: "on-miss" })).toEqual({
      host: "gateway",
      mode: "auto",
      security: "allowlist",
      ask: "on-miss",
    });
    expect(toWorkerExecConfig({ mode: "ask", security: "full", ask: "always" })).toEqual({
      host: "gateway",
      security: "full",
      ask: "always",
    });
    expect(toWorkerExecConfig({ mode: "full", security: "full", ask: "on-miss" })).toEqual({
      host: "gateway",
      security: "full",
      ask: "on-miss",
    });
  });
});
