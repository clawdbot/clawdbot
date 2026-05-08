import { describe, expect, it } from "vitest";
import {
  resolveWhatsAppDirectSystemPrompt,
  resolveWhatsAppGroupSystemPrompt,
} from "./system-prompt.js";

type PromptEntry = { systemPrompt?: string | null };
type PromptAccountConfig = {
  direct?: Record<string, PromptEntry>;
  groups?: Record<string, PromptEntry>;
};
type PromptParams = {
  accountConfig?: PromptAccountConfig | null;
  groupId?: string | null;
  peerId?: string | null;
};

const promptSurfaceCases = [
  {
    name: "group",
    targetKey: "groupId",
    targetId: "g1",
    collectionKey: "groups",
    specificPrompt: "group prompt",
    resolve: resolveWhatsAppGroupSystemPrompt,
  },
  {
    name: "direct",
    targetKey: "peerId",
    targetId: "p1",
    collectionKey: "direct",
    specificPrompt: "direct prompt",
    resolve: resolveWhatsAppDirectSystemPrompt,
  },
];

function createParams(
  surface: (typeof promptSurfaceCases)[number],
  accountConfig?: PromptAccountConfig | null,
  targetId: string | null | undefined = surface.targetId,
): PromptParams {
  return {
    [surface.targetKey]: targetId,
    accountConfig,
  } as PromptParams;
}

function createAccountConfig(
  surface: (typeof promptSurfaceCases)[number],
  entries: Record<string, PromptEntry>,
): PromptAccountConfig {
  return { [surface.collectionKey]: entries } as PromptAccountConfig;
}

describe("resolveWhatsAppSystemPrompt", () => {
  it.each(promptSurfaceCases)("returns undefined when $targetKey is absent", (surface) => {
    expect(surface.resolve(createParams(surface, undefined, null))).toBeUndefined();
    expect(surface.resolve(createParams(surface, undefined, undefined))).toBeUndefined();
    expect(surface.resolve({})).toBeUndefined();
  });

  it.each(promptSurfaceCases)("returns undefined when $name accountConfig is absent", (surface) => {
    expect(surface.resolve(createParams(surface, null))).toBeUndefined();
    expect(surface.resolve(createParams(surface, undefined))).toBeUndefined();
  });

  it.each(promptSurfaceCases)("returns the $name-specific systemPrompt when defined", (surface) => {
    expect(
      surface.resolve(
        createParams(
          surface,
          createAccountConfig(surface, {
            [surface.targetId]: { systemPrompt: surface.specificPrompt },
          }),
        ),
      ),
    ).toBe(surface.specificPrompt);
  });

  it.each(promptSurfaceCases)(
    "falls back to wildcard when specific $name entry is absent",
    (surface) => {
      expect(
        surface.resolve(
          createParams(
            surface,
            createAccountConfig(surface, { "*": { systemPrompt: "wildcard prompt" } }),
          ),
        ),
      ).toBe("wildcard prompt");
    },
  );

  it.each(promptSurfaceCases)(
    "suppresses wildcard when specific $name entry sets systemPrompt to empty string",
    (surface) => {
      expect(
        surface.resolve(
          createParams(
            surface,
            createAccountConfig(surface, {
              [surface.targetId]: { systemPrompt: "" },
              "*": { systemPrompt: "wildcard prompt" },
            }),
          ),
        ),
      ).toBeUndefined();
    },
  );

  it.each(promptSurfaceCases)(
    "suppresses wildcard when specific $name entry sets systemPrompt to whitespace-only string",
    (surface) => {
      expect(
        surface.resolve(
          createParams(
            surface,
            createAccountConfig(surface, {
              [surface.targetId]: { systemPrompt: "   " },
              "*": { systemPrompt: "wildcard prompt" },
            }),
          ),
        ),
      ).toBeUndefined();
    },
  );

  it.each(promptSurfaceCases)("trims whitespace from specific $name systemPrompt", (surface) => {
    expect(
      surface.resolve(
        createParams(
          surface,
          createAccountConfig(surface, { [surface.targetId]: { systemPrompt: "  trimmed  " } }),
        ),
      ),
    ).toBe("trimmed");
  });

  it.each(promptSurfaceCases)(
    "returns undefined when specific $name entry has no systemPrompt key and no wildcard",
    (surface) => {
      expect(
        surface.resolve(
          createParams(surface, createAccountConfig(surface, { [surface.targetId]: {} })),
        ),
      ).toBeUndefined();
    },
  );

  it.each(promptSurfaceCases)(
    "falls back to wildcard when specific $name entry has no systemPrompt key",
    (surface) => {
      expect(
        surface.resolve(
          createParams(
            surface,
            createAccountConfig(surface, {
              [surface.targetId]: {},
              "*": { systemPrompt: "wildcard prompt" },
            }),
          ),
        ),
      ).toBe("wildcard prompt");
    },
  );
});
