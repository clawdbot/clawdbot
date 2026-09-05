import {
  buildControlUiSessionPath,
  type ControlUiSessionNamespace,
} from "@openclaw/session-url-contract";

type SessionPathDetails = {
  displayName?: string | null;
  exactKey?: boolean;
  mainKey?: string | null;
  shortIdLength?: number;
};

export function pathForSession(
  face: ControlUiSessionNamespace,
  agentId: string,
  sessionKey: string,
  basePath = "",
  details: SessionPathDetails = {},
): string | null {
  return buildControlUiSessionPath({
    namespace: face,
    sessionKey,
    fallbackAgentId: agentId,
    basePath,
    displayName: details.displayName ?? undefined,
    exactKey: details.exactKey,
    mainKey: details.mainKey ?? undefined,
    shortIdLength: details.shortIdLength,
  });
}
