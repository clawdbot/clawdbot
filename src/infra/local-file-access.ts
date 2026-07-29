// Exposes local file URL helpers with fs-safe defaults.
import "./fs-safe-defaults.js";

// Local user-file URL helpers centralize encoded separator and UNC path checks.
export {
  assertNoWindowsNetworkPath,
  basenameFromMediaSource,
  hasEncodedFileUrlSeparator,
  isWindowsNetworkPath,
  safeFileURLToPath,
  trySafeFileURLToPath,
} from "@openclaw/fs-safe/advanced";
