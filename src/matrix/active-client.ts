import type { MatrixClient } from "matrix-js-sdk";

let activeClient: MatrixClient | null = null;

export function setActiveMatrixClient(client: MatrixClient | null): void {
  activeClient = client;
}

export function getActiveMatrixClient(): MatrixClient | null {
  return activeClient;
}
