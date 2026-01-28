import Foundation

extension OnboardingView {
    func loadWorkspaceDefaults() async {
        guard self.workspacePath.isEmpty else { return }
        let configured = await self.loadAgentWorkspace()
        let url = AgentWorkspace.resolveWorkspaceURL(from: configured)
        self.workspacePath = AgentWorkspace.displayPath(for: url)
        self.refreshBootstrapStatus()
    }

    func ensureDefaultWorkspace() async {
        guard self.state.connectionMode == .local else { return }
        let configured = await self.loadAgentWorkspace()
        let url = AgentWorkspace.resolveWorkspaceURL(from: configured)
        switch AgentWorkspace.bootstrapSafety(for: url) {
        case .safe:
            do {
                _ = try AgentWorkspace.bootstrap(workspaceURL: url)
                if (configured ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    await self.saveAgentWorkspace(AgentWorkspace.displayPath(for: url))
                }
            } catch {
                self.workspaceStatus = "Failed to create workspace: \(error.localizedDescription)"
            }
        case let .unsafe(reason):
            self.workspaceStatus = "Workspace not touched: \(reason)"
        }
        self.refreshBootstrapStatus()
    }

    func refreshBootstrapStatus() {
        let url = AgentWorkspace.resolveWorkspaceURL(from: self.workspacePath)
        self.needsBootstrap = AgentWorkspace.needsBootstrap(workspaceURL: url)
        if self.needsBootstrap {
            self.didAutoKickoff = false
        }
    }

    var workspaceBootstrapCommand: String {
        let template = AgentWorkspace.defaultTemplate().trimmingCharacters(in: .whitespacesAndNewlines)
        return """
        mkdir -p ~/.clawdbot/workspace
        cat > ~/.clawdbot/workspace/AGENTS.md <<'EOF'
        \(template)
        EOF
        """
    }

    func applyWorkspace() async {
        guard !self.workspaceApplying else { return }
        self.workspaceApplying = true
        defer { self.workspaceApplying = false }

        do {
            let url = AgentWorkspace.resolveWorkspaceURL(from: self.workspacePath)
            if case let .unsafe(reason) = AgentWorkspace.bootstrapSafety(for: url) {
                self.workspaceStatus = "Workspace not created: \(reason)"
                return
            }
            _ = try AgentWorkspace.bootstrap(workspaceURL: url)
            self.workspacePath = AgentWorkspace.displayPath(for: url)
            self.workspaceStatus = "Workspace ready at \(self.workspacePath)"
            self.refreshBootstrapStatus()
        } catch {
            self.workspaceStatus = "Failed to create workspace: \(error.localizedDescription)"
        }
    }

    private func loadAgentWorkspace() async -> String? {
        let root = await ConfigStore.load()
        let agents = root["agents"] as? [String: Any]
        let defaults = agents?["defaults"] as? [String: Any]
        return defaults?["workspace"] as? String
    }

    @discardableResult
    func saveAgentWorkspace(_ workspace: String?) async -> Bool {
        let (success, errorMessage) = await OnboardingView.buildAndSaveWorkspace(workspace)

        if let errorMessage {
            self.workspaceStatus = errorMessage
        }
        return success
    }

    @MainActor
    private static func buildAndSaveWorkspace(_ workspace: String?) async -> (Bool, String?) {
        var root = await ConfigStore.load()
        var agents = root["agents"] as? [String: Any] ?? [:]
        var defaults = agents["defaults"] as? [String: Any] ?? [:]
        let trimmed = workspace?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if trimmed.isEmpty {
            defaults.removeValue(forKey: "workspace")
        } else {
            defaults["workspace"] = trimmed
        }
        if defaults.isEmpty {
            agents.removeValue(forKey: "defaults")
        } else {
            agents["defaults"] = defaults
        }
        if agents.isEmpty {
            root.removeValue(forKey: "agents")
        } else {
            root["agents"] = agents
        }
        do {
            try await ConfigStore.save(root)
            return (true, nil)
        } catch {
            let errorMessage = "Failed to save config: \(error.localizedDescription)"
            return (false, errorMessage)
        }
    }
}
