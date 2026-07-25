import Foundation
import SwiftUI
#if os(macOS)
import AppKit
#endif

enum OpenClawChatTypography {
    static let bodySize: CGFloat = 17

    static var headline: Font {
        display(size: 17, weight: .semibold, relativeTo: .headline)
    }

    static func heading(level: Int) -> Font {
        switch level {
        case 1:
            self.display(size: 24, weight: .bold, relativeTo: .title2)
        case 2:
            self.display(size: 21, weight: .bold, relativeTo: .title3)
        case 3:
            self.display(size: 19, weight: .semibold, relativeTo: .headline)
        case 4:
            self.body(size: 17, weight: .semibold, relativeTo: .body)
        case 5:
            self.body(size: 16, weight: .semibold, relativeTo: .callout)
        default:
            self.body(size: 15, weight: .semibold, relativeTo: .subheadline)
        }
    }

    static var callout: Font {
        body(size: 16, weight: .regular, relativeTo: .callout)
    }

    static var body: Font {
        body(size: self.bodySize, weight: .regular, relativeTo: .body)
    }

    static var footnote: Font {
        body(size: 13, weight: .regular, relativeTo: .footnote)
    }

    static var footnoteSemiBold: Font {
        body(size: 13, weight: .semibold, relativeTo: .footnote)
    }

    static var caption: Font {
        body(size: 12, weight: .regular, relativeTo: .caption)
    }

    static var captionSemiBold: Font {
        body(size: 12, weight: .semibold, relativeTo: .caption)
    }

    static var caption2: Font {
        body(size: 11, weight: .regular, relativeTo: .caption2)
    }

    static func avatar(size: CGFloat) -> Font {
        self.body(size: size, weight: .bold, relativeTo: .caption)
    }

    static func body(size: CGFloat, weight: Font.Weight, relativeTo textStyle: Font.TextStyle) -> Font {
        #if os(iOS)
        Font.custom(self.bodyPostScriptName, size: size, relativeTo: textStyle).weight(weight)
        #elseif os(macOS)
        Font.custom(self.macSystemFontName(size: size), size: size, relativeTo: textStyle).weight(weight)
        #else
        Font.system(size: size, weight: weight)
        #endif
    }

    static func display(size: CGFloat, weight: Font.Weight, relativeTo textStyle: Font.TextStyle) -> Font {
        #if os(iOS)
        Font.custom(self.displayPostScriptName, size: size, relativeTo: textStyle).weight(weight)
        #elseif os(macOS)
        Font.custom(self.macSystemFontName(size: size), size: size, relativeTo: textStyle).weight(weight)
        #else
        Font.system(size: size, weight: weight)
        #endif
    }

    static func mono(size: CGFloat, weight: Font.Weight = .regular, relativeTo textStyle: Font.TextStyle) -> Font {
        #if os(iOS)
        let name = weight == .semibold ? Self.monoSemiBoldPostScriptName : Self.monoPostScriptName
        return Font.custom(name, size: size, relativeTo: textStyle)
        #elseif os(macOS)
        return Font.custom(self.macMonospacedSystemFontName(size: size), size: size, relativeTo: textStyle)
            .weight(weight)
        #else
        return Font.system(size: size, weight: weight, design: .monospaced)
        #endif
    }

    private static let displayPostScriptName = "RedHatDisplay-Regular"
    private static let bodyPostScriptName = "Inter-Regular"
    private static let monoPostScriptName = "JetBrainsMono-Regular"
    private static let monoSemiBoldPostScriptName = "JetBrainsMono-SemiBold"

    #if os(macOS)
    private static func macSystemFontName(size: CGFloat) -> String {
        NSFont.systemFont(ofSize: size).fontName
    }

    private static func macMonospacedSystemFontName(size: CGFloat) -> String {
        NSFont.monospacedSystemFont(ofSize: size, weight: .regular).fontName
    }
    #endif
}
