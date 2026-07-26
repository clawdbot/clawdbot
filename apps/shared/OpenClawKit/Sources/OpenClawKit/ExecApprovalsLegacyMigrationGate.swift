import Foundation

enum ExecApprovalsLegacyMigrationGate {
    private static let doctorClaimSuffix = ".doctor-importing"

    static func assertReady(stateDirectoryURL: URL) throws {
        try self.assertReady(
            stateDirectoryURL: stateDirectoryURL,
            pathMayExist: self.pathMayExist)
    }

    static func assertReady(
        stateDirectoryURL: URL,
        pathMayExist: (URL) -> Bool) throws
    {
        let sourceURL = stateDirectoryURL.appendingPathComponent(
            "exec-approvals.json",
            isDirectory: false)
        let claimURL = URL(fileURLWithPath: sourceURL.path + self.doctorClaimSuffix)
        // Probe source on both sides of the claim so neither Doctor's source -> claim
        // rename nor its claim -> source recovery can pass through an absent window.
        guard !pathMayExist(sourceURL),
              !pathMayExist(claimURL),
              !pathMayExist(sourceURL)
        else {
            throw NSError(
                domain: "ai.openclaw.exec-approvals-store",
                code: 1,
                userInfo: [
                    NSLocalizedDescriptionKey:
                        "Legacy exec approvals exist at \(sourceURL.path). " +
                        "Run `openclaw doctor --fix` before using exec approvals.",
                ])
        }
    }

    private static func pathMayExist(_ url: URL) -> Bool {
        let fileManager = FileManager.default
        return fileManager.fileExists(atPath: url.path)
            || (try? fileManager.destinationOfSymbolicLink(atPath: url.path)) != nil
    }
}
