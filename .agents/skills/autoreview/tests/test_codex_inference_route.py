from __future__ import annotations

import argparse
import copy
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

try:
    import tomllib
except ModuleNotFoundError:
    import tomli as tomllib

from .test_autoreview_hardening import init_repo, load_helper, write_executable


class CodexInferenceRouteTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="autoreview-route-test.")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.repo = init_repo(self.root)
        self.home = self.root / "operator-home"
        self.home.mkdir()
        self.runtime_helper = write_executable(
            self.home / "credential-helper", "#!/bin/sh\nexit 99\n"
        )
        self.catalogue = self.home / "models.json"
        self.catalogue_bytes = json.dumps({
            "models": [{
                "slug": "gpt-5.6-sol", "context_window": 120000,
                "max_context_window": 120000, "auto_compact_token_limit": 90000,
                "display_name": "Synthetic model", "supported_reasoning_levels": [],
                "shell_type": "unified_exec", "visibility": "list",
                "supported_in_api": True, "priority": 0, "support_verbosity": False,
                "truncation_policy": {"mode": "tokens", "limit": 10000},
                "experimental_supported_tools": [],
                "model_messages": {"instructions_template": "synthetic instructions"},
            }],
        }).encode()
        self.catalogue.write_bytes(self.catalogue_bytes)
        self.config = {
            "model_provider": "review_api",
            "model_catalog_json": str(self.catalogue),
            "model_context_window": 120000,
            "model_auto_compact_token_limit": 90000,
            "model_auto_compact_token_limit_scope": "total",
            "cli_auth_credentials_store": "file",
        }
        self.provider = {
            "name": "Synthetic review API", "base_url": "https://api.openai.com/v1",
            "wire_api": "responses", "requires_openai_auth": False,
        }
        self.auth = {
            "command": str(self.runtime_helper), "timeout_ms": 5000,
            "refresh_interval_ms": 300000,
        }
        self.helper = load_helper()
        self.args = argparse.Namespace(
            engine="codex", codex_bin="synthetic-codex", codex_config=['model_provider="review_api"'], codex_speed=None,
            fallback_model=None, model="gpt-5.6-sol", stream_engine_output=False,
            thinking="high", tools=True, web_search=False,
        )
        self.environment = mock.patch.dict(os.environ, {
            "CODEX_HOME": str(self.home), "HOME": str(self.root),
            "AUTOREVIEW_CODEX_CONFIG": "", "AUTOREVIEW_CODEX_SPEED": "",
        })
        self.environment.start()
        self.addCleanup(self.environment.stop)

    def write_config(self):
        def value(item):
            if isinstance(item, dict):
                return "{" + ", ".join(f"{json.dumps(key)}={value(part)}" for key, part in item.items()) + "}"
            return json.dumps(item, ensure_ascii=False)

        def table(values):
            return "\n".join(f"{key} = {value(item)}" for key, item in values.items())

        text = table(self.config)
        text += "\n[model_providers.review_api]\n" + table(self.provider)
        text += "\n[model_providers.review_api.auth]\n" + table(self.auth)
        # These unrelated operator capabilities must never enter the review runtime.
        text += '\n[mcp_servers.unrelated]\ncommand = "must-not-execute"\n'
        (self.home / "config.toml").write_text(text, encoding="utf-8")

    def run_review(self, *, prepare_auth=None, during_run=None, scan=None):
        observed = {}

        def fake_run(command, cwd, **kwargs):
            observed["command"] = command
            observed["cwd"] = cwd
            observed["workspace"] = list(cwd.iterdir())
            observed["env"] = kwargs["env"]
            flags = [command[index + 1] for index, value in enumerate(command) if value == "-c"]
            observed["flags"] = dict(flag.split("=", 1) for flag in flags)
            catalogue = observed["flags"].get("model_catalog_json")
            if catalogue:
                file = Path(json.loads(catalogue))
                observed["catalogue"] = file.read_bytes()
                observed["catalogue_path"] = file
            if during_run:
                result = during_run(observed)
                if result is not None:
                    return result
            output = Path(command[command.index("--output-last-message") + 1])
            output.write_text('{"findings": []}')
            return subprocess.CompletedProcess(command, 0, "", "")

        replacements = {
            "ensure_codex_isolation_supported": mock.Mock(return_value="synthetic-codex"),
            "resolve_command": mock.Mock(return_value="synthetic-codex"),
            "run_with_heartbeat": fake_run,
            "scan_outgoing_review_pack": mock.Mock(),
        }
        if prepare_auth is not None:
            replacements["prepare_codex_runtime_auth"] = prepare_auth
        if scan is not None:
            replacements["scan_outgoing_review_pack"] = scan
        with mock.patch.dict(self.helper["run_codex"].__globals__, replacements):
            self.helper["run_codex"](self.args, self.repo, "synthetic review")
        return observed

    def test_trusted_route_reaches_client_without_workspace_or_config_capabilities(self):
        self.write_config()
        observed = self.run_review()
        flags = observed["flags"]
        self.assertEqual(flags.get("model_provider"), '"review_api"')
        self.assertEqual(flags.get("model_providers.review_api.base_url"), '"https://api.openai.com/v1"')
        self.assertEqual(flags.get("model_providers.review_api.auth.command"), json.dumps(str(self.runtime_helper.resolve())))
        self.assertEqual(flags.get("model_providers.review_api.auth.cwd"), json.dumps(str(self.home.resolve())))
        self.assertEqual(flags.get("model_providers.review_api.auth.timeout_ms"), "5000")
        self.assertEqual(flags.get("model_providers.review_api.auth.refresh_interval_ms"), "300000")
        self.assertEqual(flags.get("model_context_window"), "120000")
        self.assertEqual(flags.get("model_auto_compact_token_limit"), "90000")
        self.assertEqual(observed["catalogue"], self.catalogue_bytes)
        self.assertNotEqual(observed["catalogue_path"], self.catalogue)
        self.assertFalse(observed["catalogue_path"].is_relative_to(observed["cwd"]))
        self.assertEqual(observed["workspace"], [])
        self.assertIn("--ignore-user-config", observed["command"])
        self.assertIn("--ignore-rules", observed["command"])
        self.assertNotIn("mcp_servers.unrelated.command", flags)
        self.assertEqual(flags["features.hooks"], "false")
        self.assertEqual(flags["features.plugins"], "false")
        self.assertEqual(flags["default_permissions"], '"autoreview"')
        self.assertEqual(observed["command"][observed["command"].index("--model") + 1], self.args.model)
        self.assertEqual(observed["command"][observed["command"].index("--ask-for-approval") + 1], "never")
        self.assertFalse(observed["cwd"].exists())
        self.assertFalse(observed["catalogue_path"].exists())

    def available(self):
        replacements = {
            "find_command": mock.Mock(return_value="synthetic-codex"),
            "ENGINE_ISOLATION_PROBES": {"codex": mock.Mock()},
        }
        with (
            mock.patch.dict(self.helper["resolve_engine_binary"].__globals__, replacements),
            mock.patch("tempfile.TemporaryDirectory", side_effect=AssertionError("preflight must not create runtime state")),
            mock.patch("subprocess.run", side_effect=AssertionError("preflight must not execute credentials or reviewer")),
        ):
            return self.helper["resolve_engine_binary"](self.args, self.repo)

    def assert_route_refused(self):
        prepare_auth = mock.Mock()
        with self.assertRaisesRegex(SystemExit, "inference|Codex config") as caught:
            self.run_review(prepare_auth=prepare_auth)
        prepare_auth.assert_not_called()
        self.assertEqual(self.available(), (False, str(caught.exception.code)))

    def use_default_models(self):
        args = copy.copy(self.args)
        args.model, args.thinking, args.fallback_model = [], [], []
        with mock.patch.dict(self.helper["reviewer_args"].__globals__, {
            "env_defaults_for": lambda _: (None, {}),
        }):
            self.args = self.helper["reviewer_args"](args)[0]

    def test_primary_only_catalogue_keeps_normal_fallback_and_frozen_route(self):
        self.use_default_models()
        self.write_config()
        original = self.catalogue_bytes
        events = []

        def respond(observed):
            command = observed["command"]
            selected = command[command.index("--model") + 1]
            events.append(selected)
            self.assertEqual(observed["flags"].get("model_provider"), '"review_api"')
            self.assertEqual(observed["catalogue"], original)
            if selected == "gpt-5.6-sol":
                # A retry keeps the prepared route even if operator files change.
                self.catalogue.write_bytes(b"changed after primary send")
                (self.home / "config.toml").write_text('model_provider = "another-route"')
                return subprocess.CompletedProcess(
                    command, 1, "", "The model gpt-5.6-sol does not exist or you do not have access to it.",
                )

        self.run_review(during_run=respond, scan=lambda *_: events.append("scan"))
        self.assertEqual(events, ["gpt-5.6-sol", "scan", "gpt-5.6-terra"])

    def test_primary_only_catalogue_does_not_block_successful_primary(self):
        self.use_default_models()
        self.write_config()
        attempts = []
        self.run_review(during_run=lambda observed: attempts.append(observed["command"]))
        self.assertEqual(len(attempts), 1)
        self.assertEqual(attempts[0][attempts[0].index("--model") + 1], "gpt-5.6-sol")
        self.assertEqual(self.available(), (True, None))

    def test_default_keeps_legacy_auth_only_behavior_with_unrelated_routes(self):
        self.args.codex_config = []
        for provider in ("openai", "review_api", "unsupported-provider"):
            for without_parser in (False, True):
                with self.subTest(provider=provider, without_parser=without_parser):
                    self.config.update({
                        "model_provider": provider, "profile": "operator-profile",
                        "openai_base_url": "https://example.invalid/operator",
                        "forced_login_method": "api",
                    })
                    self.provider["base_url"] = "https://example.invalid/custom"
                    self.write_config()
                    modules = {"tomllib": None, "tomli": None} if without_parser else {}
                    with mock.patch.dict(sys.modules, modules):
                        observed = self.run_review()
                        self.assertEqual(observed["flags"]["cli_auth_credentials_store"], '"file"')
                        self.assertEqual(observed["flags"]["forced_login_method"], '"api"')
                        for key in (
                            "model_provider", "model_catalog_json", "model_context_window",
                            "model_auto_compact_token_limit", "model_auto_compact_token_limit_scope",
                            "profile", "openai_base_url", "model_providers.review_api.auth.command",
                        ):
                            self.assertNotIn(key, observed["flags"])
                        self.assertEqual(self.available(), (True, None))

    def test_tuning_override_alone_does_not_select_operator_route(self):
        self.args.codex_config = ["model_context_window=240000"]
        self.write_config()
        observed = self.run_review()
        self.assertEqual(observed["flags"]["model_context_window"], "240000")
        self.assertNotIn("model_provider", observed["flags"])
        self.assertNotIn("model_catalog_json", observed["flags"])
        self.assertEqual(self.available(), (True, None))

    def test_projection_requires_explicit_matching_provider_selector(self):
        self.write_config()
        for selector in ('review_api', '"review_api"', "'review_api'"):
            with self.subTest(selector=selector):
                self.args.codex_config = [f"model_provider = {selector}"]
                observed = self.run_review()
                provider_flags = [part for part in observed["command"] if part.startswith("model_provider=")]
                self.assertEqual(provider_flags, ['model_provider="review_api"'])
                self.assertEqual(observed["catalogue"], self.catalogue_bytes)
                self.assertEqual(self.available(), (True, None))

    def test_provider_selector_rejects_mismatch_and_nonliteral_values(self):
        self.write_config()
        for selector in (
            '"other"', '["review_api"]', '{id="review_api"}',
            '"review_api"\nfeatures.hooks=true', '"review_api" # comment',
            '"review\\u005fapi"', '""',
        ):
            with self.subTest(selector=selector):
                self.args.codex_config = [f"model_provider={selector}"]
                self.assert_route_refused()
        self.args.codex_config = ['model_provider="review_api"', 'model_provider="other"']
        self.assert_route_refused()
        self.args.codex_config = ['model_provider="review_api"']
        del self.config["model_provider"]
        self.write_config()
        self.assert_route_refused()

    def test_optional_route_fields_keep_native_defaults_when_omitted(self):
        context = ("model_context_window", "model_auto_compact_token_limit", "model_auto_compact_token_limit_scope")
        original_config, original_auth, original_provider = copy.deepcopy(self.config), copy.deepcopy(self.auth), copy.deepcopy(self.provider)
        for absent in (("timeout_ms", "refresh_interval_ms"), ("name", "wire_api", "requires_openai_auth"), context, (*context, "model_catalog_json", "timeout_ms", "refresh_interval_ms")):
            with self.subTest(absent=absent):
                self.config, self.auth, self.provider = copy.deepcopy(original_config), copy.deepcopy(original_auth), copy.deepcopy(original_provider)
                self.auth["args"] = []
                for key in absent:
                    self.config.pop(key, None)
                    self.auth.pop(key, None)
                    self.provider.pop(key, None)
                self.write_config()
                observed = self.run_review()
                self.assertEqual(observed["flags"]["model_provider"], '"review_api"')
                for key in absent:
                    flag = (f"model_providers.review_api.auth.{key}" if key in {"timeout_ms", "refresh_interval_ms"}
                            else f"model_providers.review_api.{key}" if key in {"name", "wire_api", "requires_openai_auth"}
                            else key)
                    self.assertNotIn(flag, observed["flags"])
                self.assertEqual(self.available(), (True, None))

    def test_conflicting_or_malformed_operator_route_refuses_in_run_and_preflight(self):
        original = copy.deepcopy(self.config)
        for config in (
            {**original, "profile": "another-route"},
            {**original, "openai_base_url": "https://example.invalid/v1"},
        ):
            with self.subTest(config=config):
                self.config = config
                self.write_config()
                self.assert_route_refused()
        for contents in (b"model_provider = [", b"\xff"):
            with self.subTest(contents=contents):
                (self.home / "config.toml").write_bytes(contents)
                self.assert_route_refused()

    def test_unsafe_route_descriptor_is_never_forwarded(self):
        provider = copy.deepcopy(self.provider)
        auth = copy.deepcopy(self.auth)
        cases = [
            ("provider", {**provider, "base_url": "https://example.invalid/v1"}),
            ("provider", {**provider, "http_headers": {"Authorization": "synthetic"}}),
            ("provider", {**provider, "requires_openai_auth": True}),
            ("provider", {**provider, "requires_openai_auth": "false"}),
            ("provider", {**provider, "wire_api": "chat"}),
            ("auth", {**auth, "command": "credential-helper"}),
            ("auth", {**auth, "args": ["synthetic-credential"]}),
            ("auth", {**auth, "cwd": str(self.repo)}),
            ("auth", {**auth, "cwd": "../repo"}),
            ("auth", {**auth, "timeout_ms": True}),
            ("auth", {**auth, "refresh_interval_ms": -1}),
        ]
        for target, values in cases:
            with self.subTest(target=target, values=values):
                self.provider, self.auth = copy.deepcopy(provider), copy.deepcopy(auth)
                setattr(self, target, values)
                self.write_config()
                self.assert_route_refused()

    def test_catalogue_preserves_native_metadata_and_context_semantics(self):
        document = json.loads(self.catalogue_bytes)
        model = document["models"][0]
        model["max_context_window"] = 240000
        del model["auto_compact_token_limit"]
        model["base_instructions"] = model.pop("model_messages")["instructions_template"]
        # Codex supports a larger maximum and legacy instruction metadata.
        # The helper must forward these bytes without applying another schema.
        self.catalogue_bytes = json.dumps(document, indent=2).encode() + b"\n"
        self.catalogue.write_bytes(self.catalogue_bytes)
        self.write_config()
        observed = self.run_review()
        self.assertEqual(observed["catalogue"], self.catalogue_bytes)
        self.assertEqual(observed["flags"]["model_context_window"], "120000")
        self.assertEqual(self.available(), (True, None))

    def test_catalogue_path_must_be_external(self):
        repo_catalogue = self.repo / "models.json"
        repo_catalogue.write_bytes(self.catalogue_bytes)
        self.config["model_catalog_json"] = str(repo_catalogue)
        self.write_config()
        self.assert_route_refused()

    def test_explicit_projection_requires_toml_parser(self):
        self.write_config()
        with mock.patch.dict(sys.modules, {"tomllib": None, "tomli": None}):
            self.assert_route_refused()

    def test_relative_catalogue_and_auth_cwd_use_the_operator_config_directory(self):
        working_dir = self.home / "credential files"
        working_dir.mkdir()
        self.config["model_catalog_json"] = "models.json"
        for cwd, expected in ((".", self.home), (working_dir.name, working_dir)):
            with self.subTest(cwd=cwd):
                self.auth["cwd"] = cwd
                self.write_config()
                observed = self.run_review()
                self.assertEqual(observed["flags"]["model_providers.review_api.auth.cwd"], json.dumps(str(expected.resolve())))
                self.assertEqual(observed["catalogue"], self.catalogue_bytes)
                self.assertEqual(self.available(), (True, None))
        repo_catalogue = self.repo / "models.json"
        repo_catalogue.write_bytes(self.catalogue_bytes)
        self.config["model_catalog_json"] = "../repo/models.json"
        self.write_config()
        self.assert_route_refused()

    def test_configured_executable_is_preserved_including_platform_wrapper(self):
        executable = write_executable(self.home / "credential tool", "#!/usr/bin/env python3\nraise SystemExit(99)\n")
        self.auth["command"] = str(executable)
        self.write_config()
        observed = self.run_review()
        self.assertEqual(observed["flags"]["model_providers.review_api.auth.command"], json.dumps(str(executable.resolve())))
        self.auth["command"] = executable.name
        self.write_config()
        self.assert_route_refused()

    def test_non_bmp_route_paths_round_trip_through_toml_overrides(self):
        executable = write_executable(self.home / "credential-🦞", "#!/bin/sh\nexit 99\n")
        working_dir = self.home / "working-🦞"
        working_dir.mkdir()
        self.auth.update(command=str(executable), cwd=str(working_dir))
        self.write_config()
        observed = self.run_review()

        runtime = self.root / "runtime-🦞"
        runtime.mkdir()
        catalogue_flags = self.helper["prepare_codex_inference_config"](
            ([], self.catalogue_bytes), runtime,
        )
        key, value = catalogue_flags[-1].split("=", 1)
        flags = {**observed["flags"], key: value}
        expected = {
            "model_providers.review_api.auth.command": executable,
            "model_providers.review_api.auth.cwd": working_dir,
            "model_catalog_json": runtime / "model-catalog.json",
        }
        for key, path in expected.items():
            with self.subTest(key=key):
                parsed = tomllib.loads(f"value = {flags[key]}")["value"]
                self.assertEqual(parsed, str(path.resolve()))
        self.assertEqual((runtime / "model-catalog.json").read_bytes(), self.catalogue_bytes)

    def test_repository_owned_route_files_refuse_before_authentication(self):
        for name in ("config.toml", "models.json", self.runtime_helper.name):
            with self.subTest(name=name):
                self.write_config()
                source = self.home / name
                original = source.read_bytes()
                repo_file = self.repo / name
                repo_file.write_bytes(original)
                repo_file.chmod(0o755)
                source.unlink()
                source.symlink_to(repo_file)
                try:
                    self.assert_route_refused()
                finally:
                    source.unlink()
                    source.write_bytes(original)
                    source.chmod(0o755)

        with mock.patch.dict(os.environ, {"CODEX_HOME": str(self.repo)}):
            self.assert_route_refused()

    def test_context_override_cannot_split_projected_route(self):
        self.args.codex_config.append("model_context_window=240000")
        self.write_config()
        self.assert_route_refused()

    def test_builtin_provider_collision_does_not_silently_change_route(self):
        for provider in ("openai", "ollama", "lmstudio", "amazon-bedrock", "amazon-bedrock-runtime"):
            with self.subTest(provider=provider):
                self.write_config()
                config = self.home / "config.toml"
                config.write_text(config.read_text().replace("review_api", provider))
                self.args.codex_config = [f'model_provider="{provider}"']
                self.assert_route_refused()

    def test_route_preserves_linked_auth_refresh_and_original_configuration(self):
        self.write_config()
        source_auth = self.home / "auth.json"
        source_auth.write_text('{"fixture": "before"}')
        config_before = (self.home / "config.toml").read_bytes()

        def refresh(observed):
            linked = Path(observed["env"]["CODEX_HOME"]) / "auth.json"
            self.assertTrue(os.path.samefile(linked, source_auth))
            linked.write_text('{"fixture": "refreshed"}')

        observed = self.run_review(during_run=refresh)
        self.assertEqual(observed["flags"].get("model_provider"), '"review_api"')
        self.assertEqual(json.loads(source_auth.read_text()), {"fixture": "refreshed"})
        self.assertEqual((self.home / "config.toml").read_bytes(), config_before)


if __name__ == "__main__":
    unittest.main()
