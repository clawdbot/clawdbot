// Internal Rastermill construction keeps operation-specific limits off SDK barrels.
import { createRastermill } from "rastermill";
import { resolveSystemBin } from "../infra/resolve-system-bin.js";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";

export function createImageProcessorWithPixelLimits(params: {
  inputPixels: number;
  outputPixels: number;
}) {
  return createRastermill({
    execution: "auto",
    limits: {
      inputPixels: params.inputPixels,
      outputPixels: params.outputPixels,
    },
    temp: {
      rootDir: resolvePreferredOpenClawTmpDir(),
      prefix: "openclaw-img-",
    },
    commandResolver: (command) =>
      resolveSystemBin(command, { trust: command === "powershell" ? "strict" : "standard" }),
  });
}
