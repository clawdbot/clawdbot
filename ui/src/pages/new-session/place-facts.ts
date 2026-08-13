import { t } from "../../i18n/index.ts";
import { prettifyPlatform } from "../../lib/platform-label.ts";
import type { DraftEnvironment } from "./discovery.ts";

const MAX_PLACE_MENU_FACTS = 4;
const CAPABILITY_FACT_KEYS = {
  camera: "newSession.capabilityCamera",
  location: "newSession.capabilityLocation",
  talk: "newSession.capabilityTalk",
  screen: "newSession.capabilityScreenCapture",
  canvas: "newSession.capabilityCanvas",
  microphone: "newSession.capabilityVoice",
  voice: "newSession.capabilityVoice",
} as const;

export function environmentMenuFacts(environment: DraftEnvironment | undefined): string[] {
  const facts = environment?.platform ? [prettifyPlatform(environment.platform)] : [];
  for (const capability of environment?.capabilities ?? []) {
    const family = capability.split(".", 1)[0]?.toLowerCase();
    const key = family
      ? CAPABILITY_FACT_KEYS[family as keyof typeof CAPABILITY_FACT_KEYS]
      : undefined;
    const fact = key ? t(key) : undefined;
    if (fact && !facts.includes(fact)) {
      facts.push(fact);
    }
    if (facts.length >= MAX_PLACE_MENU_FACTS) {
      break;
    }
  }
  return facts;
}
