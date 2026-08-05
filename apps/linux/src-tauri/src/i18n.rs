use std::collections::HashMap;
use std::sync::OnceLock;

type Messages = HashMap<String, String>;
type Catalogs = HashMap<String, Messages>;

static CATALOGS: OnceLock<Catalogs> = OnceLock::new();
static LOCALE: OnceLock<String> = OnceLock::new();

fn catalogs() -> &'static Catalogs {
    CATALOGS.get_or_init(|| {
        serde_json::from_str(include_str!("../../ui/locales.json"))
            .expect("bundled desktop localization catalog must contain valid JSON")
    })
}

fn locale() -> &'static str {
    LOCALE
        .get_or_init(|| {
            let environment = ["LC_ALL", "LC_MESSAGES", "LANGUAGE", "LANG"]
                .into_iter()
                .filter_map(|name| std::env::var(name).ok())
                .flat_map(|value| {
                    value
                        .split(':')
                        .map(str::trim)
                        .filter(|candidate| !candidate.is_empty())
                        .map(str::to_owned)
                        .collect::<Vec<_>>()
                })
                .collect::<Vec<_>>();
            select_locale(catalogs(), &environment, preferred_system_locales)
        })
        .as_str()
}

fn select_locale(
    catalogs: &Catalogs,
    environment: &[String],
    system_locales: impl FnOnce() -> Vec<String>,
) -> String {
    environment
        .iter()
        .find_map(|candidate| resolve_locale(catalogs, candidate).map(str::to_owned))
        .or_else(|| {
            system_locales()
                .into_iter()
                .find_map(|candidate| resolve_locale(catalogs, &candidate).map(str::to_owned))
        })
        .unwrap_or_else(|| "en".to_owned())
}

#[cfg(target_os = "macos")]
fn preferred_system_locales() -> Vec<String> {
    ["AppleLanguages", "AppleLocale"]
        .into_iter()
        .flat_map(|preference| {
            std::process::Command::new("/usr/bin/defaults")
                .args(["read", "-g", preference])
                .output()
                .ok()
                .filter(|output| output.status.success())
                .and_then(|output| String::from_utf8(output.stdout).ok())
                .map(|output| parse_macos_locales(&output))
                .unwrap_or_default()
        })
        .collect()
}

#[cfg(any(target_os = "macos", test))]
fn parse_macos_locales(output: &str) -> Vec<String> {
    output
        .lines()
        .map(str::trim)
        .map(|line| line.trim_end_matches(',').trim().trim_matches('"'))
        .filter(|candidate| !normalize_locale(candidate).is_empty())
        .map(str::to_owned)
        .collect()
}

#[cfg(target_os = "windows")]
fn preferred_system_locales() -> Vec<String> {
    const MUI_LANGUAGE_NAME: u32 = 0x8;
    const MAX_UI_LANGUAGE_UNITS: usize = 512;

    #[link(name = "kernel32")]
    extern "system" {
        fn GetUserPreferredUILanguages(
            flags: u32,
            language_count: *mut u32,
            languages: *mut u16,
            language_buffer_length: *mut u32,
        ) -> i32;
    }

    let mut languages = [0_u16; MAX_UI_LANGUAGE_UNITS];
    let mut language_count = 0_u32;
    let mut language_buffer_length = MAX_UI_LANGUAGE_UNITS as u32;
    // The buffer stays live and its declared length matches its actual capacity.
    let succeeded = unsafe {
        GetUserPreferredUILanguages(
            MUI_LANGUAGE_NAME,
            &mut language_count,
            languages.as_mut_ptr(),
            &mut language_buffer_length,
        )
    };
    if succeeded == 0 {
        return Vec::new();
    }
    let Some(buffer) = usize::try_from(language_buffer_length)
        .ok()
        .and_then(|length| languages.get(..length))
    else {
        return Vec::new();
    };

    buffer
        .split(|unit| *unit == 0)
        .filter(|language| !language.is_empty())
        .filter_map(|language| String::from_utf16(language).ok())
        .collect()
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn preferred_system_locales() -> Vec<String> {
    Vec::new()
}

fn normalize_locale(value: &str) -> String {
    let value = value.split(['.', '@']).next().unwrap_or_default().trim();
    if value.is_empty()
        || value
            .chars()
            .any(|character| !character.is_ascii_alphanumeric() && !matches!(character, '-' | '_'))
    {
        return String::new();
    }
    if value.eq_ignore_ascii_case("C") || value.eq_ignore_ascii_case("POSIX") {
        return "en".to_owned();
    }

    value
        .split(['-', '_'])
        .enumerate()
        .filter(|(_, part)| !part.is_empty())
        .map(|(index, part)| match (index, part.len()) {
            (0, _) => part.to_ascii_lowercase(),
            (_, 2) => part.to_ascii_uppercase(),
            (_, 4) => {
                let mut letters = part.chars();
                letters
                    .next()
                    .map(|first| {
                        first.to_ascii_uppercase().to_string()
                            + &letters.as_str().to_ascii_lowercase()
                    })
                    .unwrap_or_default()
            }
            _ => part.to_ascii_lowercase(),
        })
        .collect::<Vec<_>>()
        .join("-")
}

fn resolve_locale<'a>(catalogs: &'a Catalogs, requested: &str) -> Option<&'a str> {
    let normalized = normalize_locale(requested);
    if let Some((locale, _)) = catalogs.get_key_value(&normalized) {
        return Some(locale.as_str());
    }

    let language = normalized.split('-').next().unwrap_or("en");
    if language == "zh" {
        let traditional = normalized.split('-').any(|part| {
            part.eq_ignore_ascii_case("Hant")
                || matches!(part.to_ascii_uppercase().as_str(), "TW" | "HK" | "MO")
        });
        let chinese_locale = if traditional { "zh-TW" } else { "zh-CN" };
        if let Some((locale, _)) = catalogs.get_key_value(chinese_locale) {
            return Some(locale.as_str());
        }
    }

    if let Some((locale, _)) = catalogs.get_key_value(language) {
        return Some(locale.as_str());
    }

    let prefix = format!("{language}-");
    catalogs
        .keys()
        .filter(|locale| locale.starts_with(&prefix))
        .min()
        .map(String::as_str)
}

