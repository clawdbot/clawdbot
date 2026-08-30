export async function resolveConfiguredWorkspaces(
  config: unknown,
  env: NodeJS.ProcessEnv,
): Promise<string[]> {
  const { resolveMemoryConfiguredWorkspaces } =
    await import("openclaw/plugin-sdk/memory-core-host-status");
  return resolveMemoryConfiguredWorkspaces(
    config as Parameters<typeof resolveMemoryConfiguredWorkspaces>[0],
    { env },
  ).map((entry) => entry.workspaceDir);
}
