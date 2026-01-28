#if DEBUG
import AppKit
import Foundation

extension CanvasWindowController {
    static func _testSanitizeSessionKey(_ key: String) -> String {
        self.sanitizeSessionKey(key)
    }

    static func _testJSStringLiteral(_ value: String) -> String {
        self.jsStringLiteral(value)
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

    static func _testParseIPv4(_ host: String) -> (UInt8, UInt8, UInt8, UInt8)? {
        CanvasA2UIActionMessageHandler.parseIPv4(host)
    }

    static func _testIsLocalNetworkIPv4(_ ip: (UInt8, UInt8, UInt8, UInt8)) -> Bool {
        CanvasA2UIActionMessageHandler.isLocalNetworkIPv4(ip)
    }

    static func _testIsLocalNetworkCanvasURL(_ url: URL) -> Bool {
        CanvasA2UIActionMessageHandler.isLocalNetworkCanvasURL(url)
    }
}
#endif
