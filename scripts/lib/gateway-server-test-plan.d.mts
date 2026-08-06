export const GATEWAY_SERVER_TEST_PROCESS_COUNT: 4;
export function listGatewayServerTestTargets(cwd?: string): string[];
export function splitTestTargetChunks(targets: string[], chunkCount: number): string[][];
export function createGatewayServerTestTargetChunks(cwd?: string): string[][];
