import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { enqueueSystemEvent } from "openclaw/plugin-sdk/system-event-runtime";

export type IMessageReactionSystemEventDecision = {
  text: string;
  contextKey: string;
  route: {
    sessionKey: string;
  };
  reaction: {
    targetGuid?: string;
    action: "added" | "removed";
    emoji: string;
  };
};

export function enqueueIMessageReactionSystemEvent(params: {
  decision: IMessageReactionSystemEventDecision;
  runtime: RuntimeEnv;
  logVerbose?: (message: string) => void;
}): boolean {
  const { decision, runtime } = params;
  const queued = enqueueSystemEvent(decision.text, {
    sessionKey: decision.route.sessionKey,
    contextKey: decision.contextKey,
    trusted: false,
  });
  runtime.log?.(
    `imessage: reaction system event ${queued ? "queued" : "deduped"} session=${
      decision.route.sessionKey
    } target=${decision.reaction.targetGuid ?? "unknown"} action=${decision.reaction.action} emoji=${
      decision.reaction.emoji
    }`,
  );
  params.logVerbose?.(`imessage: reaction event enqueued: ${decision.text}`);
  return queued;
}
