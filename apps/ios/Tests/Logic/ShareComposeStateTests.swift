import Foundation
import Testing

struct ShareComposeStateTests {
    @Test func `locks send and editing while the draft is being prepared`() {
        let controls = ShareComposeControlState.resolve(status: .preparing, hasDraftText: false)
        #expect(controls == ShareComposeControlState(isSendEnabled: false, isCancelEnabled: true, isEditable: false))
    }

    @Test func `enables send only when the ready draft has text`() {
        #expect(ShareComposeControlState.resolve(status: .ready, hasDraftText: true).isSendEnabled)
        #expect(!ShareComposeControlState.resolve(status: .ready, hasDraftText: false).isSendEnabled)
    }

    @Test(arguments: [ShareComposeStatus.sending, .sent])
    func `locks every control while sending and after success`(_ status: ShareComposeStatus) {
        let controls = ShareComposeControlState.resolve(status: status, hasDraftText: true)
        #expect(controls == ShareComposeControlState(
            isSendEnabled: false,
            isCancelEnabled: false,
            isEditable: false))
    }

    @Test func `recovers send and editing after a failure`() {
        let controls = ShareComposeControlState.resolve(status: .failed("offline"), hasDraftText: true)
        #expect(controls == ShareComposeControlState(isSendEnabled: true, isCancelEnabled: true, isEditable: true))
    }

    @Test func `keeps send blocked when an attachment cannot be prepared`() {
        let controls = ShareComposeControlState.resolve(status: .blocked("invalid image"), hasDraftText: true)
        #expect(controls == ShareComposeControlState(isSendEnabled: false, isCancelEnabled: true, isEditable: true))
    }
}
