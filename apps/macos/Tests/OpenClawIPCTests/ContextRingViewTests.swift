import Testing
@testable import OpenClaw

struct ContextRingViewTests {
    @Test(arguments: [0.0, 0.42, 0.84])
    func `ordinary usage stays muted without a percentage`(ratio: Double) {
        let style = ContextRingStyle(ratio: ratio)

        #expect(!style.showsLabel)
        #expect(style.noticeColor == nil)
    }

    @Test func `warning threshold reveals the amber percentage`() {
        let style = ContextRingStyle(ratio: 0.85)

        #expect(style.showsLabel)
        #expect(style.percent == 85)
        #expect(style.noticeColor == .init(red: 245, green: 158, blue: 11))
    }

    @Test func `warning color interpolates smoothly before saturating at danger`() {
        let midpoint = ContextRingStyle(ratio: 0.90)
        let danger = ContextRingStyle(ratio: 0.95)
        let overflow = ContextRingStyle(ratio: 1.2)

        #expect(midpoint.noticeColor == .init(red: 242, green: 113, blue: 40))
        #expect(danger.noticeColor == .init(red: 239, green: 68, blue: 68))
        #expect(overflow.noticeColor == danger.noticeColor)
    }

    @Test(arguments: [(0.844, 84), (0.845, 85), (0.946, 95), (1.2, 100), (-0.1, 0)])
    func `percentage rounds to the nearest bounded whole percent`(ratio: Double, expected: Int) {
        #expect(ContextRingStyle(ratio: ratio).percent == expected)
    }
}
