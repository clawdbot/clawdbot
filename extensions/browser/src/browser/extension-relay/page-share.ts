import { requestHeartbeat } from "openclaw/plugin-sdk/heartbeat-runtime";
import { wrapExternalContent } from "openclaw/plugin-sdk/security-runtime";
import {
  enqueueSystemEvent,
  resolveMainSessionKeyFromConfig,
} from "openclaw/plugin-sdk/system-event-runtime";
import type { PageSharePayload } from "./relay-protocol.js";

export const PAGE_SHARE_GATEWAY_REQUIRED_ERROR =
  "Send to OpenClaw needs the extension relay hosted by the Gateway (pair on the Gateway host or use direct Gateway pairing). Node-hosted relays are not supported yet.";

type PageShareSink = {
  enqueueSystemEvent(text: string, opts: { sessionKey: string }): unknown;
  requestHeartbeat(opts: { source: "other"; intent: "immediate"; reason: string }): unknown;
  resolveMainSessionKey(): string;
};

let pageShareSink: PageShareSink | null = null;

export function setPageShareSink(sink: PageShareSink | null): void {
  // Sink presence marks a Gateway process with the main agent loop. Node-hosted
  // relays never set it, preventing page shares from black-holing there.
  pageShareSink = sink;
}

export function createGatewayPageShareSink(): PageShareSink {
  return {
    enqueueSystemEvent,
    requestHeartbeat,
    resolveMainSessionKey: resolveMainSessionKeyFromConfig,
  };
}

export async function deliverPageShare(payload: PageSharePayload): Promise<void> {
  const sink = pageShareSink;
  if (!sink) {
    throw new Error(PAGE_SHARE_GATEWAY_REQUIRED_ERROR);
  }

  const note = payload.note?.trim();
  // Title and URL are page-controlled; they must stay inside the untrusted
  // boundary or a hostile <title> becomes trusted header text. Only the static
  // framing and the user's own note may sit outside the wrapper.
  const body = payload.selection?.trim() || payload.content;
  const wrapped = wrapExternalContent(`Title: ${payload.title}\nURL: ${payload.url}\n\n${body}`, {
    source: "browser",
  });
  const header = [
    "Page shared from the OpenClaw Chrome extension.",
    ...(note ? [`Note: ${note}`] : []),
  ].join("\n");
  const text = `${header}\n\n${wrapped}`;

  await sink.enqueueSystemEvent(text, { sessionKey: sink.resolveMainSessionKey() });
  await sink.requestHeartbeat({
    source: "other",
    intent: "immediate",
    reason: "browser-page-share",
  });
}
