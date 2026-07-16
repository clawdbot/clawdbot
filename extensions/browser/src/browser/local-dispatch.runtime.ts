import {
  createBrowserControlContext,
  startBrowserControlServiceFromConfig,
} from "./control-service.js";
import {
  createBrowserRouteDispatcher,
  type BrowserDispatchRequest,
  type BrowserDispatchResponse,
} from "./routes/dispatcher.js";

export async function dispatchBrowserControlRequest(
  req: BrowserDispatchRequest,
): Promise<BrowserDispatchResponse> {
  const started = await startBrowserControlServiceFromConfig();
  if (!started) {
    throw new Error("browser control disabled");
  }
  const dispatcher = createBrowserRouteDispatcher(createBrowserControlContext());
  return await dispatcher.dispatch(req);
}
