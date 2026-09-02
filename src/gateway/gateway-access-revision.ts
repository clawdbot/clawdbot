let revision = 0;

/** Marks Gateway access decisions stale across asynchronously yielded reads. */
export function bumpGatewayAccessRevision(): void {
  revision += 1;
}

export function readGatewayAccessRevision(): number {
  return revision;
}
