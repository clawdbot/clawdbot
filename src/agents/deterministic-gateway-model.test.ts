import { describe, expect, it } from "vitest";
import {
  DETERMINISTIC_GATEWAY_REPLY,
  isDeterministicGatewayModel,
  isDeterministicNoteModel,
} from "./deterministic-gateway-model.js";

describe("deterministic gateway models", () => {
  it("accepts dummy/dummy and dummy/note", () => {
    expect(isDeterministicGatewayModel("dummy", "dummy")).toBe(true);
    expect(isDeterministicGatewayModel("dummy", "note")).toBe(true);
    expect(isDeterministicGatewayModel("dummy", "other")).toBe(false);
  });

  it("loads the dummy response and identifies the NOTE model", () => {
    expect(DETERMINISTIC_GATEWAY_REPLY).toBe(
      "Not a valid command. Use /tools to see available commands.",
    );
    expect(isDeterministicNoteModel("dummy", "note")).toBe(true);
    expect(isDeterministicNoteModel("dummy", "dummy")).toBe(false);
  });
});
