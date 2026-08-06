#if DEBUG
import AppKit
import Foundation

extension CanvasWindowController {
    static func _testSanitizeSessionKey(_ key: String) -> String {
        self.sanitizeSessionKey(key)
    }

    static func _testJSOptionalStringLiteral(_ value: String?) -> String {
        self.jsOptionalStringLiteral(value)
    }

    static func _testStoredFrameKey(sessionKey: String) -> String {
        self.storedFrameDefaultsKey(sessionKey: sessionKey)
    }

    static func _testStoreAndLoadFrame(sessionKey: String, frame: NSRect) -> NSRect? {
        self.storeRestoredFrame(frame, sessionKey: sessionKey)
        return self.loadRestoredFrame(sessionKey: sessionKey)
    }
}
#endif
