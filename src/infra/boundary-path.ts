import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isNotFoundPathError, isPathInside } from "./path-guards.js";

type BoundaryPathIntent = "read" | "write" | "create" | "delete" | "stat";

export type BoundaryPathAliasPolicy = {
  allowFinalSymlinkForUnlink?: boolean;
  allowFinalHardlinkForUnlink?: boolean;
};

export const BOUNDARY_PATH_ALIAS_POLICIES = {
  strict: Object.freeze({
    allowFinalSymlinkForUnlink: false,
    allowFinalHardlinkForUnlink: false,
  }),
  unlinkTarget: Object.freeze({
    allowFinalSymlinkForUnlink: true,
    allowFinalHardlinkForUnlink: true,
  }),
} as const;

type ResolveBoundaryPathParams = {
  absolutePath: string;
  rootPath: string;
  boundaryLabel: string;
  intent?: BoundaryPathIntent;
  policy?: BoundaryPathAliasPolicy;
  skipLexicalRootCheck?: boolean;
  rootCanonicalPath?: string;
};

type ResolvedBoundaryPathKind = "missing" | "file" | "directory" | "symlink" | "other";

export type ResolvedBoundaryPath = {
  absolutePath: string;
  canonicalPath: string;
  rootPath: string;
  rootCanonicalPath: string;
  relativePath: string;
  exists: boolean;
  kind: ResolvedBoundaryPathKind;
};

export async function resolveBoundaryPath(
  params: ResolveBoundaryPathParams,
): Promise<ResolvedBoundaryPath> {
  const rootPath = path.resolve(params.rootPath);
  const absolutePath = path.resolve(params.absolutePath);
  const rootCanonicalPath = params.rootCanonicalPath
    ? path.resolve(params.rootCanonicalPath)
    : await resolvePathViaExistingAncestor(rootPath);
  const context = createBoundaryResolutionContext({
    resolveParams: params,
    rootPath,
    absolutePath,
    rootCanonicalPath,
    outsideLexicalCanonicalPath: await resolveOutsideLexicalCanonicalPathAsync({
      rootPath,
      absolutePath,
    }),
  });

  const outsideResult = await resolveOutsideBoundaryPathAsync({
    boundaryLabel: params.boundaryLabel,
    context,
  });
  if (outsideResult) {
    return outsideResult;
  }

  return resolveBoundaryPathLexicalAsync({
    params,
    absolutePath: context.absolutePath,
    rootPath: context.rootPath,
    rootCanonicalPath: context.rootCanonicalPath,
  });
}

export function resolveBoundaryPathSync(params: ResolveBoundaryPathParams): ResolvedBoundaryPath {
  const rootPath = path.resolve(params.rootPath);
  const absolutePath = path.resolve(params.absolutePath);
  const rootCanonicalPath = params.rootCanonicalPath
    ? path.resolve(params.rootCanonicalPath)
    : resolvePathViaExistingAncestorSync(rootPath);
  const context = createBoundaryResolutionContext({
    resolveParams: params,
    rootPath,
    absolutePath,
    rootCanonicalPath,
    outsideLexicalCanonicalPath: resolveOutsideLexicalCanonicalPathSync({
      rootPath,
      absolutePath,
    }),
  });

  const outsideResult = resolveOutsideBoundaryPathSync({
    boundaryLabel: params.boundaryLabel,
    context,
  });
  if (outsideResult) {
    return outsideResult;
  }

  return resolveBoundaryPathLexicalSync({
    params,
    absolutePath: context.absolutePath,
    rootPath: context.rootPath,
    rootCanonicalPath: context.rootCanonicalPath,
  });
}

type LexicalTraversalState = {
  segments: string[];
  allowFinalSymlink: boolean;
  canonicalCursor: string;
  lexicalCursor: string;
  preserveFinalSymlink: boolean;
};

