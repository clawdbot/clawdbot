import { normalizeRouteBasePath, normalizeRoutePath } from "@openclaw/uirouter";

const TERMINAL_DOCUMENT_PATH = "/terminal";

type TerminalDocumentLocation = Pick<Location, "pathname" | "search">;

export function terminalDocumentPath(basePath = ""): string {
  return `${normalizeRouteBasePath(basePath)}${TERMINAL_DOCUMENT_PATH}`;
}

export function isTerminalDocumentPath(pathname: string, basePath: string): boolean {
  return normalizeRoutePath(pathname) === terminalDocumentPath(basePath);
}

export function isTerminalOnlyView(
  location: TerminalDocumentLocation | undefined = globalThis.location,
  basePath = "",
): boolean {
  return (
    new URLSearchParams(location?.search ?? "").get("view") === "terminal" ||
    isTerminalDocumentPath(location?.pathname ?? "/", basePath)
  );
}
