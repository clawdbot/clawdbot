import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

// Canvas annotation copy registers with the lazy commenter and composer card,
// keeping feature-only strings out of the Control UI startup bundle.
const enCanvasAnnotation = {
  browser: {
    annotatePrompt: {
      browserTarget: "Browser target: {target}",
      // Fresh key names ensure translated catalogs pick up provenance wording changes
      // instead of retaining an older source string under the same key.
      introTitled:
        'I annotated the page at {url} (page-reported title: "{title}") — the attached screenshot shows my markup.',
      introUntitled: "I annotated the page at {url} — the attached screenshot shows my markup.",
      region:
        "Marked region {index}: centered around {x}% across / {y}% down, spanning about {width}% × {height}% of the view.",
      moreRegions: "…plus {count} more marked region(s), all visible in the screenshot.",
      elementDetail:
        "Marked element (page-reported): {descriptor} — {width}×{height}px at ({x}, {y}).",
      elementComment: "Operator comment: {comment}",
      outro: "Please look at the marked area and tell me what you make of it.",
    },
  },
  chat: {
    board: {
      annotating: "Annotating",
      commentInput: "Comment on selected Canvas element",
      commentElementUnavailable: "No HTML element was found here. Try another spot.",
      commentFailed: "Could not capture this Canvas element: {error}",
    },
    composer: {
      browserAnnotationCount: "{count} annotation",
      browserAnnotationCountPlural: "{count} annotations",
    },
  },
} satisfies TranslationMap;

function getSection(catalog: TranslationMap, key: string): TranslationMap {
  // SAFETY: Every requested key names an object section in the canonical English catalog.
  return catalog[key] as TranslationMap;
}

export const registerCanvasAnnotationEnglish = Object.assign(
  () => {
    const browser = getSection(en, "browser");
    Object.assign(getSection(browser, "annotatePrompt"), enCanvasAnnotation.browser.annotatePrompt);
    const chat = getSection(en, "chat");
    Object.assign(getSection(chat, "board"), enCanvasAnnotation.chat.board);
    Object.assign(getSection(chat, "composer"), enCanvasAnnotation.chat.composer);
  },
  { catalog: enCanvasAnnotation },
);
