#if DEBUG
import AppKit
import Foundation

extension CanvasWindowController {
    static func _testStoredFrameKey(sessionKey: String) -> String {
        self.storedFrameDefaultsKey(sessionKey: sessionKey)
    }

    static func _testStoreAndLoadFrame(sessionKey: String, frame: NSRect) -> NSRect? {
        self.storeRestoredFrame(frame, sessionKey: sessionKey)
        return self.loadRestoredFrame(sessionKey: sessionKey)
    }
}
#endif