type BoundaryResolutionContext = {
  rootPath: string;
  absolutePath: string;
  rootCanonicalPath: string;
  lexicalInside: boolean;
  canonicalOutsideLexicalPath: string;
};

function isPromiseLike<T>(value: unknown): value is PromiseLike<T> {
  return Boolean(
    value &&
    (typeof value === "object" || typeof value === "function") &&
    "then" in value &&
    typeof (value as { then?: unknown }).then === "function",
  );
}

function createLexicalTraversalState(params: {
  params: ResolveBoundaryPathParams;
  rootPath: string;
  rootCanonicalPath: string;
  absolutePath: string;
}): LexicalTraversalState {
  const relative = path.relative(params.rootPath, params.absolutePath);
  return {
    segments: relative.split(path.sep).filter(Boolean),
    allowFinalSymlink: params.params.policy?.allowFinalSymlinkForUnlink === true,
    canonicalCursor: params.rootCanonicalPath,
    lexicalCursor: params.rootPath,
    preserveFinalSymlink: false,
  };
}

function assertLexicalCursorInsideBoundary(params: {
  params: ResolveBoundaryPathParams;
  rootCanonicalPath: string;
  absolutePath: string;
  candidatePath: string;
}): void {
  assertInsideBoundary({
    boundaryLabel: params.params.boundaryLabel,
    rootCanonicalPath: params.rootCanonicalPath,
    candidatePath: params.candidatePath,
    absolutePath: params.absolutePath,
  });
}

function applyMissingSuffixToCanonicalCursor(params: {
  state: LexicalTraversalState;
  missingFromIndex: number;
  rootCanonicalPath: string;
  params: ResolveBoundaryPathParams;
  absolutePath: string;
}): void {
  const missingSuffix = params.state.segments.slice(params.missingFromIndex);
  params.state.canonicalCursor = path.resolve(params.state.canonicalCursor, ...missingSuffix);
  assertLexicalCursorInsideBoundary({
    params: params.params,
    rootCanonicalPath: params.rootCanonicalPath,
    candidatePath: params.state.canonicalCursor,
    absolutePath: params.absolutePath,
  });
}

function advanceCanonicalCursorForSegment(params: {
  state: LexicalTraversalState;
  segment: string;
  rootCanonicalPath: string;
  params: ResolveBoundaryPathParams;
  absolutePath: string;
}): void {
  params.state.canonicalCursor = path.resolve(params.state.canonicalCursor, params.segment);
  assertLexicalCursorInsideBoundary({
    params: params.params,
    rootCanonicalPath: params.rootCanonicalPath,
    candidatePath: params.state.canonicalCursor,
    absolutePath: params.absolutePath,
  });
}

function finalizeLexicalResolution(params: {
  params: ResolveBoundaryPathParams;
  rootPath: string;
  rootCanonicalPath: string;
  absolutePath: string;
  state: LexicalTraversalState;
  kind: { exists: boolean; kind: ResolvedBoundaryPathKind };
}): ResolvedBoundaryPath {
  assertLexicalCursorInsideBoundary({
    params: params.params,
    rootCanonicalPath: params.rootCanonicalPath,
    candidatePath: params.state.canonicalCursor,
    absolutePath: params.absolutePath,
  });
  return buildResolvedBoundaryPath({
    absolutePath: params.absolutePath,
    canonicalPath: params.state.canonicalCursor,
    rootPath: params.rootPath,
    rootCanonicalPath: params.rootCanonicalPath,
    kind: params.kind,
  });
}

function handleLexicalLstatFailure(params: {
  error: unknown;
  state: LexicalTraversalState;
  missingFromIndex: number;
  rootCanonicalPath: string;
  resolveParams: ResolveBoundaryPathParams;
  absolutePath: string;
}): boolean {
  if (!isNotFoundPathError(params.error)) {
    return false;
  }
  applyMissingSuffixToCanonicalCursor({
    state: params.state,
    missingFromIndex: params.missingFromIndex,
    rootCanonicalPath: params.rootCanonicalPath,
    params: params.resolveParams,
    absolutePath: params.absolutePath,
  });
  return true;
}

