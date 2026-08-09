import "./embedded-agent-subscribe.tools.js";

type EmbeddedSubscribeToolsTestApi = {
  isToolResultMediaTrusted(
    toolName?: string,
    result?: unknown,
    trustedLocalMediaToolNames?: ReadonlySet<string>,
  ): boolean;
};

function getTestApi(): EmbeddedSubscribeToolsTestApi {
  const api = (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.embeddedSubscribeToolsTestApi")
  ];
  if (!api) {
    throw new Error("embedded subscribe tools test API is unavailable");
  }
  return api as EmbeddedSubscribeToolsTestApi;
}

export function isToolResultMediaTrusted(
  toolName?: string,
  result?: unknown,
  trustedLocalMediaToolNames?: ReadonlySet<string>,
): boolean {
  return getTestApi().isToolResultMediaTrusted(toolName, result, trustedLocalMediaToolNames);
}
