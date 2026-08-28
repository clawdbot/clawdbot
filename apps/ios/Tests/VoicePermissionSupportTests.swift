import Speech
import Testing
@testable import OpenClaw

struct VoicePermissionSupportTests {
    @Test func `speech permission messages preserve authorization detail`() {
        let kind = "Speech recognition"
        let cases: [(SFSpeechRecognizerAuthorizationStatus, String)] = [
            (.denied, "Speech recognition permission denied"),
            (.restricted, "Speech recognition permission restricted"),
            (.notDetermined, "Speech recognition permission not granted"),
            (.authorized, "Speech recognition permission denied"),
        ]

        for (status, expected) in cases {
            #expect(VoicePermissionSupport.speechPermissionMessage(kind: kind, status: status) == expected)
        }
    }
}
