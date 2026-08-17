import { describe, expect, it, vi } from "vitest";
import type { RuntimeConfigCapability } from "../../lib/config/runtime-config-capability.ts";
import { clearAgentSkillFilter } from "./skills.ts";

describe("clearAgentSkillFilter", () => {
  it("deletes the authored allowlist through an explicit config patch", async () => {
    const patch = vi.fn(async () => true);
    const runtimeConfig = {
      agentEntry: vi.fn(() => ({
        path: ["agents", "entries", "Research"],
        entry: { skills: ["coding-agent"] },
      })),
      patch,
    } as unknown as RuntimeConfigCapability;

    await expect(clearAgentSkillFilter(runtimeConfig, "research")).resolves.toBe(true);

    expect(patch).toHaveBeenCalledWith({
      raw: {
        agents: {
          entries: {
            Research: { skills: null },
          },
        },
      },
      note: "Reset agent skills to inherited defaults",
      replacePaths: ["agents.entries.Research.skills"],
      canDispatch: expect.any(Function),
    });
  });

  it("does not queue a patch after its caller becomes stale", async () => {
    const patch = vi.fn(async () => true);
    const runtimeConfig = {
      agentEntry: vi.fn(() => ({
        path: ["agents", "entries", "main"],
        entry: { skills: ["coding-agent"] },
      })),
      patch,
    } as unknown as RuntimeConfigCapability;

    await expect(clearAgentSkillFilter(runtimeConfig, "main", () => false)).resolves.toBe(false);
    expect(patch).not.toHaveBeenCalled();
  });

  it("clears a list-form allowlist without creating an entries shadow", async () => {
    const patch = vi.fn(async () => true);
    const runtimeConfig = {
      agentEntry: vi.fn(() => ({
        path: ["agents", "list", 0],
        entry: { id: "main", skills: ["coding-agent"] },
      })),
      patch,
    } as unknown as RuntimeConfigCapability;

    await expect(clearAgentSkillFilter(runtimeConfig, "main")).resolves.toBe(true);

    expect(patch).toHaveBeenCalledWith({
      raw: { agents: { list: [{ id: "main", skills: null }] } },
      note: "Reset agent skills to inherited defaults",
      replacePaths: ["agents.list[].skills"],
      canDispatch: expect.any(Function),
    });
  });
});
