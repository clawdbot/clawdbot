// Advertised core method order from 8d94ab0d1e258fd0f148263fc3f75e17b4628adf.
// Keep this prefix frozen; new RPCs append without moving existing client indices.
export const LEGACY_ADVERTISED_GATEWAY_METHODS = `
health diagnostics.stability doctor.memory.status doctor.memory.dreamDiary
doctor.memory.backfillDreamDiary doctor.memory.resetDreamDiary
doctor.memory.resetGroundedShortTerm doctor.memory.repairDreamingArtifacts
doctor.memory.dedupeDreamDiary logs.tail channels.status channels.start channels.stop
channels.logout status usage.status usage.cost tts.status tts.providers tts.personas tts.enable
tts.disable tts.convert tts.setProvider tts.setPersona config.get config.set config.apply
config.patch config.schema config.schema.lookup exec.approvals.get exec.approvals.set
exec.approvals.node.get exec.approvals.node.set exec.approval.get exec.approval.list
exec.approval.request exec.approval.waitDecision exec.approval.resolve exec.approval.grants.list
exec.approval.grants.revoke question.request question.waitAnswer question.resolve question.get
question.list plugin.approval.list plugin.approval.request plugin.approval.waitDecision
plugin.approval.resolve plugins.uiDescriptors plugins.sessionAction openclaw.chat
openclaw.chat.history openclaw.changes.list openclaw.approval.list openclaw.setup.detect
openclaw.setup.activate openclaw.setup.activate.start openclaw.setup.auth.start
openclaw.setup.prepare.start wizard.start wizard.next wizard.cancel wizard.status talk.catalog
talk.config talk.client.create talk.client.transcript talk.client.close talk.client.toolCall
talk.client.steer talk.session.create talk.session.appendAudio talk.session.cancelOutput
talk.session.acknowledgeMark talk.session.submitToolResult talk.session.steer talk.session.close
talk.speak talk.mode commands.list models.list models.authStatus models.authLogout tools.catalog
tools.effective tools.invoke mcp.app.view mcp.app.listTools mcp.app.listResources
mcp.app.listResourceTemplates mcp.app.readResource mcp.app.callTool mcp.app.updateModelContext
board.get board.update board.widget.put board.widget.grant board.widget.appView board.event
audit.list audit.activity.list users.list users.self users.linkEmail users.setDisplayName
users.setAvatar users.setRole users.listAuthLinks users.listModelAccounts users.selectModelAccount
users.linkAuthProfile users.unlinkAuthProfile users.authConnect.start users.authConnect.answer
users.authConnect.status users.authConnect.cancel users.authConnect.catalog
tasks.list tasks.get tasks.cancel taskSuggestions.list
taskSuggestions.create taskSuggestions.accept taskSuggestions.dismiss environments.list
environments.status worktrees.list worktrees.branches fs.listDir worktrees.create
worktrees.remove worktrees.restore worktrees.gc agents.list agents.create agents.update
agents.delete agents.files.list agents.files.get agents.files.set sessions.files.list
sessions.files.get sessions.files.set sessions.files.reveal artifacts.list artifacts.get
artifacts.download skills.status skills.library.list skills.library.read skills.library.save
skills.library.mutate skills.library.activate skills.library.import skills.library.upload
skills.search skills.detail skills.securityVerdicts
skills.skillCard skills.bins skills.upload.begin skills.upload.chunk skills.upload.commit
skills.install skills.update skills.curator.status skills.curator.pin skills.curator.unpin
skills.curator.restore skills.proposals.list skills.proposals.inspect
skills.proposals.historyStatus skills.proposals.historyScan skills.proposals.create
skills.proposals.update skills.proposals.revise skills.proposals.requestRevision
skills.proposals.apply skills.proposals.reject skills.proposals.quarantine update.status
update.run voicewake.get voicewake.set secrets.reload secrets.resolve voicewake.routing.get
sessions.list sessions.subscribe sessions.messages.subscribe sessions.messages.unsubscribe
sessions.viewers.set sessions.preview sessions.describe sessions.compaction.list
sessions.compaction.branch sessions.compaction.restore sessions.branches.list
sessions.branches.switch sessions.rewind sessions.fork sessions.create sessions.recover
sessions.send sessions.abort sessions.patch sessions.goal.update sessions.goal.clear
sessions.pluginPatch sessions.cleanup sessions.reset sessions.delete sessions.compact
sessions.groups.list sessions.groups.defaults sessions.groups.put sessions.groups.rename
sessions.groups.update sessions.groups.delete last-heartbeat set-heartbeats wake node.pair.list
node.pair.approve node.pair.reject node.pair.remove device.pair.list device.pair.approve
device.pair.reject device.pair.remove device.pair.rename device.token.rotate device.token.revoke
node.rename node.list node.describe node.pluginSurface.refresh node.pluginTools.update
node.skills.update node.pending.drain node.pending.enqueue node.invoke node.pending.pull
node.pending.ack node.invoke.progress node.invoke.result node.event cron.get cron.list
cron.status cron.scratch.get cron.scratch.set cron.add cron.update cron.remove cron.run
cron.runs gateway.identity.get gateway.restart.preflight gateway.restart.request system-presence
system-event message.action conversations.send conversations.turn conversations.turn.cancel send
agent agent.identity.get agent.wait chat.history chat.startup chat.metadata chat.message.get
chat.abort chat.send terminal.open terminal.input terminal.resize terminal.close
channels.pairing.list channels.pairing.approve channels.pairing.dismiss attach.grant
attach.revoke push.web.preferences.get push.web.preferences.set terminal.attach terminal.list
controlUi.githubPreview system.info agents.workspace.list agents.workspace.get tts.speak
plugins.list plugins.search plugins.install plugins.setEnabled plugins.uninstall plugins.refresh
controlUi.sessionPullRequests.subscribe controlUi.sessionPreview gateway.suspend.prepare
gateway.suspend.status gateway.suspend.resume chat.toolTitles sessions.diff
openclaw.setup.verify environments.create environments.destroy sessions.catalog.list
sessions.catalog.read terminal.upload sessions.catalog.continue sessions.catalog.archive
approval.get approval.resolve sessions.search sessions.dispatch sessions.reclaim models.probe
migrations.memory.plan migrations.memory.apply ui.command approval.history
plugin.surface.refresh conversations.list session.discussion.info session.discussion.open
board.prompt.authorize board.data.read board.action sessions.observer.visibility
session.visibility.set session.members.list session.members.add session.members.remove
session.suggestions.add session.suggestions.list session.suggestions.resolve session.typing
sessions.companion.ask sessions.companion.state sessions.companion.reset memory.search
skills.proposals.events.list skills.proposals.evaluate hooks.status tasks.retry tasks.dismiss
audit.run.inspect sessions.patchMany update.hold sessions.catalog.startTerminal
worker.desktop.observe projects.list projects.register projects.remove worker.desktop.launch
secrets.store.list secrets.store.set secrets.store.delete users.prefs.get users.prefs.set
projects.add projects.searchRemote desktop.observe desktop.launch device.scopes.requestUpgrade
device.scopes.waitUpgrade portal.list portal.open portal.close sessions.move
sessions.assignOwner progressCard.get progressCard.put tools.github.status
tools.github.configure tools.github.authorize.start tools.github.authorize.poll
tools.github.authorize.cancel sessions.github.publish diagnostics.lanes
session.members.listEvidence plugins.inspect users.github.status users.github.authorize.start
users.github.authorize.poll users.github.authorize.cancel users.github.disconnect
sessions.github.options sessions.github.status sessions.github.confirm sessions.title.prepare
users.mentionable mentions.list mentions.dismiss transcripts.list transcripts.get models.authOrderSet
canvas.document.view
`
  .trim()
  .split(/\s+/u);
