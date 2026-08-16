# iOS design system

OpenClaw follows the native iOS 26 design language while keeping an iOS 18 deployment target. Use SwiftUI system structure first, Liquid Glass for interactive chrome, and quiet opaque surfaces for content.

## Principles

- Prefer `NavigationStack`, `List`, `Form`, toolbars, sheets, and system controls. They adopt the current platform appearance automatically.
- Root navigation uses one black sidebar on every idiom: persistent in wide landscape and a push-reveal layer behind the content on phones, portrait, and narrow layouts.
- Reserve Liquid Glass for navigation and interactive controls. Do not apply glass to every card, row, or status surface.
- Keep content hierarchy clear with typography, spacing, and grouping before adding backgrounds.
- Use semantic colors. Red means destructive or stopped; orange means attention; green means healthy. Neutral actions use the app accent.
- Preserve Dynamic Type, VoiceOver labels, Reduce Motion, increased contrast, and 44-point touch targets.
- Use continuous corners and concentric geometry. Nested controls should visually follow their container shape.

Apple references: [Adopting Liquid Glass](https://developer.apple.com/documentation/technologyoverviews/adopting-liquid-glass), [Applying Liquid Glass to custom views](https://developer.apple.com/documentation/swiftui/applying-liquid-glass-to-custom-views), and [Build a SwiftUI app with the new design](https://developer.apple.com/videos/play/wwdc2025/323/).

## Tokens

`OpenClawProMetric` in `Sources/Design/OpenClawProComponents.swift` is the source of truth for shared geometry:

- `pagePadding`: standard page gutter
- `cardRadius`: content group radius
- `controlRadius`: inset control radius
- `drawerRadius`: all-corner radius for compact content while the sidebar is revealed
- `compactControlSize`: compact circular control size
- `bottomScrollInset`: clearance above persistent navigation

Feature-local layout enums may define row heights and grid dimensions, but should reference the shared radius instead of introducing a new card shape.

## Components

- `OpenClawProBackground`: grouped page background
- `ProCard`: quiet content grouping; never Liquid Glass
- `ProIconBadge`, `ProValuePill`: compact semantic indicators
- `OpenClawNoticeBanner`: shared connection and runtime notices
- `OpenClawAdaptiveHeaderRow`: responsive destination heading
- `OpenClawGlassControlGroup`: performance and morphing boundary for nearby glass controls
- `OpenClawSidebarPalette`: fixed black-sidebar colors that remain dark in every app appearance
- `OpenClawSidebarRevealButton`, `OpenClawSidebarHeaderLeadingSlot`: shared leading toolbar affordance
- `openClawGlassButton(prominent:tint:)`: iOS 26 glass button with an iOS 18 bordered fallback

## Liquid Glass rules

Use `openClawGlassButton` for primary actions, compact header controls, and navigation-adjacent controls. Use the prominent style for one primary action per region. Wrap nearby controls in `OpenClawGlassControlGroup`.

Do not place Liquid Glass behind reading content, forms, metrics, or every card in a scroll view. Excess glass weakens hierarchy, increases rendering cost, and competes with the sidebar and navigation chrome.

Keep new iOS APIs behind `#available(iOS 26.0, *)`. The fallback must preserve the same label, action, tint meaning, accessibility, and approximate hit target.

## Review checklist

- Uses a native container or control where one exists.
- Uses shared spacing and corner tokens.
- Has one obvious primary action.
- Keeps semantic color independent from decoration.
- Works in light and dark mode, Dynamic Type, and compact phone layouts.
- Verifies iOS 26 appearance in the simulator and preserves the iOS 18 fallback path.
- Adds matched before/after evidence for a visual change.
