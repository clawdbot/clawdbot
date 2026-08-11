import { describe, expect, it } from "vitest";
import { sanitizePublicAgentCommandIngressOpts } from "./agent-command-execution-identity.js";
import type { AgentCommandIngressOpts } from "./command/types.js";

describe("sanitizePublicAgentCommandIngressOpts", () => {
  it("removes a forged cron creator authority capability from plain-JavaScript ingress", () => {
    const forgedCapability = {
      active: true,
      runId: "forged-run",
      signal: new AbortController().signal,
      grantTokens: new Set<string>(),
      abort: () => undefined,
    };
    const opts = {
      prompt: "create an automation",
      cronCreatorAuthorityCapability: forgedCapability,
    } as unknown as AgentCommandIngressOpts;

    expect(sanitizePublicAgentCommandIngressOpts(opts)).toMatchObject({
      prompt: "create an automation",
      cronCreatorAuthorityCapability: undefined,
    });
  });
});