fn lookup<'a>(catalogs: &'a Catalogs, locale: &str, key: &str) -> Option<&'a str> {
    resolve_locale(catalogs, locale)
        .and_then(|resolved| catalogs.get(resolved))
        .and_then(|messages| messages.get(key))
        .or_else(|| catalogs.get("en").and_then(|messages| messages.get(key)))
        .map(String::as_str)
}

fn translate_for_locale(
    catalogs: &Catalogs,
    locale: &str,
    key: &str,
    arguments: &[(&str, &str)],
) -> String {
    let mut message = lookup(catalogs, locale, key).unwrap_or(key).to_owned();
    for (name, value) in arguments {
        message = message.replace(&format!("{{{name}}}"), value);
    }
    message
}

pub fn text(key: &str) -> String {
    translate_for_locale(catalogs(), locale(), key, &[])
}

pub fn format(key: &str, arguments: &[(&str, &str)]) -> String {
    translate_for_locale(catalogs(), locale(), key, arguments)
}

fn plural_category(locale: &str, count: usize) -> &'static str {
    match locale.split('-').next().unwrap_or(locale) {
        "ar" => match (count, count % 100) {
            (0, _) => "zero",
            (1, _) => "one",
            (2, _) => "two",
            (_, 3..=10) => "few",
            (_, 11..=99) => "many",
            _ => "other",
        },
        "ru" | "uk" => match (count % 10, count % 100) {
            (1, 11) => "many",
            (1, _) => "one",
            (2..=4, 12..=14) => "many",
            (2..=4, _) => "few",
            _ => "many",
        },
        "pl" => match (count, count % 10, count % 100) {
            (1, _, _) => "one",
            (_, 2..=4, 12..=14) => "many",
            (_, 2..=4, _) => "few",
            _ => "many",
        },
        "fr" | "pt" if count <= 1 => "one",
        _ if count == 1 => "one",
        _ => "other",
    }
}

fn plural_for_locale(
    catalogs: &Catalogs,
    locale: &str,
    prefix: &str,
    count: usize,
    arguments: &[(&str, &str)],
) -> String {
    let category = plural_category(locale, count);
    let candidate = format!("{prefix}.{category}");
    let other = format!("{prefix}.other");
    let localized = resolve_locale(catalogs, locale).and_then(|resolved| catalogs.get(resolved));
    let english = catalogs.get("en");
    let key = if localized.is_some_and(|messages| messages.contains_key(&candidate)) {
        candidate
    } else if localized.is_some_and(|messages| messages.contains_key(&other)) {
        other
    } else if english.is_some_and(|messages| messages.contains_key(&candidate)) {
        candidate
    } else {
        other
    };
    translate_for_locale(catalogs, locale, &key, arguments)
}

