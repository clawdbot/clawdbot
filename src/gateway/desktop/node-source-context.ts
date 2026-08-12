import type { NodeDesktopService } from "./node-source.js";

export const NODE_DESKTOP_SERVICE_CONTEXT = Symbol("openclaw.nodeDesktopService");

type NodeDesktopServiceContext = {
  [NODE_DESKTOP_SERVICE_CONTEXT]?: NodeDesktopService;
};

export function getNodeDesktopService(context: object): NodeDesktopService | undefined {
  return (context as NodeDesktopServiceContext)[NODE_DESKTOP_SERVICE_CONTEXT];
}
