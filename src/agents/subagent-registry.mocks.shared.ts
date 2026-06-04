/**
 * Shared subagent registry mocks.
 *
 * Tests import this module to hoist gateway/event mocks consistently before
 * registry modules resolve their runtime dependencies.
 */
import { vi } from "vitest";

const noop = () => {};
const sharedMocks = vi.hoisted(() => ({
  callGateway: vi.fn(async () => ({
    status: "ok" as const,
    startedAt: 111,
    endedAt: 222,
  })),
  onAgentEvent: vi.fn(() => noop),
}));

vi.mock("../gateway/call.js", () => ({
  callGateway: sharedMocks.callGateway,
}));

vi.mock("../infra/agent-events.js", () => ({
  onAgentEvent: sharedMocks.onAgentEvent,
}));
