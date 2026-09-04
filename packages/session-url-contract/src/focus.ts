import { normalizeControlUiBasePath } from "./grammar.js";

const FOCUS_SEGMENT = "/focus";

type ControlUiFocusDashboardTarget = {
  kind: "dashboard";
  /** Existing canonical dashboard route, including any search or hash suffix. */
  path: string;
};

type ControlUiFocusDesktopBuildTarget = {
  kind: "desktop";
  control?: boolean;
  source?: string | null;
  session?: string | null;
};

export type ControlUiFocusBuildTarget =
  | ControlUiFocusDashboardTarget
  | { kind: "terminal" }
  | ControlUiFocusDesktopBuildTarget;

export type ControlUiFocusTarget =
  | {
      kind: "dashboard";
      route: { pathname: string; search: string; hash: string };
    }
  | { kind: "terminal" }
  | {
      kind: "desktop";
      control: boolean;
      selector: { kind: "source" | "session"; value: string } | null;
    };

export type ControlUiFocusLocation =
  | { status: "valid"; basePath: string; target: ControlUiFocusTarget }
  | { status: "unsupported"; basePath: string };

type ControlUiFocusLocationInput = string | { pathname: string; search?: string; hash?: string };

function normalizePathname(pathname: string): string {
  const trimmed = pathname.trim();
  const withSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return withSlash.length > 1 ? withSlash.replace(/\/+$/u, "") : withSlash;
}

function splitPathSuffix(value: string): { pathname: string; suffix: string } {
  const queryIndex = value.indexOf("?");
  const hashIndex = value.indexOf("#");
  const suffixIndex = [queryIndex, hashIndex]
    .filter((index) => index >= 0)
    .reduce((first, index) => Math.min(first, index), value.length);
  return { pathname: value.slice(0, suffixIndex), suffix: value.slice(suffixIndex) };
}

function nonEmptyValue(value: string | null | undefined): string | null {
  return value && value.trim() ? value : null;
}

function decodeFocusValue(segment: string): { ok: true; value: string | null } | { ok: false } {
  try {
    return { ok: true, value: nonEmptyValue(decodeURIComponent(segment)) };
  } catch {
    return { ok: false };
  }
}

export function inferControlUiFocusBasePath(pathname: string): string | null {
  const normalizedPath = normalizePathname(pathname);
  const segments = normalizedPath.split("/").filter(Boolean);
  const focusIndexes = segments.flatMap((segment, index) =>
    segment === FOCUS_SEGMENT.slice(1) ? [index] : [],
  );
  if (focusIndexes.length === 0) {
    return null;
  }
  const supportsSuffix = (index: number): boolean => {
    const rest = segments.slice(index + 1);
    if (rest[0] === "terminal") {
      return rest.length === 1;
    }
    if (rest[0] === "dashboard") {
      return rest.length >= 2;
    }
    if (rest[0] !== "desktop") {
      return false;
    }
    const selectorIndex = rest[1] === "control" ? 2 : 1;
    return (
      rest.length === selectorIndex ||
      (rest.length === selectorIndex + 2 &&
        (rest[selectorIndex] === "source" || rest[selectorIndex] === "session"))
    );
  };
  let focusIndex = focusIndexes.at(-1) ?? 0;
  for (let index = focusIndexes.length - 1; index >= 0; index -= 1) {
    const candidate = focusIndexes[index];
    if (candidate !== undefined && supportsSuffix(candidate)) {
      focusIndex = candidate;
      break;
    }
  }
  return normalizeControlUiBasePath(segments.slice(0, focusIndex).join("/"));
}

export function isControlUiFocusPath(pathname: string, basePath = ""): boolean {
  const normalizedPath = normalizePathname(pathname);
  const root = `${normalizeControlUiBasePath(basePath)}${FOCUS_SEGMENT}`;
  return normalizedPath === root || normalizedPath.startsWith(`${root}/`);
}

