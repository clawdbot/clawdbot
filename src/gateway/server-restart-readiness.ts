/** Revalidate fresh database ownership before a config restart closes the listener. */
export async function assertGatewayRestartDatabaseReadiness(): Promise<void> {
  const { assertOpenClawDatabasesReadyForRestart } =
    await import("../state/openclaw-database-preflight.js");
  assertOpenClawDatabasesReadyForRestart({ env: process.env });
}
