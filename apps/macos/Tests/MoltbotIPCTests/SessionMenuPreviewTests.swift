import Foundation
import Testing
@testable import Moltbot

@Suite(.serialized)
struct SessionMenuPreviewTests {
    @Test func loaderReturnsCachedItems() async {
        await SessionPreviewCache.shared._testReset()
        let items = [SessionPreviewItem(id: "1", role: .user, text: "Hi")]
        let snapshot = SessionMenuPreviewSnapshot(items: items, status: .ready)
        await SessionPreviewCache.shared._testSet(snapshot: snapshot, for: "main")

        let loaded = await SessionMenuPreviewLoader.load(sessionKey: "main", maxItems: 10)
        #expect(loaded.status == .ready)
        #expect(loaded.items.count == 1)
        #expect(loaded.items.first?.text == "Hi")
    }

    @Test func loaderReturnsEmptyWhenCachedEmpty() async {
        await SessionPreviewCache.shared._testReset()
        let snapshot = SessionMenuPreviewSnapshot(items: [], status: .empty)
        await SessionPreviewCache.shared._testSet(snapshot: snapshot, for: "main")

        let loaded = await SessionMenuPreviewLoader.load(sessionKey: "main", maxItems: 10)
        #expect(loaded.status == .empty)
        #expect(loaded.items.isEmpty)
    }
}
