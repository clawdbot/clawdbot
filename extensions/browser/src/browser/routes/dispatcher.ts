/**
 * Browser route dispatcher.
 *
 * Provides an in-process request/response adapter so Gateway nodes can invoke
 * the same route handlers without opening an HTTP socket.
 */
import type { BrowserRouteContext } from "../server-context.js";
import {
  createBrowserRouteDispatcherCore,
  type BrowserDispatchRequest,
  type BrowserDispatchResponse,
} from "./dispatcher-core.js";
import { registerBrowserRoutes } from "./index.js";

/** Create an in-process dispatcher for registered browser routes. */
export function createBrowserRouteDispatcher(ctx: BrowserRouteContext) {
  return createBrowserRouteDispatcherCore({ ctx, register: registerBrowserRoutes });
}

export type { BrowserDispatchRequest, BrowserDispatchResponse };
