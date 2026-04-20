import { main } from "./check.mjs";

await main([...process.argv.slice(2), "--timed"]);
