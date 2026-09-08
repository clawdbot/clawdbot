import { createRequire, isBuiltin } from "node:module";
import { join } from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { BuildOptions, BuildResult, PluginBuild } from "esbuild";

const moduleLocationImport = "openclaw-plugin-bundle:module-location";
const runtimeFilesImport = "openclaw-plugin-bundle:runtime-files";
const loadDiagnostics = {
  "unsupported-dynamic-import": "error",
  "unsupported-require-call": "error",
  "indirect-require": "error",
} satisfies BuildOptions["logOverride"];

type PluginBundleOptions = Omit<
  BuildOptions,
  | "bundle"
  | "format"
  | "write"
  | "metafile"
  | "logLevel"
  | "logOverride"
  | "inject"
  | "plugins"
  | "minifySyntax"
> & { platform: "node" | "browser"; absWorkingDir: string };

function isPluginBundleHostImport(specifier: string): boolean {
  return isBuiltin(specifier) || specifier === "openclaw" || specifier.startsWith("openclaw/");
}

export async function buildPluginBundle(options: PluginBundleOptions) {
  const require = createRequire(join(options.absWorkingDir, "package.json"));
  let builder: typeof import("esbuild");
  try {
    // SAFETY: Resolve the compiler installed by the author in the plugin package.
    builder = require("esbuild") as typeof import("esbuild");
  } catch (cause) {
    throw new Error(
      "Install esbuild in this plugin's devDependencies, then run plugins build again.",
      { cause },
    );
  }
  const backend = options.platform === "node";
  const recovery = backend
    ? "Use literal import or require paths and embed runtime resources, or use the regular package-install flow."
    : "Use literal browser imports, or provide prebuilt browser assets without package.json openclaw.controlUi.";
  const bindings = backend
    ? 'metadata as "import.meta", directory as __dirname, filename as __filename, resolve as "require.resolve"'
    : 'resolve as "require.resolve"';
  let result: BuildResult<{ write: false; metafile: true }>;
  try {
    result = await builder.build({
      ...options,
      bundle: true,
      format: "esm",
      write: false,
      metafile: true,
      minifySyntax: true,
      logLevel: "silent",
      logOverride: loadDiagnostics,
      // ESM output omits require.resolve from esbuild's import metadata. Inject
      // location bindings hygienically; syntax folding also handles ["resolve"].
      inject: [moduleLocationImport],
      plugins: [
        {
          name: "plugin-bundle",
          setup(build: PluginBuild) {
            build.onResolve({ filter: /^openclaw-plugin-bundle:module-location$/ }, () => ({
              path: "module-location",
              namespace: "plugin-bundle",
              sideEffects: false,
            }));
            build.onLoad({ filter: /.*/, namespace: "plugin-bundle" }, () => ({
              // Injected files are parsed first, so only this compiler-owned require
              // uses the artifact URL; author module locations still hit the sentinel.
              contents: [
                `export { ${bindings} } from "${runtimeFilesImport}";`,
                ...(backend
                  ? [
                      'import { createRequire } from "node:module"; export default createRequire(import.meta.url);',
                    ]
                  : []),
              ].join("\n"),
              loader: "js",
            }));
            build.onResolve({ filter: /^openclaw-plugin-bundle:runtime-files$/ }, () => ({
              path: runtimeFilesImport,
              external: true,
              sideEffects: false,
            }));
            if (backend) {
              // Builtins keep Node's CJS exports. Host imports must pass through
              // the plugin loader's SDK aliases even when it transforms source.
              build.onResolve({ filter: /.*/ }, ({ path, kind }) =>
                kind === "require-call" && isPluginBundleHostImport(path)
                  ? { path, namespace: "plugin-bundle-host" }
                  : undefined,
              );
              build.onLoad({ filter: /.*/, namespace: "plugin-bundle-host" }, ({ path }) => ({
                contents: isBuiltin(path)
                  ? `import load from "${moduleLocationImport}"; module.exports = load(${JSON.stringify(path)});`
                  : `import * as host from ${JSON.stringify(path)}; module.exports = host;`,
                loader: "js",
              }));
            }
          },
        },
      ],
    });
  } catch (cause) {
    if (
      cause instanceof Error &&
      "errors" in cause &&
      Array.isArray(cause.errors) &&
      cause.errors.some(
        (diagnostic: unknown) =>
          isRecord(diagnostic) &&
          typeof diagnostic.id === "string" &&
          Object.hasOwn(loadDiagnostics, diagnostic.id),
      )
    ) {
      throw new Error(`${cause.message}\n${recovery}`, { cause });
    }
    throw cause;
  }
  const imports = Object.values(result.metafile.outputs).flatMap((output) => output.imports);
  if (imports.some((item) => item.path === runtimeFilesImport)) {
    const reason = backend
      ? "Plugin artifacts cannot use module-relative runtime files or require.resolve."
      : "Control UI builds cannot use require.resolve.";
    throw new Error(`${reason} ${recovery}`);
  }
  if (
    imports.some((item) => item.external && (!backend || !isPluginBundleHostImport(item.path))) ||
    (backend && result.outputFiles.some((file) => !file.path.endsWith(".js")))
  ) {
    throw new Error(
      backend
        ? "Plugin artifact must bundle all dependencies into its JavaScript runtime files."
        : "Control UI builds must bundle their browser dependencies.",
    );
  }
  return result.outputFiles.toSorted((left, right) => left.path.localeCompare(right.path));
}
