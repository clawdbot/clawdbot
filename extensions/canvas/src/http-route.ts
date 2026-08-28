import type { IncomingMessage, ServerResponse } from "node:http";
import { handleA2uiHttpRequest } from "./host/a2ui.js";

export function createCanvasHttpRouteHandler() {
  return {
    handleHttpRequest: (req: IncomingMessage, res: ServerResponse) =>
      handleA2uiHttpRequest(req, res),
  };
}
