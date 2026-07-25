import CoreText
import SwiftUI
import UIKit

enum OpenClawType {
    // MARK: - Display — Red Hat Display

    static var title1: Font {
        scaledDisplay(weight: Display.heavyTitle, size: 34, relativeTo: .largeTitle)
    }

    static var title2: Font {
        scaledDisplay(weight: Display.heavyTitle, size: 28, relativeTo: .title1)
    }

    static var title3: Font {
        scaledDisplay(weight: Display.opticalBold, size: 22, relativeTo: .title2)
    }

    static var title3SemiBold: Font {
        scaledDisplay(weight: Display.opticalSemiBold, size: 22, relativeTo: .title2)
    }

    static var headline: Font {
        scaledDisplay(weight: Display.opticalSemiBold, size: 17, relativeTo: .headline)
    }

    static var headlineBold: Font {
        scaledDisplay(weight: Display.opticalBold, size: 17, relativeTo: .headline)
    }

    // MARK: - Body — Inter

    static var body: Font {
        scaledBody(weight: Body.regular, size: 17, relativeTo: .body)
    }

    static var callout: Font {
        scaledBody(weight: Body.regular, size: 16, relativeTo: .callout)
    }

    static var subhead: Font {
        scaledBody(weight: Body.regular, size: 15, relativeTo: .subheadline)
    }

    static var subheadMedium: Font {
        scaledBody(weight: Body.medium, size: 15, relativeTo: .subheadline)
    }

    static var subheadSemiBold: Font {
        scaledDisplay(weight: Display.opticalSemiBold, size: 15, relativeTo: .subheadline)
    }

    static var subheadBold: Font {
        scaledDisplay(weight: Display.opticalBold, size: 15, relativeTo: .subheadline)
    }

    static var footnote: Font {
        scaledBody(weight: Body.regular, size: 13, relativeTo: .footnote)
    }

    static var footnoteMedium: Font {
        scaledBody(weight: Body.medium, size: 13, relativeTo: .footnote)
    }

    static var footnoteSemiBold: Font {
        scaledBody(weight: Body.semiBold, size: 13, relativeTo: .footnote)
    }

    static var caption: Font {
        scaledBody(weight: Body.regular, size: 12, relativeTo: .caption1)
    }

    static var captionMedium: Font {
        scaledBody(weight: Body.medium, size: 12, relativeTo: .caption1)
    }

    static var captionSemiBold: Font {
        scaledBody(weight: Body.semiBold, size: 12, relativeTo: .caption1)
    }

    static var captionBold: Font {
        scaledBody(weight: Body.bold, size: 12, relativeTo: .caption1)
    }

    static func avatar(size: CGFloat) -> Font {
        self.scaledBody(weight: Body.bold, size: size, relativeTo: .caption1)
    }

    static var caption2: Font {
        scaledBody(weight: Body.regular, size: 11, relativeTo: .caption2)
    }

    static var caption2Medium: Font {
        scaledBody(weight: Body.medium, size: 11, relativeTo: .caption2)
    }

    static var caption2SemiBold: Font {
        scaledBody(weight: Body.semiBold, size: 11, relativeTo: .caption2)
    }

    static var caption2Bold: Font {
        scaledDisplay(weight: Display.opticalBold, size: 11, relativeTo: .caption2)
    }

    static var title2SemiBold: Font {
        scaledDisplay(weight: Display.opticalSemiBold, size: 28, relativeTo: .title1)
    }

    // MARK: - Mono — JetBrains Mono

    static var mono: Font {
        scaledMono(name: Mono.regular, size: 14, relativeTo: .body)
    }

    static var monoSmall: Font {
        scaledMono(name: Mono.regular, size: 12, relativeTo: .caption1)
    }

    static var monoSmallMedium: Font {
        scaledMono(name: Mono.medium, size: 12, relativeTo: .caption1)
    }

    static var monoCaption2: Font {
        scaledMono(name: Mono.regular, size: 11, relativeTo: .caption2)
    }

