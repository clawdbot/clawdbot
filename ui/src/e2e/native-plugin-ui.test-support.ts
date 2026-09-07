export const pluginId = "ui-fixture";

export function catalog(revision: string) {
  return {
    revision,
    diagnostics: [],
    plugins: [
      {
        pluginId,
        name: "UI fixture",
        revision,
        entryUrl: `/__openclaw__/plugins/control-ui/${pluginId}/${revision}/index.js`,
        styles: [],
      },
    ],
  };
}

export function pluginModule(revision: string, replacements = true) {
  return `export default {
    id: "ui-fixture",
    async activate(host) {
      const proof = globalThis.nativePluginProof ??= {};
      const previous = proof.host;
      if (${JSON.stringify(revision)} === "broken") throw new Error("Fixture activation failed");
      if (${JSON.stringify(revision)} === "pending") {
        await host.request("fixture.activationStarted");
        await new Promise(resolve => { proof.release = resolve; });
        await host.request("fixture.staleInitializer");
      }
      proof.host = host;
      host.ui.registerPage({id:"proof", label:"UI fixture", mount(container, context) {
        const title = document.createElement("h1"); title.textContent = "Fixture revision ${revision}";
        const output = document.createElement("output"); output.setAttribute("aria-label", "Fixture outcome");
        const button = (label, action) => { const element = document.createElement("button"); element.textContent = label; element.onclick = async () => { try { await action(); output.textContent = "completed"; } catch(error) { output.textContent = error.message; } }; return element; };
        container.append(title, output,
          button("Call current activation", () => context.host.request("fixture.current")),
          button("Unregister composer", () => unregisterComposer()),
          button("Register composer", () => { unregisterComposer = registerComposer(); }),
          button("Unregister retired composer", () => firstUnregisterComposer()),
          button("Call retired composer", () => proof.composer.setDraft("retired draft")),
          button("Call previous activation", () => previous.request("fixture.stale")),
          button("Release pending initializer", () => { proof.release(); throw new Error("released"); }));
      }});
      host.ui.registerNavigation({id:"proof", label:"UI fixture", page:{id:"proof"}});
      host.ui.registerAccessory({id:"session", placement:"session-header", mount(container, context) {
        const output = document.createElement("output"); output.dataset.fixtureSessionAccessory = "";
        const update = next => { output.textContent = next.props.sessionKey; output.dataset.presented = String(next.presented); output.hidden = !next.presented; };
        container.append(output); update(context);
        return { update };
      }});
      host.ui.registerWidget({id:"card", label:"Fixture widget", mount(container) {
        const content = document.createElement("p"); content.textContent = "Fixture widget ${revision}";
        container.append(content);
      }});
      if (!${replacements}) return;
      const composer = {id:"composer", label:"Fixture composer", surface:"composer", mount(container, context) {
        let current = context;
        proof.composer = context.props;
        const input = document.createElement("textarea"); input.setAttribute("aria-label", "Fixture draft"); input.value = current.props.draft;
        input.oninput = () => current.props.setDraft(input.value);
        const send = document.createElement("button"); send.textContent = "Fixture send";
        const output = document.createElement("output"); output.setAttribute("aria-label", "Send outcome");
        send.onclick = async () => { try { const result = await current.props.send(); output.textContent = result === true ? "accepted" : result === false ? "rejected" : "completed"; } catch(error) { output.textContent = error.message; } };
        container.append(input, send, output);
        return { update(next) { current = next; input.value = next.props.draft; }, focus() { input.focus(); } };
      }};
      const registerComposer = () => host.ui.registerReplacement(composer);
      let unregisterComposer = registerComposer();
      const firstUnregisterComposer = unregisterComposer;
      host.ui.registerReplacement({id:"delegated-composer", label:"Delegated composer", surface:"composer", mount(container, context) {
        return {dispose: context.mountDefault(container)};
      }});
      host.ui.registerReplacement({id:"failing-composer", label:"Failing composer", surface:"composer", mount() { throw new Error("Fixture composer failed"); }});
      host.ui.registerReplacement({id:"workspace", label:"Fixture workspace", surface:"workspace", mount(container, context) {
        const title = document.createElement("h1"); title.textContent = "Custom workspace";
        const recover = document.createElement("button"); recover.textContent = "Show built-in workspace";
        recover.onclick = () => context.host.ui.selectReplacement("workspace", null);
        container.append(title, recover);
      }});
      host.ui.registerReplacement({id:"default-workspace", label:"Default-backed workspace", surface:"workspace", mount(container, context) {
        return {dispose: context.mountDefault(container)};
      }});
      host.ui.registerReplacement({id:"failing-transcript", label:"Failing transcript", surface:"transcript", mount() { throw new Error("Fixture transcript failed"); }});
      if (["withdrawn", "invalid-selection"].includes(${JSON.stringify(revision)})) {
        if (${JSON.stringify(revision)} === "invalid-selection") {
          host.ui.selectReplacement("workspace", "workspace");
        }
        const replacement = {id:"staged-composer", label:"Staged composer", surface:"composer", mount() {}};
        const withdraw = host.ui.registerReplacement(replacement);
        host.ui.selectReplacement("composer", replacement.id);
        if (${JSON.stringify(revision)} === "withdrawn") withdraw();
        else replacement.surface = "transcript";
      }
      return () => { proof.disposed = (proof.disposed ?? 0) + 1; };
    }
  };`;
}
