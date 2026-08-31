import { LanguageDescription } from "@codemirror/language";
import { languages } from "@codemirror/language-data";

export async function loadCodeLanguage(path: string) {
  const name = path.replaceAll("\\", "/").split("/").at(-1) ?? path;
  const description = LanguageDescription.matchFilename(languages, name);
  if (!description) {
    return null;
  }
  try {
    return await description.load();
  } catch {
    return null;
  }
}
