import AppKit
import Testing
@testable import OpenClaw

@MainActor
struct AppIconTests {
    @Test(arguments: [
        (NSAppearance.Name.aqua, AppIconStyle.paper),
        (.darkAqua, .ink),
        (.accessibilityHighContrastAqua, .paper),
        (.accessibilityHighContrastDarkAqua, .ink),
    ])
    func `automatic follows appearance`(name: NSAppearance.Name, expected: AppIconStyle) throws {
        let appearance = try #require(NSAppearance(named: name))
        #expect(AppIconStyle.automatic.resolved(for: appearance) == expected)
    }

    @Test func `explicit choices ignore appearance`() throws {
        let light = try #require(NSAppearance(named: .aqua))
        let dark = try #require(NSAppearance(named: .darkAqua))
        for style in AppIconStyle.allCases where style != .automatic {
            #expect(style.resolved(for: light) == style)
            #expect(style.resolved(for: dark) == style)
        }
    }

    @Test func `every choice has bundled dock artwork`() throws {
        for style in AppIconStyle.allCases where style != .automatic {
            let image = try #require(AppIconArtwork.image(for: style))
            #expect(image.isValid)
            #expect(!image.isTemplate)
            #expect(image.representations.contains { $0.pixelsWide >= 256 && $0.pixelsHigh >= 256 })
        }
    }
}
