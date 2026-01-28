import AppKit
import Testing
@testable import Moltbot

@Suite
@MainActor
struct CritterIconRendererTests {
    @Test func makeIconRendersExpectedSize() {
        let image = CritterIconRenderer.makeIcon(
            blink: 0.25,
            legWiggle: 0.5,
            earWiggle: 0.2,
            earScale: 1,
            earHoles: true,
            badge: nil)

        #expect(image.size.width == 18)
        #expect(image.size.height == 18)
        #expect(image.tiffRepresentation != nil)
    }

    @Test func makeIconRendersWithBadge() {
        let image = CritterIconRenderer.makeIcon(
            blink: 0,
            legWiggle: 0,
            earWiggle: 0,
            earScale: 1,
            earHoles: false,
            badge: .init(symbolName: "terminal.fill", prominence: .primary))

        #expect(image.tiffRepresentation != nil)
    }

    @Test func critterStatusLabelExercisesHelpers() async {
        await CritterStatusLabel.exerciseForTesting()
    }
}