pub fn plural(prefix: &str, count: usize, arguments: &[(&str, &str)]) -> String {
    plural_for_locale(catalogs(), locale(), prefix, count, arguments)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> Catalogs {
        serde_json::from_str(
            r#"{
                "en": {"greeting": "Hello, {name}!", "onlyEnglish": "Fallback"},
                "ar": {"greeting": "مرحبًا، {name}!"},
                "de": {"greeting": "Hallo, {name}!"},
                "fa": {"greeting": "سلام، {name}!"},
                "pt-BR": {"greeting": "Olá, {name}!"},
                "zh-CN": {"greeting": "你好，{name}！"},
                "zh-TW": {"greeting": "你好，{name}！"}
            }"#,
        )
        .expect("test localization catalog is valid")
    }

    #[test]
    fn normalizes_posix_and_bcp47_locale_spellings() {
        assert_eq!(normalize_locale("de_DE.UTF-8"), "de-DE");
        assert_eq!(normalize_locale("pt_br@latin"), "pt-BR");
        assert_eq!(normalize_locale("zh_hant_tw"), "zh-Hant-TW");
        assert_eq!(normalize_locale("C.UTF-8"), "en");
        assert_eq!(normalize_locale("POSIX"), "en");
    }

    #[test]
    fn resolves_region_and_script_fallbacks() {
        let catalogs = fixture();
        assert_eq!(resolve_locale(&catalogs, "de-AT"), Some("de"));
        assert_eq!(resolve_locale(&catalogs, "pt_PT"), Some("pt-BR"));
        assert_eq!(resolve_locale(&catalogs, "zh-Hant-HK"), Some("zh-TW"));
        assert_eq!(resolve_locale(&catalogs, "zh-Hans-SG"), Some("zh-CN"));
        assert_eq!(resolve_locale(&catalogs, "ar_EG.UTF-8"), Some("ar"));
        assert_eq!(resolve_locale(&catalogs, "fa_IR.UTF-8"), Some("fa"));
        assert_eq!(resolve_locale(&catalogs, "ja-JP"), None);
        assert_eq!(resolve_locale(&catalogs, "../../etc/passwd"), None);
    }

    #[test]
    fn falls_back_to_operating_system_ui_languages_when_environment_is_missing() {
        let catalogs = fixture();
        assert_eq!(
            select_locale(&catalogs, &[], || vec!["de-DE".to_owned()]),
            "de"
        );
        assert_eq!(
            select_locale(&catalogs, &[], || vec!["fa_IR".to_owned()]),
            "fa"
        );
        assert_eq!(
            select_locale(&catalogs, &[], || vec![
                "../../etc/passwd".to_owned(),
                "zh-Hant-HK".to_owned(),
            ]),
            "zh-TW"
        );
        assert_eq!(
            select_locale(&catalogs, &[], || vec!["unsupported".to_owned()]),
            "en"
        );
    }

    #[test]
    fn explicit_posix_locale_wins_without_querying_operating_system() {
        let catalogs = fixture();
        assert_eq!(
            select_locale(&catalogs, &["de_DE.UTF-8".to_owned()], || {
                panic!("explicit POSIX locale must avoid operating-system lookup")
            }),
            "de"
        );
        assert_eq!(
            select_locale(&catalogs, &["C".to_owned()], || {
                panic!("explicit C locale must avoid operating-system lookup")
            }),
            "en"
        );
    }

    #[test]
    fn parses_ordered_macos_language_preferences_and_rejects_invalid_values() {
        assert_eq!(
            parse_macos_locales("(\n    \"de-DE\",\n    \"fa-IR\"\n)\n"),
            ["de-DE", "fa-IR"]
        );
        assert_eq!(parse_macos_locales("pt_BR\n"), ["pt_BR"]);
        assert!(parse_macos_locales("../../etc/passwd\n").is_empty());
    }

    #[test]
    fn translates_named_arguments_and_falls_back_to_english() {
        let catalogs = fixture();
        assert_eq!(
            translate_for_locale(&catalogs, "de-DE", "greeting", &[("name", "Peter")]),
            "Hallo, Peter!"
        );
        assert_eq!(
            translate_for_locale(&catalogs, "de-DE", "onlyEnglish", &[]),
            "Fallback"
        );
        assert_eq!(
            translate_for_locale(&catalogs, "unknown", "greeting", &[("name", "Peter")]),
            "Hello, Peter!"
        );
        assert_eq!(
            translate_for_locale(&catalogs, "de", "missing.key", &[]),
            "missing.key"
        );
    }

    #[test]
    fn chooses_cldr_plural_categories_for_supported_locales() {
        for (locale, count, expected) in [
            ("en", 1, "one"),
            ("en", 2, "other"),
            ("fr", 0, "one"),
            ("pt-BR", 0, "one"),
            ("ar", 0, "zero"),
            ("ar", 2, "two"),
            ("ar", 4, "few"),
            ("ar", 14, "many"),
            ("ru", 1, "one"),
            ("ru", 3, "few"),
            ("ru", 11, "many"),
            ("uk", 24, "few"),
            ("pl", 1, "one"),
            ("pl", 3, "few"),
            ("pl", 13, "many"),
        ] {
            assert_eq!(
                plural_category(locale, count),
                expected,
                "{locale}: {count}"
            );
        }
    }

    #[test]
    fn renders_arabic_and_slavic_category_specific_plural_messages() {
        let mut catalogs = fixture();
        for locale in ["ar", "ru", "uk", "pl"] {
            let messages = catalogs.entry(locale.to_owned()).or_default();
            for category in ["zero", "one", "two", "few", "many", "other"] {
                messages.insert(
                    format!("pending.{category}"),
                    format!("{locale}:{category}:{{count}}"),
                );
            }
        }

        for (locale, count, expected) in [
            ("ar", 0, "ar:zero:0"),
            ("ar", 1, "ar:one:1"),
            ("ar", 2, "ar:two:2"),
            ("ar", 4, "ar:few:4"),
            ("ar", 14, "ar:many:14"),
            ("ar", 100, "ar:other:100"),
            ("ru", 1, "ru:one:1"),
            ("ru", 3, "ru:few:3"),
            ("ru", 11, "ru:many:11"),
            ("uk", 1, "uk:one:1"),
            ("uk", 24, "uk:few:24"),
            ("uk", 15, "uk:many:15"),
            ("pl", 1, "pl:one:1"),
            ("pl", 3, "pl:few:3"),
            ("pl", 13, "pl:many:13"),
        ] {
            let value = count.to_string();
            assert_eq!(
                plural_for_locale(&catalogs, locale, "pending", count, &[("count", &value)]),
                expected,
                "{locale}: {count}"
            );
        }
    }

    #[test]
    fn missing_plural_category_keeps_available_translation_before_english_fallback() {
        let mut catalogs = fixture();
        catalogs
            .get_mut("en")
            .expect("fixture has English messages")
            .extend([
                ("pending.one".to_owned(), "1 approval pending".to_owned()),
                (
                    "pending.few".to_owned(),
                    "{count} approvals pending in English".to_owned(),
                ),
                (
                    "pending.other".to_owned(),
                    "{count} approvals pending".to_owned(),
                ),
            ]);
        catalogs
            .entry("ru".to_owned())
            .or_default()
            .insert("pending.other".to_owned(), "Русский: {count}".to_owned());

        assert_eq!(
            plural_for_locale(&catalogs, "ru", "pending", 3, &[("count", "3")]),
            "Русский: 3"
        );
        assert_eq!(
            plural_for_locale(&catalogs, "en", "pending", 1, &[("count", "1")]),
            "1 approval pending"
        );
        assert_eq!(
            plural_for_locale(&catalogs, "en", "pending", 2, &[("count", "2")]),
            "2 approvals pending"
        );
    }

    #[test]
    fn bundled_catalog_contains_every_native_shell_message() {
        let english = catalogs()
            .get("en")
            .expect("the bundled localization catalog includes English");
        for key in [
            "common.connected",
            "desktop.gateway.checking",
            "desktop.gateway.cliRequired",
            "desktop.gateway.installCli",
            "desktop.gateway.notInstalled",
            "desktop.gateway.reconnecting",
            "desktop.gateway.stopped",
            "desktop.gateway.unavailable",
            "desktop.notifications.devicePairing",
            "desktop.notifications.nodePairing",
            "desktop.notifications.updateAvailable",
            "desktop.notifications.updateCheckFailed",
            "desktop.notifications.updateCurrent",
            "desktop.notifications.updateFailed",
            "desktop.notifications.updateReady",
            "desktop.quickchat.title",
            "desktop.tray.checkForUpdates",
            "desktop.tray.globalShortcut",
            "desktop.tray.openDashboard",
            "desktop.tray.pending.one",
            "desktop.tray.pending.other",
            "desktop.tray.quickChat",
            "desktop.tray.quickChatShortcut",
            "desktop.tray.quit",
            "desktop.tray.restartGateway",
            "desktop.tray.startAtLogin",
            "desktop.tray.startGateway",
            "desktop.tray.status",
            "desktop.tray.stopGateway",
        ] {
            assert!(english.contains_key(key), "missing desktop message: {key}");
        }
    }
}
