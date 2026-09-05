// Exercise standalone Doctor repair through its public health entry points.
import fs from "node:fs/promises";
import path from "node:path";
import { shortenHomePath } from "../utils.js";
import {
  detectSessionTranscriptHealthIssues,
  noteSessionTranscriptHealth,
} from "./doctor-session-transcripts.js";

export async function repairTranscriptFixture(
  params: {
    filePath: string;
    shouldRepair: boolean;
  },
  getNoteCalls: () => readonly unknown[][],
) {
  const [issue] = await detectSessionTranscriptHealthIssues({
    sessionDirs: [path.dirname(params.filePath)],
  });
  if (!issue) {
    return {
      filePath: params.filePath,
      broken: false,
      repaired: false,
      originalEntries: 0,
      activeEntries: 0,
      legacyOpenAICodexEntries: 0,
    };
  }
  if (!params.shouldRepair) {
    return issue;
  }

  const noteCount = getNoteCalls().length;
  await noteSessionTranscriptHealth({
    sessionDirs: [path.dirname(params.filePath)],
    shouldRepair: true,
  });
  const backupPrefix = `${path.basename(params.filePath)}.pre-doctor-`;
  const backupName = (await fs.readdir(path.dirname(params.filePath))).find(
    (entry) => entry.startsWith(backupPrefix) && entry.endsWith(".bak"),
  );
  return {
    ...issue,
    repaired: getNoteCalls()
      .slice(noteCount)
      .some(([message]) =>
        String(message).includes(`${shortenHomePath(params.filePath)} repaired entries=`),
      ),
    ...(backupName ? { backupPath: path.join(path.dirname(params.filePath), backupName) } : {}),
  };
}