function handleLexicalStatReadFailure(params: {
  error: unknown;
  state: LexicalTraversalState;
  missingFromIndex: number;
  rootCanonicalPath: string;
  resolveParams: ResolveBoundaryPathParams;
  absolutePath: string;
}): null {
  if (
    handleLexicalLstatFailure({
      error: params.error,
      state: params.state,
      missingFromIndex: params.missingFromIndex,
      rootCanonicalPath: params.rootCanonicalPath,
      resolveParams: params.resolveParams,
      absolutePath: params.absolutePath,
    })
  ) {
    return null;
  }
  throw params.error;
}

function handleLexicalStatDisposition(params: {
  state: LexicalTraversalState;
  isSymbolicLink: boolean;
  segment: string;
  isLast: boolean;
  rootCanonicalPath: string;
  resolveParams: ResolveBoundaryPathParams;
  absolutePath: string;
}): "continue" | "break" | "resolve-link" {
  if (!params.isSymbolicLink) {
    advanceCanonicalCursorForSegment({
      state: params.state,
      segment: params.segment,
      rootCanonicalPath: params.rootCanonicalPath,
      params: params.resolveParams,
      absolutePath: params.absolutePath,
    });
    return "continue";
  }

  if (params.state.allowFinalSymlink && params.isLast) {
    params.state.preserveFinalSymlink = true;
    advanceCanonicalCursorForSegment({
      state: params.state,
      segment: params.segment,
      rootCanonicalPath: params.rootCanonicalPath,
      params: params.resolveParams,
      absolutePath: params.absolutePath,
    });
    return "break";
  }

  return "resolve-link";
}

function applyResolvedSymlinkHop(params: {
  state: LexicalTraversalState;
  linkCanonical: string;
  rootCanonicalPath: string;
  boundaryLabel: string;
}): void {
  if (!isPathInside(params.rootCanonicalPath, params.linkCanonical)) {
    throw symlinkEscapeError({
      boundaryLabel: params.boundaryLabel,
      rootCanonicalPath: params.rootCanonicalPath,
      symlinkPath: params.state.lexicalCursor,
    });
  }
  params.state.canonicalCursor = params.linkCanonical;
  params.state.lexicalCursor = params.linkCanonical;
}

function readLexicalStat(params: {
  state: LexicalTraversalState;
  missingFromIndex: number;
  rootCanonicalPath: string;
  resolveParams: ResolveBoundaryPathParams;
  absolutePath: string;
  read: (cursor: string) => fs.Stats | Promise<fs.Stats>;
}): fs.Stats | null | Promise<fs.Stats | null> {
  try {
    const stat = params.read(params.state.lexicalCursor);
    if (isPromiseLike<fs.Stats>(stat)) {
      return Promise.resolve(stat).catch((error) =>
        handleLexicalStatReadFailure({ ...params, error }),
      );
    }
    return stat;
  } catch (error) {
    return handleLexicalStatReadFailure({ ...params, error });
  }
}

function resolveAndApplySymlinkHop(params: {
  state: LexicalTraversalState;
  rootCanonicalPath: string;
  boundaryLabel: string;
  resolveLinkCanonical: (cursor: string) => string | Promise<string>;
}): void | Promise<void> {
  const linkCanonical = params.resolveLinkCanonical(params.state.lexicalCursor);
  if (isPromiseLike<string>(linkCanonical)) {
    return Promise.resolve(linkCanonical).then((value) =>
      applyResolvedSymlinkHop({
        state: params.state,
        linkCanonical: value,
        rootCanonicalPath: params.rootCanonicalPath,
        boundaryLabel: params.boundaryLabel,
      }),
    );
  }
  applyResolvedSymlinkHop({
    state: params.state,
    linkCanonical,
    rootCanonicalPath: params.rootCanonicalPath,
    boundaryLabel: params.boundaryLabel,
  });
}

