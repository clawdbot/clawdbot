// Session model projection tests verify ACP metadata reads preserve row ownership.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";

const readAcpSessionMeta = vi.hoisted(() => vi.fn(() => undefined));

vi.mock("../acp/runtime/session-meta.js", () => ({ readAcpSessionMeta }));

import { resolveGatewaySessionThinkingProjectionInternal } from "./session-utils-model.js";

describe("resolveGatewaySessionThinkingProjectionInternal", () => {
  beforeEach(() => {
    readAcpSessionMeta.mockClear();
  });

  it("reads bare-key ACP metadata under the resolved row owner", () => {
    const cfg: OpenClawConfig = {
      session: { scope: "global", store: "/tmp/shared.sqlite" },
      agents: {
        ownership: "explicit",
        defaults: { sessionStore: { agentId: "ops" } },
        entries: { ops: {}, research: {} },
      },
    };

    resolveGatewaySessionThinkingProjectionInternal({
      cfg,
      agentId: "ops",
      provider: "openai",
      model: "gpt-5.6-sol",
      sessionKey: "global",
    });

    expect(readAcpSessionMeta).toHaveBeenCalledWith({ sessionKey: "global", agentId: "ops" });
  });
});
