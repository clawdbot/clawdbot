import { afterEach, describe, expect, it } from "vitest";
import {
  SESSION_MCP_RUNTIME_MANAGER_KEY,
  shouldLoadRequesterScopedMcpHarnessRuntime,
} from "./agent-bundle-mcp-runtime-shared.js";

const globalStore = globalThis as Record<PropertyKey, unknown>;
const originalManager = globalStore[SESSION_MCP_RUNTIME_MANAGER_KEY];

afterEach(() => {
  if (originalManager === undefined) {
    delete globalStore[SESSION_MCP_RUNTIME_MANAGER_KEY];
  } else {
    globalStore[SESSION_MCP_RUNTIME_MANAGER_KEY] = originalManager;
  }
});

describe("requester-scoped MCP harness preflight", () => {
  it("skips the runtime graph without a requester or advertised catalog", () => {
    delete globalStore[SESSION_MCP_RUNTIME_MANAGER_KEY];

    expect(
      shouldLoadRequesterScopedMcpHarnessRuntime({
        sessionId: "session-1",
        requesterSenderId: "  ",
      }),
    ).toBe(false);
  });

  it("loads for an authenticated requester", () => {
    expect(
      shouldLoadRequesterScopedMcpHarnessRuntime({
        sessionId: "session-1",
        requesterSenderId: "sender-1",
      }),
    ).toBe(true);
  });

  it("loads advertised stubs for an unauthenticated requester", () => {
    globalStore[SESSION_MCP_RUNTIME_MANAGER_KEY] = {
      getAdvertisedScopedCatalog: (sessionId: string) =>
        sessionId === "session-1" ? { servers: {}, tools: [{}] } : null,
    };

    expect(
      shouldLoadRequesterScopedMcpHarnessRuntime({
        sessionId: "session-1",
      }),
    ).toBe(true);
  });
});
