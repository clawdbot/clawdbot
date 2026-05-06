import { writeViaSiblingTempPath as writeViaSiblingTempPathBase } from "../sdk-security-runtime.js";

export async function writeViaSiblingTempPath(params: {
  rootDir: string;
  targetPath: string;
  writeTemp: (tempPath: string) => Promise<void>;
}): Promise<void> {
  await writeViaSiblingTempPathBase({
    ...params,
    fallbackFileName: "output.bin",
    tempPrefix: ".openclaw-output-",
  });
}
