import CoreMotion
import Testing
@testable import OpenClaw

struct MotionServiceTests {
    @Test func `first motion query can request authorization`() {
        #expect(MotionService.allowsMotionQuery(.notDetermined))
    }

    @Test func `authorized motion queries remain allowed`() {
        #expect(MotionService.allowsMotionQuery(.authorized))
    }

    @Test func `denied motion queries remain blocked`() {
        #expect(!MotionService.allowsMotionQuery(.denied))
    }

    @Test func `restricted motion queries remain blocked`() {
        #expect(!MotionService.allowsMotionQuery(.restricted))
    }
}
