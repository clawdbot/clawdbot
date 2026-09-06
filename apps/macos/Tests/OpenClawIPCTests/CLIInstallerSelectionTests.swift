import Foundation
import Testing
@testable import OpenClaw

@Suite(.serialized)
@MainActor
struct CLIInstallerSelectionTests {
    @Test func `managed inspection preserves the external CLI selected by discovery`() async throws {
        try await self.withCLIInstallations { external, managed in
            let selected = await CLIInstaller.status()
            #expect(selected == .ready(location: external.path, version: "2026.9.2"))

            // Startup performs discovery followed by managed inspection before deciding ownership.
            let inspected = await CLIInstaller.managedStatus()
            #expect(inspected == .ready(location: managed.path, version: "2026.9.1"))
            #expect(AppDefaults.standard.string(forKey: cliValidatedExecutableKey) == external.path)
            #expect(AppDefaults.standard.string(forKey: cliValidatedVersionKey) == "2026.9.2")
            #expect(CommandResolver.openclawExecutable() == external.path)
        }
    }

    @Test func `managed inspection does not select a CLI when no selection exists`() async throws {
        try await self.withCLIInstallations { _, managed in
            AppDefaults.standard.removeObject(forKey: cliValidatedExecutableKey)
            AppDefaults.standard.removeObject(forKey: cliValidatedVersionKey)

            #expect(await CLIInstaller.managedStatus() == .ready(location: managed.path, version: "2026.9.1"))
            #expect(AppDefaults.standard.string(forKey: cliValidatedExecutableKey) == nil)
            #expect(AppDefaults.standard.string(forKey: cliValidatedVersionKey) == nil)
        }
    }

    @Test(arguments: [true, false])
    func `managed update selects its CLI only after successful verification`(_ succeeds: Bool) async throws {
        try await self.withCLIInstallations { external, managed in
            let targetVersion = succeeds ? "2026.9.1" : "2026.9.2"
            let outcome = await CLIInstaller.updateManaged(
                targetVersion: targetVersion,
                restartGateway: false,
                statusHandler: { _ in })

            if succeeds {
                #expect(outcome == .success(fromVersion: "2026.8.1", toVersion: "2026.9.1"))
                #expect(AppDefaults.standard.string(forKey: cliValidatedExecutableKey) == managed.path)
                #expect(AppDefaults.standard.string(forKey: cliValidatedVersionKey) == "2026.9.1")
                #expect(CommandResolver.openclawExecutable() == managed.path)
            } else {
                guard case .failure = outcome else {
                    Issue.record("An updater success response must not override failed version verification")
                    return
                }
                #expect(AppDefaults.standard.string(forKey: cliValidatedExecutableKey) == external.path)
                #expect(AppDefaults.standard.string(forKey: cliValidatedVersionKey) == "2026.9.2")
            }
        }
    }

    private func withCLIInstallations(
        _ body: (URL, URL) async throws -> Void) async throws
    {
        let root = try makeTempDirForTests().resolvingSymlinksInPath()
        defer { try? FileManager.default.removeItem(at: root) }
        let external = root.appendingPathComponent("external/bin/openclaw")
        try await TestIsolation.withIsolatedState(
            env: ["CFFIXED_USER_HOME": root.path],
            defaults: [
                cliValidatedExecutableKey: external.path,
                cliValidatedVersionKey: "2026.9.2",
                cliInstallPolicyKey: nil,
                "openclaw.gatewayProjectRootPath": root.path,
            ])
        {
            // The native CI launcher owns OS isolation; never write an operator's managed tree.
            try #require(FileManager().homeDirectoryForCurrentUser.resolvingSymlinksInPath() == root)
            let managed = URL(fileURLWithPath: CLIInstaller.managedExecutableLocation())
            try #require(managed.path.hasPrefix(root.path + "/"))
            for (executable, version) in [(external, "2026.9.2"), (managed, "2026.9.1")] {
                try makeExecutableForTests(at: executable)
                try """
                #!/bin/sh
                if [ "$1" = "--version" ]; then
                  printf 'OpenClaw \(version)\\n'
                else
                  printf '{"status":"ok","before":{"version":"2026.8.1"}}\\n'
                fi

                """.write(to: executable, atomically: false, encoding: .utf8)
                let node = executable.deletingLastPathComponent().appendingPathComponent("node")
                try makeExecutableForTests(at: node)
                try "#!/bin/sh\nprintf 'v24.15.0\\n'\n".write(to: node, atomically: false, encoding: .utf8)
            }
            try await body(external, managed)
        }
    }
}
