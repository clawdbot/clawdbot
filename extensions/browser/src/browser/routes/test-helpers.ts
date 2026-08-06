/**
 * Lightweight browser route test helpers.
 *
 * Provides an in-memory route registrar and response object for focused route
 * unit tests without standing up the HTTP server.
 */
import type { BrowserResponse, BrowserRouteRegistrar } from "./types.js";

type BrowserRouteHandler = Parameters<BrowserRouteRegistrar["get"]>[1];

/** Create an in-memory route app that records handlers by method and path. */
export function createBrowserRouteApp() {
  const getHandlers = new Map<string, BrowserRouteHandler>();
  const postHandlers = new Map<string, BrowserRouteHandler>();
  const deleteHandlers = new Map<string, BrowserRouteHandler>();
  const app: BrowserRouteRegistrar = {
    get: (path, handler) => void getHandlers.set(path, handler),
    post: (path, handler) => void postHandlers.set(path, handler),
    delete: (path, handler) => void deleteHandlers.set(path, handler),
  };
  return { app, getHandlers, postHandlers, deleteHandlers };
}

/** Create a minimal response object that captures status and JSON body. */
export function createBrowserRouteResponse() {
  let statusCode = 200;
  let jsonBody: unknown;
  const res: BrowserResponse = {
    status(code) {
      statusCode = code;
      return res;
    },
    json(body) {
      jsonBody = body;
    },
  };
  return {
    res,
    get statusCode() {
      return statusCode;
    },
    get body() {
      return jsonBody;
    },
  };
}