    static var monoFootnote: Font {
        scaledMono(name: Mono.regular, size: 13, relativeTo: .footnote)
    }

    /// PostScript names for bundled fonts. Keep aligned with `UIAppFonts` in `project.yml`.
    static let registeredPostScriptNames: [String] = [
        Display.postScriptName,
        Body.postScriptName,
        Body.italicPostScriptName,
        Mono.regular,
        Mono.medium,
        Mono.semiBold,
    ]

    @MainActor
    static func installUIKitAppearance() {
        self.applyUIKitAppearance(self.makeUIKitAppearanceFonts())
    }

    @MainActor
    static func refreshUIKitAppearance(in windows: [UIWindow]) {
        let fonts = self.makeUIKitAppearanceFonts()
        self.applyUIKitAppearance(fonts)
        for window in windows {
            self.applyUIKitTypography(fonts, to: window)
        }
    }

    private static func makeUIKitAppearanceFonts() -> UIKitAppearanceFonts {
        UIKitAppearanceFonts(
            inlineNavigationTitleFont: self.scaledDisplayUIFont(
                weight: Display.opticalSemiBold,
                size: 17,
                relativeTo: .headline,
                maximumPointSize: 22),
            largeNavigationTitleFont: self.scaledDisplayUIFont(
                weight: Display.heavyTitle,
                size: 34,
                relativeTo: .largeTitle,
                maximumPointSize: 44),
            tabBarNormalFont: self.scaledBodyUIFont(
                weight: Body.medium,
                size: 11,
                relativeTo: .caption2,
                maximumPointSize: 13),
            tabBarSelectedFont: self.scaledBodyUIFont(
                weight: Body.semiBold,
                size: 11,
                relativeTo: .caption2,
                maximumPointSize: 13),
            segmentedNormalFont: self.scaledBodyUIFont(
                weight: Body.medium,
                size: 13,
                relativeTo: .footnote,
                maximumPointSize: 16),
            segmentedSelectedFont: self.scaledBodyUIFont(
                weight: Body.semiBold,
                size: 13,
                relativeTo: .footnote,
                maximumPointSize: 16),
            barButtonFont: self.scaledBodyUIFont(
                weight: Body.semiBold,
                size: 17,
                relativeTo: .body,
                maximumPointSize: 22),
            disabledBarButtonFont: self.scaledBodyUIFont(
                weight: Body.regular,
                size: 17,
                relativeTo: .body,
                maximumPointSize: 22),
            textInputFont: self.scaledBodyUIFont(
                weight: Body.regular,
                size: 17,
                relativeTo: .body,
                maximumPointSize: 22))
    }

    @MainActor
    private static func applyUIKitAppearance(_ fonts: UIKitAppearanceFonts) {
        let navigationBar = UINavigationBar.appearance()
        self.applyNavigationBarTitleAttributes(fonts, to: navigationBar)

        let tabBarItem = UITabBarItem.appearance()
        self.applyTabBarItemAttributes(fonts, to: tabBarItem)

        let segmentedControl = UISegmentedControl.appearance()
        self.applySegmentedControlAttributes(fonts, to: segmentedControl)

        let barButtonItem = UIBarButtonItem.appearance()
        self.applyBarButtonItemAttributes(fonts, to: barButtonItem)

        UITextField.appearance().font = fonts.textInputFont
        UITextView.appearance().font = fonts.textInputFont
        UISearchTextField.appearance().font = fonts.textInputFont
    }

