/**
 * Short-circuits Node's ESM resolution for dist-internal relative imports.
 *
 * Node's default resolver calls getPackageScopeConfig() for every file: URL to
 * pick a module format, and each call re-materializes the package.json
 * `exports` map. With openclaw's 300+ subpath exports that costs ~0.1ms per
 * resolution and multiple seconds across the ~15k module edges of a gateway
 * boot. Every built dist file is ESM (all dist package.json files declare
 * "type": "module"), so a relative "./chunk.js" import inside dist can resolve
 * by URL join with format "module" without consulting the package scope at
 * all. This hook removes only resolver cost; the resolved URL and format are
 * byte-identical to Node's default resolution.
 */
import Module from "node:module";
import process from "node:process";
import { parseNodeOptionsEnvVar } from "./infra/node-options.js";

// Bun lacks registerHooks, so keep the runtime probe despite supported Node types.
const moduleWithHooks: { registerHooks?: typeof Module.registerHooks } = Module;

const installedDistRootUrls = new Set<string>();
const NODE_RESOLVER_HOOK_OPTIONS = new Set([
  "--import",
  "--require",
  "-r",
  "--loader",
  "--experimental-loader",
  "--experimental-config-file",
  "--experimental-default-config-file",
  "--snapshot-blob",
]);

const normalizeNodeOptionName = (token: string) =>
  (token.split("=", 1)[0] ?? "").replaceAll("_", "-");

function hasNodeResolverHookOption(
  execArgv: readonly string[],
  nodeOptions: string | undefined,
): boolean {
  const envOptions = parseNodeOptionsEnvVar(nodeOptions);
  return (
    envOptions === null ||
    [...execArgv, ...envOptions].some((token) =>
      NODE_RESOLVER_HOOK_OPTIONS.has(normalizeNodeOptionName(token)),
    )
  );
}

/**
 * Resolves a dist-internal relative ESM specifier to its final file URL, or
 * returns null when the specifier must go through Node's default resolution.
 * Only relative ".js" specifiers whose parent and target both live under the
 * dist root qualify; require() resolutions stay on the default path because
 * the CJS loader does not pay the eager format-detection cost this bypasses.
 */
function resolveDistEsmFastPathUrl(params: {
  specifier: string;
  parentUrl: string | undefined;
  conditions: readonly string[] | undefined;
  distRootUrl: string;
}): string | null {
  const { specifier, parentUrl } = params;
  if (
    specifier.charCodeAt(0) !== 46 /* "." */ ||
    !specifier.endsWith(".js") ||
    parentUrl === undefined ||
    !parentUrl.startsWith(params.distRootUrl) ||
    params.conditions?.includes("require") === true ||
    (specifier.charCodeAt(1) !== 47 /* "/" */ &&
      (specifier.charCodeAt(1) !== 46 /* "." */ || specifier.charCodeAt(2) !== 47))
  ) {
    return null;
  }
  let resolved: string;
  try {
    resolved = new URL(specifier, parentUrl).href;
  } catch {
    return null;
  }
  // "../" chains can leave the built output tree; those targets may live in a
  // different package scope, so they keep Node's default format detection.
  return resolved.startsWith(params.distRootUrl) ? resolved : null;
}

/**
 * Installs the dist-relative ESM resolve fast path for a built entry file.
 * No-ops (returns false) outside a dist layout — source checkouts run through
 * tsx/vitest resolvers that must keep owning ".js" specifier rewrites — and
 * on runtimes without Module.registerHooks.
 */
export function installDistEsmResolveFastPath(
  entryFileUrl: string,
  deps: {
    registerHooks?: typeof Module.registerHooks | undefined;
    execArgv?: readonly string[];
    nodeOptions?: string | undefined;
  } = {},
): boolean {
  const registerHooks =
    "registerHooks" in deps ? deps.registerHooks : moduleWithHooks.registerHooks;
  if (typeof registerHooks !== "function") {
    return false;
  }
  const distRootUrl = new URL("./", entryFileUrl).href;
  if (!distRootUrl.endsWith("/dist/")) {
    return false;
  }
  const nodeOptions = "nodeOptions" in deps ? deps.nodeOptions : process.env.NODE_OPTIONS;
  // A later short circuit would bypass preload and loader hooks registered before startup.
  if (hasNodeResolverHookOption(deps.execArgv ?? process.execArgv, nodeOptions)) {
    return false;
  }
  if (installedDistRootUrls.has(distRootUrl)) {
    return true;
  }
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const url = resolveDistEsmFastPathUrl({
        specifier,
        parentUrl: context.parentURL,
        conditions: context.conditions,
        distRootUrl,
      });
      if (url !== null) {
        return { url, format: "module", shortCircuit: true };
      }
      return nextResolve(specifier, context);
    },
  });
  installedDistRootUrls.add(distRootUrl);
  return true;
}
