import { describe, expect, it } from "vitest";
import { acceptsClaudeLive, resolveClaudeLiveMode } from "./claude-live-session-policy.js";
import type { PreparedCliRunContext } from "./types.js";

describe("resolveClaudeLiveMode", () => {
  it("keeps root on Claude default permissions while preserving YOLO elsewhere", () => {
    expect(resolveClaudeLiveMode("full", "off", 0)).toBe("default");
    expect(resolveClaudeLiveMode("full", "off", 1000)).toBe("bypassPermissions");
  });

  it("keeps restrictive OpenClaw policies on Claude default permissions", () => {
    expect(resolveClaudeLiveMode("allowlist", "on-miss", 1000)).toBe("default");
  });
});

describe("acceptsClaudeLive", () => {
  it("accepts only local Claude stdin/jsonl stdio contexts", () => {
    const context = {
      params: { sessionEntry: {} },
      backendResolved: { id: "claude-cli" },
      preparedBackend: {
        backend: { liveSession: "claude-stdio", output: "jsonl", input: "stdin" },
      },
    } as unknown as PreparedCliRunContext;

    expect(acceptsClaudeLive(context)).toBe(true);
    expect(
      acceptsClaudeLive({
        ...context,
        params: { ...context.params, sessionEntry: { execHost: "node" } },
      } as unknown as PreparedCliRunContext),
    ).toBe(false);
    expect(
      acceptsClaudeLive({
        ...context,
        preparedBackend: {
          ...context.preparedBackend,
          backend: { ...context.preparedBackend.backend, output: "json" },
        },
      }),
    ).toBe(false);
  });
});
