import SwiftUI

#if os(macOS)
import AppKit
#else
import UIKit
#endif

#if os(macOS)
extension NSAppearance {
    fileprivate var isDarkAqua: Bool {
        self.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
    }
}
#endif

enum OpenClawChatTheme {
    #if !os(macOS)
    private enum IOSPalette {
        static let lightCanvasTop = UIColor(red: 246 / 255.0, green: 247 / 255.0, blue: 249 / 255.0, alpha: 1)
        static let lightCanvasMiddle = UIColor(red: 250 / 255.0, green: 251 / 255.0, blue: 252 / 255.0, alpha: 1)
        static let lightCanvasBottom = UIColor.white
        static let lightAccent = UIColor(red: 220 / 255.0, green: 38 / 255.0, blue: 38 / 255.0, alpha: 1)
        static let darkCanvasTop = UIColor(red: 12 / 255.0, green: 13 / 255.0, blue: 15 / 255.0, alpha: 1)
        static let darkCanvasMiddle = UIColor(red: 7 / 255.0, green: 8 / 255.0, blue: 10 / 255.0, alpha: 1)
        static let darkCanvasBottom = UIColor(red: 4 / 255.0, green: 5 / 255.0, blue: 6 / 255.0, alpha: 1)
        static let darkPanel = UIColor(red: 10 / 255.0, green: 12 / 255.0, blue: 14 / 255.0, alpha: 1)
        static let darkPanelRaised = UIColor(red: 17 / 255.0, green: 18 / 255.0, blue: 21 / 255.0, alpha: 1)
        static let darkComposer = UIColor(red: 24 / 255.0, green: 25 / 255.0, blue: 28 / 255.0, alpha: 1)
        static let darkAccent = UIColor(red: 198 / 255.0, green: 49 / 255.0, blue: 42 / 255.0, alpha: 1)
    }

    private static func adaptiveColor(
        light: UIColor,
        dark: UIColor) -> Color
    {
        Color(uiColor: UIColor { traits in
            traits.userInterfaceStyle == .dark ? dark : light
        })
    }
    #endif

    #if os(macOS)
    static func resolvedAssistantBubbleColor(for appearance: NSAppearance) -> NSColor {
        // NSColor semantic colors don't reliably resolve for arbitrary NSAppearance in SwiftPM.
        // Use explicit light/dark values so the bubble updates when the system appearance flips.
        appearance.isDarkAqua
            ? NSColor(calibratedWhite: 0.18, alpha: 0.88)
            : NSColor(calibratedWhite: 0.94, alpha: 0.92)
    }

    static func resolvedOnboardingAssistantBubbleColor(for appearance: NSAppearance) -> NSColor {
        appearance.isDarkAqua
            ? NSColor(calibratedWhite: 0.20, alpha: 0.94)
            : NSColor(calibratedWhite: 0.97, alpha: 0.98)
    }

    static let assistantBubbleDynamicNSColor = NSColor(
        name: NSColor.Name("OpenClawChatTheme.assistantBubble"),
        dynamicProvider: resolvedAssistantBubbleColor(for:))

    static let onboardingAssistantBubbleDynamicNSColor = NSColor(
        name: NSColor.Name("OpenClawChatTheme.onboardingAssistantBubble"),
        dynamicProvider: resolvedOnboardingAssistantBubbleColor(for:))
    #endif

    @ViewBuilder
    static var background: some View {
        #if os(macOS)
        // Plain material so the chat reads as a native surface; the window
        // (or the anchored panel's effect view) supplies the vibrancy.
        Rectangle()
            .fill(.ultraThinMaterial)
        #else
        ZStack {
            LinearGradient(
                colors: [
                    self.adaptiveColor(
                        light: IOSPalette.lightCanvasTop,
                        dark: IOSPalette.darkCanvasTop),
                    self.adaptiveColor(
                        light: IOSPalette.lightCanvasMiddle,
                        dark: IOSPalette.darkCanvasMiddle),
                    self.adaptiveColor(
                        light: IOSPalette.lightCanvasBottom,
                        dark: IOSPalette.darkCanvasBottom),
                ],
                startPoint: .topLeading,
                endPoint: .bottomTrailing)
        }
        #endif
    }

    static var subtleCard: AnyShapeStyle {
        #if os(macOS)
        AnyShapeStyle(.ultraThinMaterial)
        #else
        AnyShapeStyle(self.adaptiveColor(light: .tertiarySystemBackground, dark: IOSPalette.darkPanelRaised))
        #endif
    }

    static var userBubble: Color {
        #if os(macOS)
        // Follow the user's system accent; hosts can still override per-view
        // with `userAccent` (e.g. the seam color in the desktop app).
        Color(nsColor: .controlAccentColor)
        #else
        self.adaptiveColor(
            light: IOSPalette.lightAccent,
            dark: IOSPalette.darkAccent)
        #endif
    }

    static var accent: Color {
        self.userBubble
    }

    static var danger: Color {
        #if os(macOS)
        Color(nsColor: .systemRed)
        #else
        Color(uiColor: .systemRed)
        #endif
    }

    static var muted: Color {
        .secondary
    }

    static var warning: Color {
        #if os(macOS)
        Color(nsColor: .systemOrange)
        #else
        Color(uiColor: .systemOrange)
        #endif
    }

    static var assistantBubble: Color {
        #if os(macOS)
        Color(nsColor: self.assistantBubbleDynamicNSColor)
        #else
        // iMessage-style grey receiver bubble: clearly visible on the white chat surface.
        self.adaptiveColor(light: .systemGray5, dark: IOSPalette.darkPanelRaised)
        #endif
    }

    static var onboardingAssistantBubble: Color {
        #if os(macOS)
        Color(nsColor: self.onboardingAssistantBubbleDynamicNSColor)
        #else
        self.adaptiveColor(light: .secondarySystemBackground, dark: IOSPalette.darkPanelRaised)
        #endif
    }

    static var onboardingAssistantBorder: Color {
        #if os(macOS)
        Color.white.opacity(0.12)
        #else
        Color.white.opacity(0.12)
        #endif
    }

    static var userText: Color {
        .white
    }

    static var assistantText: Color {
        #if os(macOS)
        Color(nsColor: .labelColor)
        #else
        Color(uiColor: .label)
        #endif
    }

    static var composerBackground: AnyShapeStyle {
        #if os(macOS)
        AnyShapeStyle(.ultraThinMaterial)
        #else
        AnyShapeStyle(self.adaptiveColor(light: .secondarySystemGroupedBackground, dark: IOSPalette.darkPanel))
        #endif
    }

    static var composerField: AnyShapeStyle {
        #if os(macOS)
        AnyShapeStyle(.thinMaterial)
        #else
        AnyShapeStyle(self.adaptiveColor(light: .secondarySystemBackground, dark: IOSPalette.darkComposer))
        #endif
    }

    static var composerBorder: Color {
        #if os(macOS)
        Color.white.opacity(0.12)
        #else
        self.adaptiveColor(light: .separator, dark: UIColor.white.withAlphaComponent(0.14))
        #endif
    }

    static var divider: Color {
        Color.secondary.opacity(0.2)
    }
}

enum OpenClawPlatformImageFactory {
    static func image(_ image: OpenClawPlatformImage) -> Image {
        #if os(macOS)
        Image(nsImage: image)
        #else
        Image(uiImage: image)
        #endif
    }
}