type LexicalTraversalStep = {
  idx: number;
  segment: string;
  isLast: boolean;
};

function* iterateLexicalTraversal(state: LexicalTraversalState): Iterable<LexicalTraversalStep> {
  for (let idx = 0; idx < state.segments.length; idx += 1) {
    const segment = state.segments[idx] ?? "";
    const isLast = idx === state.segments.length - 1;
    state.lexicalCursor = path.join(state.lexicalCursor, segment);
    yield { idx, segment, isLast };
  }
}

async function resolveBoundaryPathLexicalAsync(params: {
  params: ResolveBoundaryPathParams;
  absolutePath: string;
  rootPath: string;
  rootCanonicalPath: string;
}): Promise<ResolvedBoundaryPath> {
  const state = createLexicalTraversalState(params);
  const sharedStepParams = {
    state,
    rootCanonicalPath: params.rootCanonicalPath,
    resolveParams: params.params,
    absolutePath: params.absolutePath,
  };

  for (const { idx, segment, isLast } of iterateLexicalTraversal(state)) {
    const stat = await readLexicalStat({
      ...sharedStepParams,
      missingFromIndex: idx,
      read: (cursor) => fsp.lstat(cursor),
    });
    if (!stat) {
      break;
    }

    const disposition = handleLexicalStatDisposition({
      ...sharedStepParams,
      isSymbolicLink: stat.isSymbolicLink(),
      segment,
      isLast,
    });
    if (disposition === "continue") {
      continue;
    }
    if (disposition === "break") {
      break;
    }

    await resolveAndApplySymlinkHop({
      state,
      rootCanonicalPath: params.rootCanonicalPath,
      boundaryLabel: params.params.boundaryLabel,
      resolveLinkCanonical: (cursor) => resolveSymlinkHopPath(cursor),
    });
  }

  const kind = await getPathKind(params.absolutePath, state.preserveFinalSymlink);
  return finalizeLexicalResolution({
    ...params,
    state,
    kind,
  });
}

function resolveBoundaryPathLexicalSync(params: {
  params: ResolveBoundaryPathParams;
  absolutePath: string;
  rootPath: string;
  rootCanonicalPath: string;
}): ResolvedBoundaryPath {
  const state = createLexicalTraversalState(params);
  for (let idx = 0; idx < state.segments.length; idx += 1) {
    const segment = state.segments[idx] ?? "";
    const isLast = idx === state.segments.length - 1;
    state.lexicalCursor = path.join(state.lexicalCursor, segment);
    const maybeStat = readLexicalStat({
      state,
      missingFromIndex: idx,
      rootCanonicalPath: params.rootCanonicalPath,
      resolveParams: params.params,
      absolutePath: params.absolutePath,
      read: (cursor) => fs.lstatSync(cursor),
    });
    if (isPromiseLike<fs.Stats | null>(maybeStat)) {
      throw new Error("Unexpected async lexical stat");
    }
    const stat = maybeStat;
    if (!stat) {
      break;
    }

    const disposition = handleLexicalStatDisposition({
      state,
      isSymbolicLink: stat.isSymbolicLink(),
      segment,
      isLast,
      rootCanonicalPath: params.rootCanonicalPath,
      resolveParams: params.params,
      absolutePath: params.absolutePath,
    });
    if (disposition === "continue") {
      continue;
    }
    if (disposition === "break") {
      break;
    }

    const maybeApplied = resolveAndApplySymlinkHop({
      state,
      rootCanonicalPath: params.rootCanonicalPath,
      boundaryLabel: params.params.boundaryLabel,
      resolveLinkCanonical: (cursor) => resolveSymlinkHopPathSync(cursor),
    });
    if (isPromiseLike<void>(maybeApplied)) {
      throw new Error("Unexpected async symlink resolution");
    }
  }

  const kind = getPathKindSync(params.absolutePath, state.preserveFinalSymlink);
  return finalizeLexicalResolution({
    ...params,
    state,
    kind,
  });
}

