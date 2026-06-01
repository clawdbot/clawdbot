// Regression guard for #85203: per-turn media-generation task hints must sit BELOW
// the system-prompt cache boundary so the cacheable prefix stays byte-identical
// turn-to-turn. Mirrors the composition order used at attempt.ts (embedded runner)
// and cli-runner/prepare.ts: hook prependSystemContext stays in the cacheable prefix,
// media task hints are routed below the boundary via prependSystemPromptAddition.
import { describe, expect, it, vi } from "vitest";

const imageGenerationTaskStatusMocks = vi.hoisted(() => ({
  buildActiveImageGenerationTaskPromptContextForSession: vi.fn(),
  buildImageGenerationTaskStatusDetails: vi.fn(() => ({})),
  buildImageGenerationTaskStatusText: vi.fn(() => "Image generation task status"),
  findActiveImageGenerationTaskForSession: vi.fn(),
  getImageGenerationTaskProviderId: vi.fn(),
  isActiveImageGenerationTask: vi.fn(() => false),
  IMAGE_GENERATION_TASK_KIND: "image_generation",
}));
const videoGenerationTaskStatusMocks = vi.hoisted(() => ({
  buildActiveVideoGenerationTaskPromptContextForSession: vi.fn(),
  buildVideoGenerationTaskStatusDetails: vi.fn(() => ({})),
  buildVideoGenerationTaskStatusText: vi.fn(() => "Video generation task status"),
  findActiveVideoGenerationTaskForSession: vi.fn(),
  getVideoGenerationTaskProviderId: vi.fn(),
  isActiveVideoGenerationTask: vi.fn(() => false),
  VIDEO_GENERATION_TASK_KIND: "video_generation",
}));
const musicGenerationTaskStatusMocks = vi.hoisted(() => ({
  buildActiveMusicGenerationTaskPromptContextForSession: vi.fn(),
  buildMusicGenerationTaskStatusDetails: vi.fn(() => ({})),
  buildMusicGenerationTaskStatusText: vi.fn(() => "Music generation task status"),
  findActiveMusicGenerationTaskForSession: vi.fn(),
  MUSIC_GENERATION_TASK_KIND: "music_generation",
}));

vi.mock("../../image-generation-task-status.js", () => imageGenerationTaskStatusMocks);
vi.mock("../../music-generation-task-status.js", () => musicGenerationTaskStatusMocks);
vi.mock("../../video-generation-task-status.js", () => videoGenerationTaskStatusMocks);

import {
  ensureSystemPromptCacheBoundary,
  SYSTEM_PROMPT_CACHE_BOUNDARY,
  splitSystemPromptCacheBoundary,
} from "../../system-prompt-cache-boundary.js";
import {
  appendModelIdentitySystemPrompt,
  buildModelIdentityPromptLine,
} from "../../system-prompt.js";
import {
  prependSystemPromptAddition,
  resolveAttemptMediaTaskSystemPromptAddition,
} from "./attempt.prompt-helpers.js";
import { composeSystemPromptWithHookContext } from "./attempt.thread-helpers.js";

const MEDIA_HINT = "Active image generation task in progress";
const HOOK = "Static plugin guidance"; // documented static-cacheable hook field, constant per turn
const BASE = `Stable workspace prefix${SYSTEM_PROMPT_CACHE_BOUNDARY}Dynamic channel guidance`;
const MODEL = "test-model-x"; // any non-empty model yields a "Current model identity:" line
const MODEL_IDENTITY_FRAGMENT = "Current model identity:";