export function buildControlUiFocusPath(
  target: Exclude<ControlUiFocusBuildTarget, ControlUiFocusDashboardTarget>,
  basePath?: string,
): string;
export function buildControlUiFocusPath(
  target: ControlUiFocusDashboardTarget,
  basePath?: string,
): string | null;
export function buildControlUiFocusPath(
  target: ControlUiFocusBuildTarget,
  basePath?: string,
): string | null;
export function buildControlUiFocusPath(
  target: ControlUiFocusBuildTarget,
  basePath = "",
): string | null {
  const base = normalizeControlUiBasePath(basePath);
  const root = `${base}${FOCUS_SEGMENT}`;
  if (target.kind === "terminal") {
    return `${root}/terminal`;
  }
  if (target.kind === "desktop") {
    const control = target.control === true ? "/control" : "";
    const source = nonEmptyValue(target.source);
    const session = nonEmptyValue(target.session);
    const selector = source
      ? `/source/${encodeURIComponent(source)}`
      : session
        ? `/session/${encodeURIComponent(session)}`
        : "";
    return `${root}/desktop${control}${selector}`;
  }
  const { pathname, suffix } = splitPathSuffix(target.path);
  const normalizedPath = normalizePathname(pathname);
  const dashboardRoot = `${base}/dashboard/`;
  if (!normalizedPath.startsWith(dashboardRoot)) {
    return null;
  }
  return `${root}${normalizedPath.slice(base.length)}${suffix}`;
}

export function parseControlUiFocusLocation(
  input: ControlUiFocusLocationInput,
  basePath?: string,
): ControlUiFocusLocation | null {
  const pathname = typeof input === "string" ? input : input.pathname;
  const search = typeof input === "string" ? "" : (input.search ?? "");
  const hash = typeof input === "string" ? "" : (input.hash ?? "");
  const normalizedPath = normalizePathname(pathname);
  const resolvedBasePath =
    basePath === undefined
      ? inferControlUiFocusBasePath(normalizedPath)
      : normalizeControlUiBasePath(basePath);
  if (resolvedBasePath === null || !isControlUiFocusPath(normalizedPath, resolvedBasePath)) {
    return null;
  }
  const root = `${resolvedBasePath}${FOCUS_SEGMENT}`;
  const rest = normalizedPath.slice(root.length + 1);
  if (rest === "terminal") {
    return { status: "valid", basePath: resolvedBasePath, target: { kind: "terminal" } };
  }
  if (rest.startsWith("dashboard/") && rest.length > "dashboard/".length) {
    return {
      status: "valid",
      basePath: resolvedBasePath,
      target: {
        kind: "dashboard",
        route: { pathname: `${resolvedBasePath}/${rest}`, search, hash },
      },
    };
  }

  const segments = rest.split("/");
  if (segments[0] !== "desktop") {
    return { status: "unsupported", basePath: resolvedBasePath };
  }
  let index = 1;
  const control = segments[index] === "control";
  if (control) {
    index += 1;
  }
  if (segments.length === index) {
    return {
      status: "valid",
      basePath: resolvedBasePath,
      target: { kind: "desktop", control, selector: null },
    };
  }
  const selectorKind = segments[index];
  const encodedValue = segments[index + 1];
  if (
    segments.length !== index + 2 ||
    (selectorKind !== "source" && selectorKind !== "session") ||
    encodedValue === undefined
  ) {
    return { status: "unsupported", basePath: resolvedBasePath };
  }
  const decoded = decodeFocusValue(encodedValue);
  if (!decoded.ok) {
    return { status: "unsupported", basePath: resolvedBasePath };
  }
  if (!decoded.value) {
    return {
      status: "valid",
      basePath: resolvedBasePath,
      target: { kind: "desktop", control, selector: null },
    };
  }
  return {
    status: "valid",
    basePath: resolvedBasePath,
    target: {
      kind: "desktop",
      control,
      selector: { kind: selectorKind, value: decoded.value },
    },
  };
}
