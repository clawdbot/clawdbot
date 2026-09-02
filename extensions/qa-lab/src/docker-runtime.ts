// Qa Lab plugin module implements docker runtime behavior.
import {
  createQaDockerRuntime,
  type QaDockerFetchLike as FetchLike,
  type QaDockerRunCommand as RunCommand,
} from "openclaw/plugin-sdk/qa-runtime";

export type { FetchLike, RunCommand };

const dockerRuntime = createQaDockerRuntime({
  auditContext: "qa-lab-docker-health-check",
  commandTimeoutMs: null,
});

export const {
  execCommand,
  fetchHealthUrl,
  resolveComposeServiceUrl,
  resolveHostPort,
  waitForDockerServiceHealth,
  waitForHealth,
} = dockerRuntime;
