// Sbx type declarations define plugin contracts.
import type { RemoteShellSandboxHandle, SandboxBackendHandle } from "openclaw/plugin-sdk/sandbox";

export type SbxSandboxBackend = SandboxBackendHandle & RemoteShellSandboxHandle;
