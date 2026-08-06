import path from "node:path";

type OpenClawStateDatabaseReadinessStatus = "active" | "failed" | "inactive";

const readinessByPath = new Map<string, OpenClawStateDatabaseReadinessStatus>();

export function publishOpenClawStateDatabaseReadiness(
  pathname: string,
  status: OpenClawStateDatabaseReadinessStatus,
): void {
  const resolvedPath = path.resolve(pathname);
  if (status === "inactive") {
    readinessByPath.delete(resolvedPath);
    return;
  }
  readinessByPath.set(resolvedPath, status);
}

export function getOpenClawStateDatabaseReadiness(
  pathname: string,
): OpenClawStateDatabaseReadinessStatus {
  return readinessByPath.get(path.resolve(pathname)) ?? "inactive";
}

export function clearOpenClawStateDatabaseReadinessForTest(): void {
  readinessByPath.clear();
}
