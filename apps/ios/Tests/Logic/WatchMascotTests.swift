import Testing

struct WatchMascotTests {
    @Test func `approvals are attentive`() {
        #expect(watchInboxMascotMood(
            hasSnapshot: true,
            hasApprovals: true,
            hasChats: false) == .attentive)
    }

    @Test func `missing snapshot is thinking`() {
        #expect(watchInboxMascotMood(
            hasSnapshot: false,
            hasApprovals: false,
            hasChats: false) == .thinking)
    }

    @Test func `empty synchronized inbox is sleepy`() {
        #expect(watchInboxMascotMood(
            hasSnapshot: true,
            hasApprovals: false,
            hasChats: false) == .sleepy)
    }

    @Test func `synchronized chats are idle`() {
        #expect(watchInboxMascotMood(
            hasSnapshot: true,
            hasApprovals: false,
            hasChats: true) == .idle)
    }

    @Test func `approval and snapshot precedence wins over chats`() {
        #expect(watchInboxMascotMood(
            hasSnapshot: false,
            hasApprovals: true,
            hasChats: true) == .attentive)
        #expect(watchInboxMascotMood(
            hasSnapshot: false,
            hasApprovals: false,
            hasChats: true) == .thinking)
    }
}