function resolveCanonicalOutsideLexicalPath(params: {
  absolutePath: string;
  outsideLexicalCanonicalPath?: string;
}): string {
  return params.outsideLexicalCanonicalPath ?? params.absolutePath;
}

function createBoundaryResolutionContext(params: {
  resolveParams: ResolveBoundaryPathParams;
  rootPath: string;
  absolutePath: string;
  rootCanonicalPath: string;
  outsideLexicalCanonicalPath?: string;
}): BoundaryResolutionContext {
  const lexicalInside = isPathInside(params.rootPath, params.absolutePath);
  const canonicalOutsideLexicalPath = resolveCanonicalOutsideLexicalPath({
    absolutePath: params.absolutePath,
    outsideLexicalCanonicalPath: params.outsideLexicalCanonicalPath,
  });
  assertLexicalBoundaryOrCanonicalAlias({
    skipLexicalRootCheck: params.resolveParams.skipLexicalRootCheck,
    lexicalInside,
    canonicalOutsideLexicalPath,
    rootCanonicalPath: params.rootCanonicalPath,
    boundaryLabel: params.resolveParams.boundaryLabel,
    rootPath: params.rootPath,
    absolutePath: params.absolutePath,
  });
  return {
    rootPath: params.rootPath,
    absolutePath: params.absolutePath,
    rootCanonicalPath: params.rootCanonicalPath,
    lexicalInside,
    canonicalOutsideLexicalPath,
  };
}

async function resolveOutsideBoundaryPathAsync(params: {
  boundaryLabel: string;
  context: BoundaryResolutionContext;
}): Promise<ResolvedBoundaryPath | null> {
  if (params.context.lexicalInside) {
    return null;
  }
  const kind = await getPathKind(params.context.absolutePath, false);
  return buildOutsideBoundaryPathFromContext({
    boundaryLabel: params.boundaryLabel,
    context: params.context,
    kind,
  });
}

function resolveOutsideBoundaryPathSync(params: {
  boundaryLabel: string;
  context: BoundaryResolutionContext;
}): ResolvedBoundaryPath | null {
  if (params.context.lexicalInside) {
    return null;
  }
  const kind = getPathKindSync(params.context.absolutePath, false);
  return buildOutsideBoundaryPathFromContext({
    boundaryLabel: params.boundaryLabel,
    context: params.context,
    kind,
  });
}

function buildOutsideBoundaryPathFromContext(params: {
  boundaryLabel: string;
  context: BoundaryResolutionContext;
  kind: { exists: boolean; kind: ResolvedBoundaryPathKind };
}): ResolvedBoundaryPath {
  return buildOutsideLexicalBoundaryPath({
    boundaryLabel: params.boundaryLabel,
    rootCanonicalPath: params.context.rootCanonicalPath,
    absolutePath: params.context.absolutePath,
    canonicalOutsideLexicalPath: params.context.canonicalOutsideLexicalPath,
    rootPath: params.context.rootPath,
    kind: params.kind,
  });
}

async function resolveOutsideLexicalCanonicalPathAsync(params: {
  rootPath: string;
  absolutePath: string;
}): Promise<string | undefined> {
  if (isPathInside(params.rootPath, params.absolutePath)) {
    return undefined;
  }
  return await resolvePathViaExistingAncestor(params.absolutePath);
}

function resolveOutsideLexicalCanonicalPathSync(params: {
  rootPath: string;
  absolutePath: string;
}): string | undefined {
  if (isPathInside(params.rootPath, params.absolutePath)) {
    return undefined;
  }
  return resolvePathViaExistingAncestorSync(params.absolutePath);
}

