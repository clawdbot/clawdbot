/**
 * Local browser control dispatch bridge.
 *
 * Starts the browser control service when needed and dispatches requests
 * through the in-process route dispatcher for local Browser tool calls.
 */
import {
  createBrowserControlContext,
  startBrowserControlServiceFromConfig,
} from "./control-service.js";
import {
  createBrowserRouteDispatcher,
  type BrowserDispatchRequest,
  type BrowserDispatchResponse,
} from "./routes/dispatcher.js";

/** Dispatch one browser-control request through the local in-process router. */
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
