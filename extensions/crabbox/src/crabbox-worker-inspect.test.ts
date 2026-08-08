import { describe, expect, it } from "vitest";
import { parseInspectJson } from "./crabbox-worker-inspect.js";

function inspectJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ id: "cbx_012345abcdef", state: "running", ...overrides });
}

describe("Crabbox worker inspect", () => {
  it("defaults missing SSH fallback ports to an empty list", () => {
    expect(parseInspectJson(inspectJson()).sshFallbackPorts).toStrictEqual([]);
  });

  it("normalizes SSH fallback ports in stable order without primary duplicates", () => {
    expect(
      parseInspectJson(
        inspectJson({
          sshPort: "2222",
          sshFallbackPorts: [22, "2200", "22", 2222, "2200"],
        }),
      ).sshFallbackPorts,
    ).toStrictEqual([22, 2200]);
  });

  it.each([null, "22", [""], ["22x"], [0], [65_536], [22.5], [null]])(
    "rejects invalid SSH fallback ports %#",
    (sshFallbackPorts) => {
      expect(() => parseInspectJson(inspectJson({ sshFallbackPorts }))).toThrow(
        "invalid sshFallbackPorts",
      );
    },
  );
});