function buildOutsideLexicalBoundaryPath(params: {
  boundaryLabel: string;
  rootCanonicalPath: string;
  absolutePath: string;
  canonicalOutsideLexicalPath: string;
  rootPath: string;
  kind: { exists: boolean; kind: ResolvedBoundaryPathKind };
}): ResolvedBoundaryPath {
  assertInsideBoundary({
    boundaryLabel: params.boundaryLabel,
    rootCanonicalPath: params.rootCanonicalPath,
    candidatePath: params.canonicalOutsideLexicalPath,
    absolutePath: params.absolutePath,
  });
  return buildResolvedBoundaryPath({
    absolutePath: params.absolutePath,
    canonicalPath: params.canonicalOutsideLexicalPath,
    rootPath: params.rootPath,
    rootCanonicalPath: params.rootCanonicalPath,
    kind: params.kind,
  });
}

function assertLexicalBoundaryOrCanonicalAlias(params: {
  skipLexicalRootCheck?: boolean;
  lexicalInside: boolean;
  canonicalOutsideLexicalPath: string;
  rootCanonicalPath: string;
  boundaryLabel: string;
  rootPath: string;
  absolutePath: string;
}): void {
  if (params.skipLexicalRootCheck || params.lexicalInside) {
    return;
  }
  if (isPathInside(params.rootCanonicalPath, params.canonicalOutsideLexicalPath)) {
    return;
  }
  throw pathEscapeError({
    boundaryLabel: params.boundaryLabel,
    rootPath: params.rootPath,
    absolutePath: params.absolutePath,
  });
}

function buildResolvedBoundaryPath(params: {
  absolutePath: string;
  canonicalPath: string;
  rootPath: string;
  rootCanonicalPath: string;
  kind: { exists: boolean; kind: ResolvedBoundaryPathKind };
}): ResolvedBoundaryPath {
  return {
    absolutePath: params.absolutePath,
    canonicalPath: params.canonicalPath,
    rootPath: params.rootPath,
    rootCanonicalPath: params.rootCanonicalPath,
    relativePath: relativeInsideRoot(params.rootCanonicalPath, params.canonicalPath),
    exists: params.kind.exists,
    kind: params.kind.kind,
  };
}

async function resolvePathViaExistingAncestor(targetPath: string): Promise<string> {
  const normalized = path.resolve(targetPath);
  let cursor = normalized;
  const missingSuffix: string[] = [];

  while (!isFilesystemRoot(cursor) && !(await pathExists(cursor))) {
    missingSuffix.unshift(path.basename(cursor));
    const parent = path.dirname(cursor);
    if (parent === cursor) {
      break;
    }
    cursor = parent;
  }

  if (!(await pathExists(cursor))) {
    return normalized;
  }

  try {
    const resolvedAncestor = path.resolve(await fsp.realpath(cursor));
    if (missingSuffix.length === 0) {
      return resolvedAncestor;
    }
    return path.resolve(resolvedAncestor, ...missingSuffix);
  } catch {
    return normalized;
  }
}

export function resolvePathViaExistingAncestorSync(targetPath: string): string {
  const normalized = path.resolve(targetPath);
  let cursor = normalized;
  const missingSuffix: string[] = [];

  while (!isFilesystemRoot(cursor) && !fs.existsSync(cursor)) {
    missingSuffix.unshift(path.basename(cursor));
    const parent = path.dirname(cursor);
    if (parent === cursor) {
      break;
    }
    cursor = parent;
  }

  if (!fs.existsSync(cursor)) {
    return normalized;
  }

  try {
    // Keep sync behavior aligned with async (`fsp.realpath`) to avoid
    // platform-specific canonical alias drift (notably on Windows).
    const resolvedAncestor = path.resolve(fs.realpathSync(cursor));
    if (missingSuffix.length === 0) {
      return resolvedAncestor;
    }
    return path.resolve(resolvedAncestor, ...missingSuffix);
  } catch {
    return normalized;
  }
}