    @MainActor
    private static func applyUIKitTypography(_ fonts: UIKitAppearanceFonts, to view: UIView) {
        switch view {
        case let navigationBar as UINavigationBar:
            self.applyNavigationBarTitleAttributes(fonts, to: navigationBar)
            for item in navigationBar.items ?? [] {
                self.applyNavigationItemBarButtonAttributes(fonts, to: item)
            }
            if let topItem = navigationBar.topItem {
                self.applyNavigationItemBarButtonAttributes(fonts, to: topItem)
            }
        case let tabBar as UITabBar:
            tabBar.items?.forEach { self.applyTabBarItemAttributes(fonts, to: $0) }
        case let segmentedControl as UISegmentedControl:
            self.applySegmentedControlAttributes(fonts, to: segmentedControl)
        case let toolbar as UIToolbar:
            toolbar.items?.forEach { self.applyBarButtonItemAttributes(fonts, to: $0) }
        case let searchTextField as UISearchTextField:
            searchTextField.font = fonts.textInputFont
        default:
            break
        }

        for subview in view.subviews {
            self.applyUIKitTypography(fonts, to: subview)
        }
    }

    @MainActor
    private static func applyNavigationBarTitleAttributes(
        _ fonts: UIKitAppearanceFonts,
        to navigationBar: UINavigationBar)
    {
        var titleAttributes = navigationBar.titleTextAttributes ?? [:]
        titleAttributes[.font] = fonts.inlineNavigationTitleFont
        navigationBar.titleTextAttributes = titleAttributes

        var largeTitleAttributes = navigationBar.largeTitleTextAttributes ?? [:]
        largeTitleAttributes[.font] = fonts.largeNavigationTitleFont
        navigationBar.largeTitleTextAttributes = largeTitleAttributes
    }

    @MainActor
    private static func applyTabBarItemAttributes(_ fonts: UIKitAppearanceFonts, to tabBarItem: UITabBarItem) {
        tabBarItem.setTitleTextAttributes([.font: fonts.tabBarNormalFont], for: .normal)
        tabBarItem.setTitleTextAttributes([.font: fonts.tabBarSelectedFont], for: .selected)
    }

    @MainActor
    private static func applySegmentedControlAttributes(
        _ fonts: UIKitAppearanceFonts,
        to segmentedControl: UISegmentedControl)
    {
        segmentedControl.setTitleTextAttributes([.font: fonts.segmentedNormalFont], for: .normal)
        segmentedControl.setTitleTextAttributes([.font: fonts.segmentedSelectedFont], for: .selected)
    }

    @MainActor
    private static func applyBarButtonItemAttributes(_ fonts: UIKitAppearanceFonts, to barButtonItem: UIBarButtonItem) {
        barButtonItem.setTitleTextAttributes([.font: fonts.barButtonFont], for: .normal)
        barButtonItem.setTitleTextAttributes([.font: fonts.barButtonFont], for: .highlighted)
        barButtonItem.setTitleTextAttributes([.font: fonts.barButtonFont], for: .selected)
        barButtonItem.setTitleTextAttributes([.font: fonts.disabledBarButtonFont], for: .disabled)
    }

    @MainActor
    private static func applyNavigationItemBarButtonAttributes(
        _ fonts: UIKitAppearanceFonts,
        to item: UINavigationItem)
    {
        let barButtonItems = [
            item.backBarButtonItem,
            item.leftBarButtonItem,
            item.rightBarButtonItem,
        ] + (item.leftBarButtonItems ?? []) + (item.rightBarButtonItems ?? [])
        barButtonItems.compactMap(\.self).forEach { self.applyBarButtonItemAttributes(fonts, to: $0) }
    }

    private struct UIKitAppearanceFonts {
        let inlineNavigationTitleFont: UIFont
        let largeNavigationTitleFont: UIFont
        let tabBarNormalFont: UIFont
        let tabBarSelectedFont: UIFont
        let segmentedNormalFont: UIFont
        let segmentedSelectedFont: UIFont
        let barButtonFont: UIFont
        let disabledBarButtonFont: UIFont
        let textInputFont: UIFont
    }

    private enum Display {
        static let postScriptName = "RedHatDisplay-Regular"
        static let opticalSemiBold: CGFloat = 650
        static let opticalBold: CGFloat = 750
        static let heavyTitle: CGFloat = 800
    }

