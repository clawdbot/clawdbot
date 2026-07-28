import Testing
import UIKit
@testable import OpenClaw

struct OpenClawBrandTests {
    @Test func `brand colors meet text contrast in both appearances`() {
        let foregroundColors = [
            ("accent", OpenClawBrand.uiAccentForeground),
            ("accentHot", OpenClawBrand.uiAccentHotForeground),
            ("ok", OpenClawBrand.uiOK),
            ("warn", OpenClawBrand.uiWarn),
            ("danger", OpenClawBrand.uiDanger),
            ("info", OpenClawBrand.uiInfo),
        ]
        let backgrounds = [UIColor.systemBackground, UIColor.secondarySystemBackground]

        for style in [UIUserInterfaceStyle.light, .dark] {
            let traits = UITraitCollection(userInterfaceStyle: style)
            for (name, color) in foregroundColors {
                for background in backgrounds {
                    #expect(
                        Self.contrastRatio(color, background, traits: traits) >= 4.5,
                        "\(name) on system background in \(style)")
                }

                let tintedBackground = Self.composite(
                    color,
                    alpha: 0.10,
                    over: .secondarySystemGroupedBackground,
                    traits: traits)
                #expect(
                    Self.contrastRatio(color, tintedBackground, traits: traits) >= 4.5,
                    "\(name) on tinted background in \(style)")
            }

            let pillBackground = Self.composite(
                OpenClawBrand.uiAccentForeground,
                alpha: style == .dark ? 0.12 : 0.08,
                over: .secondarySystemGroupedBackground,
                traits: traits)
            #expect(Self.contrastRatio(OpenClawBrand.uiAccentForeground, pillBackground, traits: traits) >= 4.5)
            #expect(Self.contrastRatio(OpenClawBrand.uiAccent, .white, traits: traits) >= 4.5)
        }
    }

    private static func composite(
        _ foreground: UIColor,
        alpha: CGFloat,
        over background: UIColor,
        traits: UITraitCollection) -> UIColor
    {
        let foregroundComponents = Self.rgbComponents(foreground, traits: traits)
        let backgroundComponents = Self.rgbComponents(background, traits: traits)
        return UIColor(
            red: foregroundComponents.red * alpha + backgroundComponents.red * (1 - alpha),
            green: foregroundComponents.green * alpha + backgroundComponents.green * (1 - alpha),
            blue: foregroundComponents.blue * alpha + backgroundComponents.blue * (1 - alpha),
            alpha: 1)
    }

    private static func contrastRatio(
        _ foreground: UIColor,
        _ background: UIColor,
        traits: UITraitCollection) -> CGFloat
    {
        let foregroundLuminance = Self.relativeLuminance(foreground, traits: traits)
        let backgroundLuminance = Self.relativeLuminance(background, traits: traits)
        let lighter = max(foregroundLuminance, backgroundLuminance)
        let darker = min(foregroundLuminance, backgroundLuminance)
        return (lighter + 0.05) / (darker + 0.05)
    }

    private static func relativeLuminance(_ color: UIColor, traits: UITraitCollection) -> CGFloat {
        let components = Self.rgbComponents(color, traits: traits)

        func linearize(_ component: CGFloat) -> CGFloat {
            component <= 0.04045
                ? component / 12.92
                : pow((component + 0.055) / 1.055, 2.4)
        }

        return 0.2126 * linearize(components.red) + 0.7152 * linearize(components.green) +
            0.0722 * linearize(components.blue)
    }

    private static func rgbComponents(
        _ color: UIColor,
        traits: UITraitCollection) -> (red: CGFloat, green: CGFloat, blue: CGFloat)
    {
        let resolved = color.resolvedColor(with: traits)
        var red: CGFloat = 0
        var green: CGFloat = 0
        var blue: CGFloat = 0
        var alpha: CGFloat = 0
        guard resolved.getRed(&red, green: &green, blue: &blue, alpha: &alpha) else {
            return (0, 0, 0)
        }
        return (red, green, blue)
    }
}
