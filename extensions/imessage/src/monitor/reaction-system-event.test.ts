import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { enqueueSystemEvent } from "openclaw/plugin-sdk/system-event-runtime";
import { describe, expect, it, vi } from "vitest";
import { enqueueIMessageReactionSystemEvent } from "./reaction-system-event.js";

vi.mock("openclaw/plugin-sdk/system-event-runtime", () => ({
  enqueueSystemEvent: vi.fn(() => true),
}));

describe("enqueueIMessageReactionSystemEvent", () => {
  it("matches Discord by enqueueing inbound reactions as untrusted system events", () => {
    const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() } satisfies RuntimeEnv;
    const logVerbose = vi.fn();

    const queued = enqueueIMessageReactionSystemEvent({
      decision: {
        text: "iMessage reaction added: 👎 by +15555550123 on msg lobster-reply-guid",
        contextKey: "imessage:reaction:added:3:lobster-reply-guid:+15555550123:👎",
        route: { sessionKey: "agent:main:main" },
        reaction: {
          targetGuid: "lobster-reply-guid",
          action: "added",
          emoji: "👎",
        },
      },
      runtime,
      logVerbose,
    });

    expect(queued).toBe(true);
    expect(enqueueSystemEvent).toHaveBeenCalledWith(
      "iMessage reaction added: 👎 by +15555550123 on msg lobster-reply-guid",
      {
        sessionKey: "agent:main:main",
        contextKey: "imessage:reaction:added:3:lobster-reply-guid:+15555550123:👎",
        trusted: false,
      },
    );
    expect(runtime.log).toHaveBeenCalledWith(
      "imessage: reaction system event queued session=agent:main:main target=lobster-reply-guid action=added emoji=👎",
    );
    expect(logVerbose).toHaveBeenCalledWith(
      "imessage: reaction event enqueued: iMessage reaction added: 👎 by +15555550123 on msg lobster-reply-guid",
    );
  });
});
