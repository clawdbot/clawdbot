import fs from "node:fs/promises";
import JSZip from "jszip";
import { ToolInputError } from "./common.js";

const MAX_XML_BYTES = 8 * 1024 * 1024;

async function readXmlPart(zip: JSZip, name: string): Promise<string> {
  const entry = zip.file(name);
  if (!entry) {
    throw new Error("Missing Word package part");
  }
  // Bound decompression independently of the compressed upload size.
  const stream = entry.nodeStream();
  const chunks: Buffer[] = [];
  let size = 0;
  // Pause the readable stream at the limit; backpressure bounds decompression.
  return new Promise((resolve, reject) => {
    stream.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_XML_BYTES) {
        stream.pause();
        reject(new Error("Word XML part exceeds validation limit"));
        return;
      }
      chunks.push(chunk);
    });
    stream.on("error", reject);
    stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    stream.resume();
  });
}

/** Basic package validation, not a full Office schema or rendering check. */
export async function assertDocxPackage(filePath: string): Promise<void> {
  try {
    const zip = await JSZip.loadAsync(await fs.readFile(filePath));
    const types = await readXmlPart(zip, "[Content_Types].xml");
    const relationships = await readXmlPart(zip, "_rels/.rels");
    const document = await readXmlPart(zip, "word/document.xml");
    if (
      !types.includes(
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml",
      ) ||
      !relationships.includes("/relationships/officeDocument") ||
      !relationships.includes("word/document.xml") ||
      !/<(?:[\w.-]+:)?document\b/u.test(document) ||
      !/<(?:[\w.-]+:)?body\b/u.test(document) ||
      !/https?:\/\/(?:schemas\.openxmlformats\.org\/wordprocessingml\/2006\/main|purl\.oclc\.org\/ooxml\/wordprocessingml\/main)/u.test(
        document,
      )
    ) {
      throw new Error("Invalid Word package structure");
    }
  } catch {
    throw new ToolInputError(
      "Invalid DOCX: expected a readable Office Open XML ZIP package with [Content_Types].xml, _rels/.rels and word/document.xml (each XML part at most 8MB). DOCX sharing is supported; renaming HTML/text to .docx does not convert it. Use exec with an available DOCX generator (for example python-docx), validate the generated document, then retry file_share. If execution fails, report the actual tool error instead of claiming DOCX is unsupported.",
    );
  }
}
