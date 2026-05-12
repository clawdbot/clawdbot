extension WakeParams {
    public init(
        mode: AnyCodable,
        text: String)
    {
        self.init(mode: mode, text: text, sessionkey: nil)
    }
}
