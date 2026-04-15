import { escapeRegExp } from "../../utils.js";
import type { BrowserRouteContext } from "../server-context.js";
import { registerBrowserRoutes } from "./index.js";
import type { BrowserRequest, BrowserResponse, BrowserRouteRegistrar } from "./types.js";

type BrowserDispatchRequest = {
  method: "GET" | "POST" | "DELETE";
  path: string;
  query?: Record<string, unknown>;
  body?: unknown;
  signal?: AbortSignal;
};

type BrowserDispatchResponse = {
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

function createRegistry() {
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
  return { routes, router };
}

function normalizePath(path: string) {
  if (!path) {
    return "/";
  }
  return path.startsWith("/") ? path : `/${path}`;
}

export function createBrowserRouteDispatcher(ctx: BrowserRouteContext) {
  const registry = createRegistry();
  registerBrowserRoutes(registry.router, ctx);

  return {
    dispatch: async (req: BrowserDispatchRequest): Promise<BrowserDispatchResponse> => {
      const method = req.method;
      const path = normalizePath(req.path);
      const query = req.query ?? {};
      const body = req.body;
      const signal = req.signal;

      const match = registry.routes.find((route) => {
        if (route.method !== method) {
          return false;
        }
        return route.regex.test(path);
      });
      if (!match) {
        return { status: 404, body: { error: "Not Found" } };
      }

      const exec = match.regex.exec(path);
      const params: Record<string, string> = {};
      if (exec) {
        for (const [idx, name] of match.paramNames.entries()) {
          const value = exec[idx + 1];
          if (typeof value === "string") {
            try {
              params[name] = decodeURIComponent(value);
            } catch {
              return {
                status: 400,
                body: { error: `invalid path parameter encoding: ${name}` },
              };
            }
          }
        }
      }

      let status = 200;
      let payload: unknown = undefined;
      const res: BrowserResponse = {
        status(code) {
          status = code;
          return res;
        },
        json(bodyValue) {
          payload = bodyValue;
        },
      };

      try {
        await match.handler(
          {
            params,
            query,
            body,
            signal,
          },
          res,
        );
      } catch (err) {
        return { status: 500, body: { error: String(err) } };
      }

      return { status, body: payload };
    },
  };
}

export type { BrowserDispatchRequest, BrowserDispatchResponse };
