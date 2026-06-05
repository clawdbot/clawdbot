// Generate Secretref Credential Matrix script supports OpenClaw repository automation.
import fs from "node:fs";
import path from "node:path";
import { buildSecretRefCredentialMatrix } from "../src/secrets/credential-matrix.js";

const outputPath = path.join(
  process.cwd(),
  "docs",
  "reference",
  "secretref-user-supplied-credentials-matrix.json",
);

const matrix = buildSecretRefCredentialMatrix();
fs.writeFileSync(outputPath, `${JSON.stringify(matrix, null, 2)}\n`, "utf8");
console.log(`Wrote ${outputPath}`);