    private enum Body {
        static let postScriptName = "Inter-Regular"
        static let italicPostScriptName = "Inter-Italic"
        static let regular: CGFloat = 400
        static let medium: CGFloat = 500
        static let semiBold: CGFloat = 600
        static let bold: CGFloat = 700
    }

    private enum Mono {
        static let regular = "JetBrainsMono-Regular"
        static let medium = "JetBrainsMono-Medium"
        static let semiBold = "JetBrainsMono-SemiBold"
    }

    private static let fontWeightAxis = NSNumber(value: 2_003_265_652) // "wght"
    private static let opticalSizeAxis = NSNumber(value: 1_869_640_570) // "opsz"

    private static func scaledDisplay(
        weight: CGFloat,
        size: CGFloat,
        relativeTo textStyle: UIFont.TextStyle) -> Font
    {
        Font(
            self.scaledDisplayUIFont(
                weight: weight,
                size: size,
                relativeTo: textStyle))
    }

    private static func scaledBody(
        weight: CGFloat,
        size: CGFloat,
        relativeTo textStyle: UIFont.TextStyle) -> Font
    {
        Font(
            self.scaledBodyUIFont(
                weight: weight,
                size: size,
                relativeTo: textStyle))
    }

    private static func scaledMono(
        name: String,
        size: CGFloat,
        relativeTo textStyle: UIFont.TextStyle) -> Font
    {
        self.scaledFont(name: name, size: size, relativeTo: textStyle)
    }

    private static func scaledDisplayUIFont(
        weight: CGFloat,
        size: CGFloat,
        relativeTo textStyle: UIFont.TextStyle,
        maximumPointSize: CGFloat? = nil) -> UIFont
    {
        self.scaledVariableUIFont(
            name: Display.postScriptName,
            size: size,
            relativeTo: textStyle,
            maximumPointSize: maximumPointSize,
            variations: [self.fontWeightAxis: weight])
    }

    private static func scaledBodyUIFont(
        weight: CGFloat,
        size: CGFloat,
        relativeTo textStyle: UIFont.TextStyle,
        maximumPointSize: CGFloat? = nil) -> UIFont
    {
        self.scaledVariableUIFont(
            name: Body.postScriptName,
            size: size,
            relativeTo: textStyle,
            maximumPointSize: maximumPointSize,
            variations: [
                self.fontWeightAxis: weight,
                self.opticalSizeAxis: min(max(size, 14), 32),
            ])
    }

    private static func scaledVariableUIFont(
        name: String,
        size: CGFloat,
        relativeTo textStyle: UIFont.TextStyle,
        maximumPointSize: CGFloat? = nil,
        variations: [NSNumber: CGFloat]) -> UIFont
    {
        guard UIFont(name: name, size: size) != nil else {
            let fallback = UIFont.systemFont(ofSize: size)
            return self.scaledUIFont(fallback, relativeTo: textStyle, maximumPointSize: maximumPointSize)
        }

        let descriptor = UIFontDescriptor(fontAttributes: [
            .name: name,
            kCTFontVariationAttribute as UIFontDescriptor.AttributeName: variations,
        ])
        let base = UIFont(descriptor: descriptor, size: size)
        return self.scaledUIFont(base, relativeTo: textStyle, maximumPointSize: maximumPointSize)
    }

    private static func scaledFont(
        name: String,
        size: CGFloat,
        relativeTo textStyle: UIFont.TextStyle) -> Font
    {
        let base = UIFont(name: name, size: size) ?? UIFont.systemFont(ofSize: size)
        let scaled = UIFontMetrics(forTextStyle: textStyle).scaledFont(for: base)
        return Font(scaled)
    }

    private static func scaledUIFont(
        _ base: UIFont,
        relativeTo textStyle: UIFont.TextStyle,
        maximumPointSize: CGFloat?) -> UIFont
    {
        let metrics = UIFontMetrics(forTextStyle: textStyle)
        if let maximumPointSize {
            return metrics.scaledFont(for: base, maximumPointSize: maximumPointSize)
        }
        return metrics.scaledFont(for: base)
    }
}
