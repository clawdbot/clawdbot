import fs from "node:fs";
import path from "node:path";

import dotenv from "@dotenvx/dotenvx";

import { resolveConfigDir } from "../utils.js";

export function loadDotEnv(opts?: { quiet?: boolean }) {
  const quiet = opts?.quiet ?? true;

  // Load from process CWD first (dotenv default).
  dotenv.config({ quiet });

  // Then load global fallback: ~/.clawdbot/.env (or CLAWDBOT_STATE_DIR/.env),
  // without overriding any env vars already present.
  const globalEnvPath = path.join(resolveConfigDir(process.env), ".env");
  if (!fs.existsSync(globalEnvPath)) return;

  dotenv.config({ quiet, path: globalEnvPath, override: false });
}
