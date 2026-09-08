// Podman network rm has no --ignore flag. Skip only a network this run never
// created; a failure removing an owned network must remain a cleanup failure.
export async function removeTelegramQaNetwork(
  podman: (args: string[]) => Promise<string>,
  createdNetwork: string | undefined,
) {
  if (createdNetwork !== undefined) {
    await podman(["network", "rm", createdNetwork]);
  }
}
