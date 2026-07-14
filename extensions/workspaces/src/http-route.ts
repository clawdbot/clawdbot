// Plugin HTTP route adapter for serving approved custom-widget assets.
//
// Registered with `auth:"plugin"` because sandboxed iframes carry no device
// token. The authenticated gateway mints a scoped asset capability first; the
// route validates it on every request. This adapter only translates the request;
// all capability, jail, approval, and header logic lives in `serve.ts`.

import type { IncomingMessage, ServerResponse } from "node:http";
import { serveWidgetAsset, WIDGETS_ROUTE_PREFIX } from "./serve.js";
import type { WorkspaceStore } from "./store.js";

export { WIDGETS_ROUTE_PREFIX };

type WidgetHttpRouteHandler = {
  handleHttpRequest: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;
};

/** Creates the HTTP route handler bound to the shared workspace store. */
export function createWidgetHttpRouteHandler(params: {
  store: WorkspaceStore;
  stateDir?: string;
}): WidgetHttpRouteHandler {
  return {
    async handleHttpRequest(req, res) {
      const url = new URL(req.url ?? "/", "http://localhost");
      return await serveWidgetAsset({ method: req.method, pathname: url.pathname }, res, {
        store: params.store,
        ...(params.stateDir ? { stateDir: params.stateDir } : {}),
      });
    },
  };
}
