import AppKit
@testable import OpenClaw
import Testing

@MainActor
struct AppIconTests {
    @Test(arguments: [
        (NSAppearance.Name.aqua, AppIconAppearance.light),
        (.darkAqua, .dark),
        (.accessibilityHighContrastAqua, .light),
        (.accessibilityHighContrastDarkAqua, .dark),
    ])
    func `icon pairs follow appearance`(name: NSAppearance.Name, expected: AppIconAppearance) throws {
        let appearance = try #require(NSAppearance(named: name))
        #expect(AppIconAppearance(appearance) == expected)
    }

    @Test(arguments: AppIconStyle.allCases)
    func `every design has a distinct light and dark pair`(style: AppIconStyle) throws {
        let light = try #require(AppIconArtwork.image(for: style, appearance: .light))
        let dark = try #require(AppIconArtwork.image(for: style, appearance: .dark))
        for image in [light, dark] {
            #expect(image.isValid)
            #expect(!image.isTemplate)
            #expect(image.representations.contains { $0.pixelsWide >= 256 && $0.pixelsHigh >= 256 })
        }
        #expect(try #require(light.tiffRepresentation) != #require(dark.tiffRepresentation))
    }

    @Test func `only Original delegates to native icon styling`() {
        for style in AppIconStyle.allCases {
            if #available(macOS 26, *) {
                #expect(style.usesSystemIcon == (style == .paper))
            } else {
                #expect(!style.usesSystemIcon)
            }
        }
    }
}
