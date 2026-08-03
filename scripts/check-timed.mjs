// Wraps the aggregate check command with timing behavior.
import { main } from "./check.mjs";

await main([...process.argv.slice(2), "--timed"]);
