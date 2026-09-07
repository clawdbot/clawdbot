public struct OpenClawChatDictationControl {
    public var isActive: Bool
    public var isAvailable: Bool
    public var start: @MainActor () async throws -> String?
    public var finish: @MainActor () -> Void
    public var cancel: @MainActor () -> Void

    public init(
        isActive: Bool,
        isAvailable: Bool,
        start: @escaping @MainActor () async throws -> String?,
        finish: @escaping @MainActor () -> Void,
        cancel: @escaping @MainActor () -> Void)
    {
        self.isActive = isActive
        self.isAvailable = isAvailable
        self.start = start
        self.finish = finish
        self.cancel = cancel
    }
}

extension OpenClawChatViewModel {
    func appendDictationTranscript(_ transcript: String, for session: SessionSnapshot) {
        guard self.isCurrentSession(session) else { return }
        if self.input.isEmpty {
            self.input = transcript
        } else {
            let separator = self.input.last?.isWhitespace == true ? "" : " "
            self.input += separator + transcript
        }
    }

    func setDictationError(_ error: Error, for session: SessionSnapshot) {
        guard self.isCurrentSession(session) else { return }
        self.errorText = error.localizedDescription
    }
}
