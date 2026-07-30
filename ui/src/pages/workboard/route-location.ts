import type { RouteLocation } from "@openclaw/uirouter";
import { isValidWorkboardBoardId } from "@openclaw/workboard-contract";
import {
  INTERNAL_WORKBOARD_PATH_PARAM,
  pathForRoute,
  pathForWorkboardBoard,
  workboardBoardIdFromPath,
} from "../../app-route-paths.ts";
import { WORKBOARD_ALL_BOARDS_FILTER } from "./board-filter.ts";

export type WorkboardRouteData = {
  boardFilter: string;
  canonicalLocation?: RouteLocation;
  search: string;
};

export function workboardRouteLocation(location: RouteLocation): RouteLocation {
  const params = new URLSearchParams(location.search);
  // The router's private bridge must not masquerade as the public legacy
  // `board` query, or its canonical redirect survives after the real path wins.
  const pathname = params.get(INTERNAL_WORKBOARD_PATH_PARAM) ?? location.pathname;
  params.delete(INTERNAL_WORKBOARD_PATH_PARAM);
  const search = params.toString();
  return {
    pathname,
    search: search ? `?${search}` : "",
    hash: location.hash,
  };
}

export function resolveWorkboardRouteLocation(
  sourceLocation: RouteLocation,
  basePath = "",
): WorkboardRouteData {
  const location = workboardRouteLocation(sourceLocation);
  const pathBoardId = workboardBoardIdFromPath(location.pathname, basePath);
  if (pathBoardId) {
    const params = new URLSearchParams(location.search);
    const hadLegacyBoard = params.has("board");
    params.delete("board");
    const search = params.toString();
    return {
      boardFilter: pathBoardId,
      search: search ? `?${search}` : "",
      ...(hadLegacyBoard
        ? {
            canonicalLocation: {
              pathname: pathForWorkboardBoard(pathBoardId, basePath),
              search: search ? `?${search}` : "",
              hash: location.hash,
            },
          }
        : {}),
    };
  }
  const params = new URLSearchParams(location.search);
  if (!params.has("board")) {
    return { boardFilter: WORKBOARD_ALL_BOARDS_FILTER, search: location.search };
  }
  const legacyBoardValue = params.get("board")?.trim() ?? "";
  params.delete("board");
  const search = params.toString();
  const boardFilter = isValidWorkboardBoardId(legacyBoardValue)
    ? legacyBoardValue
    : WORKBOARD_ALL_BOARDS_FILTER;
  return {
    boardFilter,
    search: search ? `?${search}` : "",
    canonicalLocation: {
      pathname:
        boardFilter === WORKBOARD_ALL_BOARDS_FILTER
          ? pathForRoute("workboard", basePath)
          : pathForWorkboardBoard(boardFilter, basePath),
      search: search ? `?${search}` : "",
      hash: location.hash,
    },
  };
}
