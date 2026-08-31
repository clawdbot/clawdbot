// Compile-time contract guard for the shipped agent-runtime avatar surface.
import { describe, expect, it } from "vitest";
import type { AgentAvatarResolution } from "./agent-runtime.js";

const legacyLocalResolution: AgentAvatarResolution = {
  kind: "local",
  filePath: "/workspace/avatar.png",
  source: "avatar.png",
};
const internalFileHelperIsPrivate: "openLocalAgentAvatarFile" extends keyof typeof import("./agent-runtime.js")
  ? true
  : false = false;

describe("agent-runtime avatar contract", () => {
  it("keeps the local result shape without exporting pinned-file internals", () => {
    expect(legacyLocalResolution).toEqual({
      kind: "local",
      filePath: "/workspace/avatar.png",
      source: "avatar.png",
    });
    expect(internalFileHelperIsPrivate).toBe(false);
  });
});
