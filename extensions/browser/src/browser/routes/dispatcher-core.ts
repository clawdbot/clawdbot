import { escapeRegExp } from "../../utils.js";
import { normalizeBrowserRequestPath } from "../request-policy.js";
import type { BrowserRouteContext } from "../server-context.js";
import type { BrowserRequest, BrowserResponse, BrowserRouteRegistrar } from "./types.js";

export type BrowserDispatchRequest = {
  method: "GET" | "POST" | "DELETE";
  path: string;
  query?: Record<string, unknown>;
  body?: unknown;
  signal?: AbortSignal;
};

export type BrowserDispatchResponse = {
  status: number;
  body: unknown;
};

type RouteEntry = {
  method: BrowserDispatchRequest["method"];
  path: string;
  regex: RegExp;
  paramNames: string[];
  handler: (req: BrowserRequest, res: BrowserResponse) => void | Promise<void>;
};

function compileRoute(path: string): { regex: RegExp; paramNames: string[] } {
  const paramNames: string[] = [];
  const parts = path.split("/").map((part) => {
    if (part.startsWith(":")) {
      const name = part.slice(1);
      paramNames.push(name);
      return "([^/]+)";
    }
    return escapeRegExp(part);
  });
  return { regex: new RegExp(`^${parts.join("/")}$`), paramNames };
}

/** Build an in-process dispatcher from a selected set of Browser route owners. */
export function createBrowserRouteDispatcherCore(params: {
  ctx: BrowserRouteContext;
  register: (app: BrowserRouteRegistrar, ctx: BrowserRouteContext) => void;
}) {
  const routes: RouteEntry[] = [];
  const register =
    (method: RouteEntry["method"]) => (path: string, handler: RouteEntry["handler"]) => {
      const { regex, paramNames } = compileRoute(path);
      routes.push({ method, path, regex, paramNames, handler });
    };
  const router: BrowserRouteRegistrar = {
    get: register("GET"),
    post: register("POST"),
    delete: register("DELETE"),
  };
  params.register(router, params.ctx);

  return {
    dispatch: async (req: BrowserDispatchRequest): Promise<BrowserDispatchResponse> => {
      const path = normalizeBrowserRequestPath(req.path) || "/";
      const match = routes.find((route) => route.method === req.method && route.regex.test(path));
      if (!match) {
        return { status: 404, body: { error: "Not Found" } };
      }

      const exec = match.regex.exec(path);
      const routeParams: Record<string, string> = {};
      if (exec) {
        for (const [index, name] of match.paramNames.entries()) {
          const value = exec[index + 1];
          if (typeof value !== "string") {
            continue;
          }
          try {
            routeParams[name] = decodeURIComponent(value);
          } catch {
            return { status: 400, body: { error: `invalid path parameter encoding: ${name}` } };
          }
        }
      }

      let status = 200;
      let payload: unknown;
      const response: BrowserResponse = {
        status(code) {
          status = code;
          return response;
        },
        json(body) {
          payload = body;
        },
      };

      try {
        await match.handler(
          {
            params: routeParams,
            query: req.query ?? {},
            body: req.body,
            signal: req.signal,
          },
          response,
        );
      } catch (error) {
        return { status: 500, body: { error: String(error) } };
      }
      return { status, body: payload };
    },
  };
}
