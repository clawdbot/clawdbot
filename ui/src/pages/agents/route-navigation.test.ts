import { describe, expect, it, vi } from "vitest";
import type { ApplicationContext } from "../../app/context.ts";
import {
  navigateToAgent,
  navigateToAgentPanel,
  syncAgentsCanonicalLocation,
} from "./route-navigation.ts";

function context() {
  return {
    basePath: "/ui",
    navigate: vi.fn(),
    replace: vi.fn(),
  } as unknown as Pick<ApplicationContext, "basePath" | "navigate" | "replace">;
}

describe("Agents route navigation", () => {
  it("pushes agent and panel selections without mutating route state", () => {
    const navigation = context();

    navigateToAgent(navigation, "research", "main", "tools");
    expect(navigation.navigate).toHaveBeenCalledWith("agents", {
      pathname: "/ui/settings/agents/research/tools",
    });

    navigateToAgentPanel(navigation, "main", "tools", "memory");
    expect(navigation.navigate).toHaveBeenCalledWith("agents", {
      pathname: "/ui/settings/agents/main/memory",
    });
  });

  it("uses the concise agent path for the default panel and ignores no-op selections", () => {
    const navigation = context();

    navigateToAgent(navigation, "research", "main", "files");
    expect(navigation.navigate).toHaveBeenCalledWith("agents", {
      pathname: "/ui/settings/agents/research",
    });
    navigateToAgent(navigation, "main", "main", "files");
    navigateToAgentPanel(navigation, "main", "files", "files");
    expect(navigation.navigate).toHaveBeenCalledOnce();
  });

  it("performs at most one replace per legacy source location", () => {
    const navigation = context();
    const routeData = {
      location: {
        pathname: "/ui/settings/agents",
        search: "?agent=research&probe=1",
        hash: "#files",
      },
      canonicalLocation: {
        pathname: "/ui/settings/agents/research",
        search: "?probe=1",
        hash: "#files",
      },
    };

    const normalized = syncAgentsCanonicalLocation(navigation, routeData, "");
    expect(navigation.replace).toHaveBeenCalledOnce();
    expect(navigation.replace).toHaveBeenCalledWith("agents", routeData.canonicalLocation);

    expect(syncAgentsCanonicalLocation(navigation, routeData, normalized)).toBe(normalized);
    expect(navigation.replace).toHaveBeenCalledOnce();
    expect(syncAgentsCanonicalLocation(navigation, undefined, normalized)).toBe("");
  });
});
