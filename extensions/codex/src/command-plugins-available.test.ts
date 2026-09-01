import { describe, expect, it, vi } from "vitest";
import type { v2 } from "./app-server/protocol.js";
import { splitArgs } from "./command-handler-args.js";
import { handleCodexPluginsSubcommand } from "./command-plugins-management.js";
import {
  buttonCommands,
  fakeCtx,
  inMemoryIO,
  pluginRuntime,
  pluginSummary,
} from "./command-plugins-management.test-support.js";

function catalogRuntime(description = "Review project notes") {
  return {
    ...pluginRuntime(),
    list: vi.fn(
      async () =>
        ({
          marketplaces: [
            {
              name: "company-tools",
              path: "/repo/company/marketplace.json",
              plugins: [
                ...Array.from({ length: 35 }, (_, index) =>
                  pluginSummary(`catalog-${String(index).padStart(2, "0")}`, "company-tools", {
                    interface: { shortDescription: description },
                  }),
                ),
                pluginSummary("github", "company-tools", {
                  installed: true,
                  enabled: true,
                  interface: { shortDescription: "Read pull requests" },
                }),
              ],
            },
            {
              name: "openai-curated-remote",
              plugins: [
                pluginSummary("github", "openai-curated-remote", {
                  availability: "DISABLED_BY_ADMIN",
                  interface: { shortDescription: "Inspect issues" },
                }),
              ],
            },
          ],
          marketplaceLoadErrors: [],
          featuredPluginIds: [],
        }) satisfies v2.PluginListResponse,
    ),
  };
}

describe("Codex available plugin search and pages", () => {
  it("searches the full catalog before paging and preserves source and availability", async () => {
    const runtime = catalogRuntime();
    const io = inMemoryIO();
    const mutate = vi.spyOn(io, "mutate");
    const result = await handleCodexPluginsSubcommand(
      fakeCtx,
      ["available", "GitHub"],
      io,
      runtime,
    );

    expect(result.text).toContain("github@company-tools (installed)");
    expect(result.text).toContain("github@openai-curated-remote (unavailable)");
    expect(result.text).toContain("of 2");
    expect(result.text).not.toContain("catalog-00@");
    expect(runtime.install).not.toHaveBeenCalled();
    expect(mutate).not.toHaveBeenCalled();

    const description = await handleCodexPluginsSubcommand(
      fakeCtx,
      ["available", "PULL", "REQUESTS"],
      io,
      runtime,
    );
    expect(description.text).toContain("github@company-tools");
    expect(description.text).not.toContain("github@openai-curated-remote");
  });

  it("makes every result reachable through the returned page commands", async () => {
    const runtime = catalogRuntime();
    const io = inMemoryIO();
    let result = await handleCodexPluginsSubcommand(fakeCtx, ["available"], io, runtime);
    expect(result.text).toContain("Showing 1–10 of 37");
    expect(result.text).not.toContain("catalog-10@");
    const pluginRows = (text: string | undefined) =>
      [...(text ?? "").matchAll(/^- ([a-z0-9-]+@[a-z0-9-]+) \(/gm)].map((match) => match[1]);
    const seen = pluginRows(result.text);
    for (const page of [2, 3, 4]) {
      const next = buttonCommands(result).find((command) => command.includes(`--page ${page}`));
      expect(next).toBeDefined();
      result = await handleCodexPluginsSubcommand(fakeCtx, splitArgs(next).slice(2), io, runtime);
      expect(result.text).toContain(`page ${page}/4`);
      seen.push(...pluginRows(result.text));
    }
    expect(seen).toHaveLength(37);
    expect(new Set(seen).size).toBe(37);
    expect(result.text).toContain("Showing 31–37 of 37");
    expect(result.text).toContain("github@company-tools");
    const previous = buttonCommands(result).find((command) => command.includes("--page 3"));
    const restored = await handleCodexPluginsSubcommand(
      fakeCtx,
      splitArgs(previous).slice(2),
      io,
      runtime,
    );
    expect(restored.text).toContain("Showing 21–30 of 37");
    expect(restored.text).not.toContain("github@company-tools");
  });

  it("round-trips quoted multiword search text through pagination", async () => {
    const query = "Owner's --page notes";
    const runtime = catalogRuntime(query);
    const io = inMemoryIO();
    const first = await handleCodexPluginsSubcommand(
      fakeCtx,
      ["available", "--", query],
      io,
      runtime,
    );
    const next = buttonCommands(first).find((command) => command.includes("--page 2"));
    const second = await handleCodexPluginsSubcommand(
      fakeCtx,
      splitArgs(next).slice(2),
      io,
      runtime,
    );
    expect(second.text).toContain("Showing 11–20 of 35");
    expect(second.text).toContain(query);
    expect(second.text).not.toContain("github@");
  });

  it("gives useful recovery for no matches and a page beyond the results", async () => {
    const runtime = catalogRuntime();
    const io = inMemoryIO();
    const empty = await handleCodexPluginsSubcommand(
      fakeCtx,
      ["available", "missing-plugin"],
      io,
      runtime,
    );
    expect(empty.text).toContain("No Codex plugins match");
    expect(buttonCommands(empty)).toContain("/codex plugins available");
    const outOfRange = await handleCodexPluginsSubcommand(
      fakeCtx,
      ["available", "github", "--page", "2"],
      io,
      runtime,
    );
    expect(outOfRange.text).toContain("No plugin page 2");
    const firstPage = buttonCommands(outOfRange).find((command) => command.includes("--page 1"));
    const recovered = await handleCodexPluginsSubcommand(
      fakeCtx,
      splitArgs(firstPage).slice(2),
      io,
      runtime,
    );
    expect(recovered.text).toContain("of 2");
    expect(recovered.text).toContain("github@company-tools");
  });

  it.each([["--page"], ["--page", "0"], ["--page", "1.5"], ["--page", "NaN"], ["x".repeat(101)]])(
    "rejects invalid options before discovery: %j",
    async (...args) => {
      const runtime = catalogRuntime();
      const result = await handleCodexPluginsSubcommand(
        fakeCtx,
        ["available", ...args],
        inMemoryIO(),
        runtime,
      );
      expect(result.text).toContain("Usage:");
      expect(runtime.workspaceDir).not.toHaveBeenCalled();
      expect(runtime.list).not.toHaveBeenCalled();
    },
  );

  it("checks operator authority before searching", async () => {
    const runtime = catalogRuntime();
    const result = await handleCodexPluginsSubcommand(
      { ...fakeCtx, senderIsOwner: false, gatewayClientScopes: ["operator.write"] },
      ["available", "github"],
      inMemoryIO(),
      runtime,
    );
    expect(result.text).toContain("Only an owner or operator.admin");
    expect(runtime.workspaceDir).not.toHaveBeenCalled();
    expect(runtime.list).not.toHaveBeenCalled();
  });
});
