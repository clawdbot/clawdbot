import type { SandboxContainerInfo } from "../agents/sandbox.js";

/** True only for Docker-style runtime image mismatches safe for image-only recreation. */
export function isImageBackedSandboxMismatch(container: SandboxContainerInfo): boolean {
  // Missing backend ids predate pluggable backends and are legacy Docker.
  // Explicit remote backends must never enter image-only destructive cleanup.
  const backendId = container.backendId ?? "docker";
  return (
    !container.imageMatch &&
    (backendId === "docker" || backendId === "podman") &&
    (container.configLabelKind ?? "Image") === "Image"
  );
}
