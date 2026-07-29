// Defines sensitive config schema fragments and redaction metadata.
import { z } from "zod";
import type { ConfigUiHint } from "../shared/config-ui-hints-types.js";

// Everything registered here will be redacted when the config is exposed,
// e.g. sent to the dashboard
export const sensitive = z.registry<undefined, z.ZodType>();
export const configUiMetadata = z.registry<ConfigUiHint, z.ZodType>();
