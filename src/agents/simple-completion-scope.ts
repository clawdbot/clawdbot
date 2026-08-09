import type { resolveModelAsync } from "./embedded-agent-runner/model.js";

type SimpleCompletionModelResolver = typeof resolveModelAsync;

const workspaceByResolver = new WeakMap<SimpleCompletionModelResolver, string>();

/** Keep request-local workspace scope without growing the public completion SDK signature. */
export function bindSimpleCompletionModelResolverWorkspace(
  resolver: SimpleCompletionModelResolver,
  workspaceDir: string,
): SimpleCompletionModelResolver {
  const scopedResolver: SimpleCompletionModelResolver = (
    provider,
    modelId,
    agentDir,
    cfg,
    options,
  ) => resolver(provider, modelId, agentDir, cfg, options);
  workspaceByResolver.set(scopedResolver, workspaceDir);
  return scopedResolver;
}

export function resolveSimpleCompletionModelResolverWorkspace(
  resolver: SimpleCompletionModelResolver | undefined,
): string | undefined {
  return resolver ? workspaceByResolver.get(resolver) : undefined;
}
