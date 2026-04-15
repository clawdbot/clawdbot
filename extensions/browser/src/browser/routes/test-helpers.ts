import type { BrowserResponse, BrowserRouteHandler, BrowserRouteRegistrar } from "./types.js";

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
