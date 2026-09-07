import Testing
@testable import OpenClaw

struct AppleHealthDisclosureTests {
    @Test func `native Apple Health consent names its source data and destination`() {
        let consent = IOSDeviceSettingsConsent.healthSummary

        #expect(consent.title.contains("Apple Health"))
        #expect(consent.detail.contains("steps, sleep, resting heart rate, and workouts"))
        #expect(consent.detail.contains("from Apple Health only when a summary is requested"))
        #expect(consent.detail.contains("Only the aggregate leaves this device"))
        #expect(consent.detail.contains("your Gateway to your configured AI provider"))
        #expect(consent.detail.contains("raw samples stay on this device"))
        #expect(consent.detail.contains("results may remain in chat history"))
    }
}
