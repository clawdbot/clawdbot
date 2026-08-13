import { normalizeRouteBasePath, normalizeRoutePath } from "@openclaw/uirouter";

const DESKTOP_DOCUMENT_PATH = "/desktop";

type DesktopDocumentLocation = Pick<Location, "pathname" | "search">;

type DesktopDocumentOptions = {
  source: string | null;
  control: boolean;
};

function desktopDocumentPath(basePath = ""): string {
  return `${normalizeRouteBasePath(basePath)}${DESKTOP_DOCUMENT_PATH}`;
}

export function isDesktopDocumentPath(pathname: string, basePath: string): boolean {
  return normalizeRoutePath(pathname) === desktopDocumentPath(basePath);
}

export function isDesktopOnlyView(
  location: DesktopDocumentLocation | undefined = globalThis.location,
  basePath = "",
): boolean {
  return (
    new URLSearchParams(location?.search ?? "").get("view") === "desktop" ||
    isDesktopDocumentPath(location?.pathname ?? "/", basePath)
  );
}

export function desktopDocumentOptions(
  location: Pick<DesktopDocumentLocation, "search"> | undefined = globalThis.location,
): DesktopDocumentOptions {
  const search = new URLSearchParams(location?.search ?? "");
  return {
    source: search.get("source"),
    control: search.get("control") === "1",
  };
}