// Mirror the production composition order at attempt.ts / cli-runner/prepare.ts:
// 1) compose base with the static hook prepend/append (above-boundary, cacheable),
// 2) route the per-turn media task hints below the cache boundary (when a task is active),
// 3) before appending the model identity line, ensure a cache boundary exists (covers
//    marker-free hook systemPrompt overrides) so the identity lands below it, not in the
//    cached prefix.
function composeTurn(opts: { activeImageTask: boolean; base?: string; hook?: string }): string {
  imageGenerationTaskStatusMocks.buildActiveImageGenerationTaskPromptContextForSession.mockReturnValue(
    opts.activeImageTask ? MEDIA_HINT : undefined,
  );
  videoGenerationTaskStatusMocks.buildActiveVideoGenerationTaskPromptContextForSession.mockReturnValue(
    undefined,
  );
  musicGenerationTaskStatusMocks.buildActiveMusicGenerationTaskPromptContextForSession.mockReturnValue(
    undefined,
  );
  const base = opts.base ?? BASE;
  const composed =
    composeSystemPromptWithHookContext({
      baseSystemPrompt: base,
      prependSystemContext: opts.hook ?? HOOK,
    }) ?? base;
  const mediaTaskSystemPromptAddition = resolveAttemptMediaTaskSystemPromptAddition({
    sessionKey: "agent:main:discord:direct:123",
    trigger: "user",
  });
  const routed = mediaTaskSystemPromptAddition
    ? prependSystemPromptAddition({
        systemPrompt: ensureSystemPromptCacheBoundary(composed),
        systemPromptAddition: mediaTaskSystemPromptAddition,
      })
    : composed;
  // Production appends the model identity line after media routing; ensure the boundary first
  // (when an identity line will be added) so it lands below the boundary, not in the cached
  // prefix — the regression the marker-free idle case caught.
  const withIdentityBoundary =
    buildModelIdentityPromptLine(MODEL) && routed.trim().length > 0
      ? ensureSystemPromptCacheBoundary(routed)
      : routed;
  return appendModelIdentitySystemPrompt({ systemPrompt: withIdentityBoundary, model: MODEL });
}

describe("#85203 media task hints stay below the system-prompt cache boundary", () => {
  it("cached stablePrefix is identical across a media-active turn and a media-idle turn", () => {
    const withMedia = splitSystemPromptCacheBoundary(composeTurn({ activeImageTask: true }));
    const withoutMedia = splitSystemPromptCacheBoundary(composeTurn({ activeImageTask: false }));
    expect(withMedia?.stablePrefix).toBe(withoutMedia?.stablePrefix);
  });

  it("documented static hook guidance stays in the cacheable prefix (use-case coverage)", () => {
    const split = splitSystemPromptCacheBoundary(composeTurn({ activeImageTask: true }));
    expect(split?.stablePrefix).toContain(HOOK);
  });

  it("media hint lands below the boundary (dynamic suffix), not in the cached prefix", () => {
    const split = splitSystemPromptCacheBoundary(composeTurn({ activeImageTask: true }));
    expect(split?.dynamicSuffix).toContain(MEDIA_HINT);
    expect(split?.stablePrefix ?? "").not.toContain(MEDIA_HINT);
  });

  // A hook that returns a full systemPrompt override produces a marker-free base; the
  // ensureSystemPromptCacheBoundary wrap inserts a boundary so media still routes below it.
  it("inserts a boundary for a marker-free hook systemPrompt override so media stays uncached", () => {
    const OVERRIDE = "Custom hook system prompt override without a cache boundary";
    const split = splitSystemPromptCacheBoundary(
      composeTurn({ activeImageTask: true, base: OVERRIDE, hook: "" }),
    );
    expect(split).toBeDefined();
    expect(split?.stablePrefix).toBe(OVERRIDE);
    expect(split?.stablePrefix ?? "").not.toContain(MEDIA_HINT);
    expect(split?.dynamicSuffix).toContain(MEDIA_HINT);
  });

  // Without ensuring the boundary on idle turns too, a marker-free override has the later
  // model-identity append land above the (absent) boundary, so the idle cached prefix
  // diverges from the active turn and prompt caching breaks across active/idle transitions.
  it("marker-free override: idle cached prefix matches the active turn after model identity is appended", () => {
    const OVERRIDE = "Custom hook system prompt override without a cache boundary";
    const active = splitSystemPromptCacheBoundary(
      composeTurn({ activeImageTask: true, base: OVERRIDE, hook: "" }),
    );
    const idle = splitSystemPromptCacheBoundary(
      composeTurn({ activeImageTask: false, base: OVERRIDE, hook: "" }),
    );
    expect(active?.stablePrefix).toBe(OVERRIDE);
    expect(idle).toBeDefined();
    expect(idle?.stablePrefix).toBe(active?.stablePrefix);
    expect(idle?.stablePrefix ?? "").not.toContain(MODEL_IDENTITY_FRAGMENT);
    expect(idle?.dynamicSuffix).toContain(MODEL_IDENTITY_FRAGMENT);
  });
});
