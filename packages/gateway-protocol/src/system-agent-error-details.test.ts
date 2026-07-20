import { describe, expect, it } from "vitest";
import {
  buildSystemAgentSessionInvalidatedErrorDetails,
  readSystemAgentSessionInvalidatedErrorDetails,
  SystemAgentErrorDetailCodes,
} from "./system-agent-error-details.js";

describe("system-agent error details", () => {
  it("round-trips a session invalidation marker", () => {
    const details = buildSystemAgentSessionInvalidatedErrorDetails();

    expect(details).toEqual({ code: "system_agent_session_invalidated" });
    expect(readSystemAgentSessionInvalidatedErrorDetails(details)).toEqual(details);
  });

  it.each([undefined, null, [], {}, { code: "other" }])(
    "rejects an unrelated details payload: %j",
    (details) => {
      expect(readSystemAgentSessionInvalidatedErrorDetails(details)).toBeUndefined();
    },
  );

  it("exports the stable marker", () => {
    expect(SystemAgentErrorDetailCodes.SESSION_INVALIDATED).toBe(
      "system_agent_session_invalidated",
    );
  });
});
