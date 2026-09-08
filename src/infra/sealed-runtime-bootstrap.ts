import * as json5 from "json5";
import { configureFsSafeNative } from "./fs-safe-defaults.js";
import { registerSealedRuntime } from "./sealed-runtime-registry.js";
import { resolveSecureTempRoot } from "./secure-temp-root.js";

// Sealed entries load this before any logging/config consumers. Their private
// JavaScript closure must never resolve packages or optional native code on the host.
configureFsSafeNative({ mode: "off" });
registerSealedRuntime({ json5, resolveSecureTempRoot });
