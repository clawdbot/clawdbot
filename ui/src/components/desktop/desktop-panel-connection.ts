import type { DesktopObserveResult, WorkerDesktopAppId } from "@openclaw/gateway-protocol";

export type DesktopAppId = WorkerDesktopAppId;
export type DesktopCredentials = { username?: string; password?: string };

export type PendingDesktopConnection = {
  environmentId: string;
  control: boolean;
  observed?: DesktopObserveResult;
  operationId: number;
};

export type ObservedDesktopConnection = PendingDesktopConnection & {
  observed: DesktopObserveResult;
};
