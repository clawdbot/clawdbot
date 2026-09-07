import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as execApprovals from "../infra/exec-approvals.js";
import { withMockedPlatform } from "../test-utils/vitest-spies.js";
import { buildRuntimeFactsContext } from "./runtime-facts-prompt.js";

const params = { capabilityToolNames: new Set(["exec"]), agentId: "main", cfg: {} };
afterEach(() => vi.restoreAllMocks());

describe("approved executable runtime facts", () => {
  it("sorts current agent and wildcard hints, preserves paths and argument notes, and clears stale hints", () =>
    withMockedPlatform("win32", () => {
      const file: execApprovals.ExecApprovalsFile = {
        version: 1,
        agents: {
          main: { allowlist: [{ pattern: "C:\\Tools\\z.exe", argPattern: "--version" }] },
          "*": { allowlist: [{ pattern: "C:\\Tools\\a.exe" }] },
          other: { allowlist: [{ pattern: "C:\\Private\\other.exe" }] },
        },
      };
      vi.spyOn(execApprovals, "loadExecApprovals").mockImplementation(() => file);
      expect(buildRuntimeFactsContext(params)).toEqual([
        { kind: "conversation-data", text: expect.any(String) },
      ]);
      const before = buildRuntimeFactsContext(params).at(0)?.text;
      expect(before).toContain("## Approved executables");
      expect(before).toContain(
        "exact arguments are enforced at runtime; no approval prompt needed when args match",
      );
      expect(before).toContain(
        "C:\\Tools\\a.exe (any arguments)\n  C:\\Tools\\z.exe (restricted args)",
      );
      expect(before).not.toContain("other.exe");
      file.agents!.main!.allowlist!.unshift({ pattern: "C:\\Tools\\b.exe" });
      const added = buildRuntimeFactsContext(params).at(0)?.text;
      expect(added).toContain("b.exe (any arguments)");
      file.agents!.main!.allowlist!.reverse();
      expect(buildRuntimeFactsContext(params).at(0)?.text).toBe(added);
      file.agents = {};
      expect(buildRuntimeFactsContext(params).at(0)?.text).toBe("## Approved executables\nnone");
    }));

  it("bounds hints and omits command approvals, global wildcards, bare names, and unsafe or oversized tokens", () =>
    withMockedPlatform("win32", () => {
      vi.spyOn(execApprovals, "loadExecApprovals").mockReturnValue({
        version: 1,
        agents: {
          main: {
            allowlist: [
              ...[
                "*",
                "node",
                "=command:C:\\Tools\\node.exe --version",
                "C:\\bad\nname.exe",
                `C:\\${"x".repeat(300)}.exe`,
              ].map((pattern) => ({ pattern })),
              ...Array.from({ length: 12 }, (_, i) => ({
                pattern: `C:\\Tools\\app${String(i).padStart(2, "0")}.exe`,
              })).toReversed(),
            ],
          },
        },
      });
      const facts = expectDefined(
        buildRuntimeFactsContext(params).at(0),
        "approved executable facts",
      ).text;
      expect(facts.match(/\(any arguments\)/g)).toHaveLength(10);
      expect(facts).toContain("app00.exe");
      expect(facts).toContain("app09.exe");
      expect(facts).not.toMatch(/app10|app11|=command:|bad|xxx/);
      expect(facts.length).toBeLessThan(3000);
    }));

  it.each(["linux", "darwin", "win32"] as const)(
    "gates approval reads on Windows and exec capability: %s",
    (platform) =>
      withMockedPlatform(platform, () => {
        const load = vi.spyOn(execApprovals, "loadExecApprovals").mockImplementation(() => {
          throw new Error("unavailable");
        });
        expect(
          buildRuntimeFactsContext({ ...params, capabilityToolNames: new Set(["read"]) }),
        ).toEqual([]);
        expect(load).not.toHaveBeenCalled();
        const facts = buildRuntimeFactsContext(params).at(0)?.text;
        if (platform === "win32") {
          expect(facts).toBe("## Approved executables\nunavailable");
        } else {
          expect(facts).toBeUndefined();
          expect(load).not.toHaveBeenCalled();
        }
      }),
  );
});
