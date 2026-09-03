/**
 * Bootstrap resolution for hook-runtime-free processes such as doctor. Lives
 * beside bootstrap-files.ts rather than inside it so ordinary run and
 * preparation resolution never loads hook discovery (hooks/workspace ->
 * plugin-hooks -> plugin metadata); only diagnostic callers pay that cost.
 */
import {
  isBundledExtraFilesHookSelected,
  loadDeclaredExtraBootstrapFiles,
} from "../hooks/bundled/bootstrap-extra-files/declared-files.js";
import { resolveBootstrapContextWithProjectedHookFiles } from "./bootstrap-files.js";

/**
 * Run-equivalent bootstrap context; also projects the bundled
 * bootstrap-extra-files hook when hook selection would load it.
 */
export async function resolveBootstrapContextForDiagnostics(
  params: Parameters<typeof resolveBootstrapContextWithProjectedHookFiles>[0],
): ReturnType<typeof resolveBootstrapContextWithProjectedHookFiles> {
  if (!isBundledExtraFilesHookSelected(params.config)) {
    return resolveBootstrapContextWithProjectedHookFiles(params, []);
  }
  const declared = await loadDeclaredExtraBootstrapFiles({
    config: params.config,
    workspaceDir: params.workspaceDir,
  });
  return resolveBootstrapContextWithProjectedHookFiles(params, declared.files);
}
