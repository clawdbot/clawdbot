#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const result = spawnSync(
  process.platform === "win32" ? "moltbot.cmd" : "moltbot",
  process.argv.slice(2),
  { stdio: "inherit" },
);

process.exit(result.status ?? 1);
