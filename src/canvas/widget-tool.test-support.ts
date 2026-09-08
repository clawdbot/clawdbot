import { vi } from "vitest";
import type { InProcessGatewayCaller } from "../agents/tools/in-process-gateway.js";

export function createBoardPutCaller() {
  const mock = vi.fn(async (_method: string, params: Record<string, unknown>) => ({
    sessionKey: params.sessionKey,
    revision: 1,
    tabs: [{ tabId: "main", title: "Main", position: 0, chatDock: "right" }],
    widgets: [
      {
        name: params.name,
        tabId: "main",
        contentKind: "plugin",
        pluginKind: "diagram:diagram",
        sizeW: 6,
        sizeH: 4,
        position: 0,
        grantState: "none",
        revision: 1,
      },
    ],
    resolvedWidgetName: params.name,
  }));
  const callGateway: InProcessGatewayCaller = async <T>(
    method: string,
    params: Record<string, unknown>,
  ): Promise<T> => (await mock(method, params)) as T;
  return { mock, callGateway };
}
