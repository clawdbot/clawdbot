// Wraps fs-safe atomic replacement and move helpers for OpenClaw install flows.
import "./fs-safe-defaults.js";
import { replaceFileAtomic as replaceFileAtomicBase } from "@openclaw/fs-safe/atomic";

export {
  movePathWithCopyFallback,
  replaceDirectoryAtomic,
  replaceFileAtomicSync,
} from "@openclaw/fs-safe/atomic";

/** Atomic file replacement primitive re-exported through the fs-safe defaults shim. */
export const replaceFileAtomic = replaceFileAtomicBase;
