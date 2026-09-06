import { registerToolingTsx } from "./lib/tsx-cli-shim.mjs";

// fork() inherits execArgv but can change cwd. Keep our root-script preload
// resolvable there without rewriting unrelated flags or other preloads.
const preload = "./scripts/tsx.mjs";
for (const [index, arg] of process.execArgv.entries()) {
  if (arg === preload && process.execArgv[index - 1] === "--import") {
    process.execArgv[index] = import.meta.url;
  } else if (arg === `--import=${preload}`) {
    process.execArgv[index] = `--import=${import.meta.url}`;
  }
}

await registerToolingTsx();