async function getPathKind(
  absolutePath: string,
  preserveFinalSymlink: boolean,
): Promise<{ exists: boolean; kind: ResolvedBoundaryPathKind }> {
  try {
    const stat = preserveFinalSymlink
      ? await fsp.lstat(absolutePath)
      : await fsp.stat(absolutePath);
    return { exists: true, kind: toResolvedKind(stat) };
  } catch (error) {
    if (isNotFoundPathError(error)) {
      return { exists: false, kind: "missing" };
    }
    throw error;
  }
}

function getPathKindSync(
  absolutePath: string,
  preserveFinalSymlink: boolean,
): { exists: boolean; kind: ResolvedBoundaryPathKind } {
  try {
    const stat = preserveFinalSymlink ? fs.lstatSync(absolutePath) : fs.statSync(absolutePath);
    return { exists: true, kind: toResolvedKind(stat) };
  } catch (error) {
    if (isNotFoundPathError(error)) {
      return { exists: false, kind: "missing" };
    }
    throw error;
  }
}

function toResolvedKind(stat: fs.Stats): ResolvedBoundaryPathKind {
  if (stat.isFile()) {
    return "file";
  }
  if (stat.isDirectory()) {
    return "directory";
  }
  if (stat.isSymbolicLink()) {
    return "symlink";
  }
  return "other";
}

function relativeInsideRoot(rootPath: string, targetPath: string): string {
  const relative = path.relative(path.resolve(rootPath), path.resolve(targetPath));
  if (!relative || relative === ".") {
    return "";
  }
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return "";
  }
  return relative;
}

function assertInsideBoundary(params: {
  boundaryLabel: string;
  rootCanonicalPath: string;
  candidatePath: string;
  absolutePath: string;
}): void {
  if (isPathInside(params.rootCanonicalPath, params.candidatePath)) {
    return;
  }
  throw new Error(
    `Path resolves outside ${params.boundaryLabel} (${shortPath(params.rootCanonicalPath)}): ${shortPath(params.absolutePath)}`,
  );
}

function pathEscapeError(params: {
  boundaryLabel: string;
  rootPath: string;
  absolutePath: string;
}): Error {
  return new Error(
    `Path escapes ${params.boundaryLabel} (${shortPath(params.rootPath)}): ${shortPath(params.absolutePath)}`,
  );
}

function symlinkEscapeError(params: {
  boundaryLabel: string;
  rootCanonicalPath: string;
  symlinkPath: string;
}): Error {
  return new Error(
    `Symlink escapes ${params.boundaryLabel} (${shortPath(params.rootCanonicalPath)}): ${shortPath(params.symlinkPath)}`,
  );
}

function shortPath(value: string): string {
  const home = os.homedir();
  if (value.startsWith(home)) {
    return `~${value.slice(home.length)}`;
  }
  return value;
}

function isFilesystemRoot(candidate: string): boolean {
  return path.parse(candidate).root === candidate;
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fsp.lstat(targetPath);
    return true;
  } catch (error) {
    if (isNotFoundPathError(error)) {
      return false;
    }
    throw error;
  }
}

async function resolveSymlinkHopPath(symlinkPath: string): Promise<string> {
  try {
    return path.resolve(await fsp.realpath(symlinkPath));
  } catch (error) {
    if (!isNotFoundPathError(error)) {
      throw error;
    }
    const linkTarget = await fsp.readlink(symlinkPath);
    const linkAbsolute = path.resolve(path.dirname(symlinkPath), linkTarget);
    return resolvePathViaExistingAncestor(linkAbsolute);
  }
}

function resolveSymlinkHopPathSync(symlinkPath: string): string {
  try {
    return path.resolve(fs.realpathSync(symlinkPath));
  } catch (error) {
    if (!isNotFoundPathError(error)) {
      throw error;
    }
    const linkTarget = fs.readlinkSync(symlinkPath);
    const linkAbsolute = path.resolve(path.dirname(symlinkPath), linkTarget);
    return resolvePathViaExistingAncestorSync(linkAbsolute);
  }
}
