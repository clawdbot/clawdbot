// Mattermost tests cover the documented public helper API.
import { describe, expect, it } from "vitest";
import { buildButtonAttachments } from "./api.js";

describe("@openclaw/mattermost api", () => {
  it("exports the interactive-button attachment builder", () => {
    expect(typeof buildButtonAttachments).toBe("function");
  });
});
