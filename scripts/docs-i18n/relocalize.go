package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

func postprocessLocalizedDocs(docsRoot, targetLang string, localizedFiles []string) error {
	if targetLang == "" || targetLang == "en" || len(localizedFiles) == 0 {
		return nil
	}

	routes, err := loadRouteIndex(docsRoot, targetLang)
	if err != nil {
		return err
	}

	for _, path := range localizedFiles {
		content, err := os.ReadFile(path)
		if err != nil {
			return err
		}

		frontMatter, body := splitFrontMatter(string(content))
		rewrittenBody := routes.localizeBodyLinks(body)
		updatedFrontMatter := setPostprocessVersion(frontMatter, localizedLinkPostprocessVersion)
		output := rewrittenBody
		if updatedFrontMatter != "" {
			output = "---\n" + updatedFrontMatter + "\n---\n\n" + rewrittenBody
		}
		sourcePath, err := localizedSourcePath(docsRoot, targetLang, path)
		if err != nil {
			return err
		}
		source, err := os.ReadFile(sourcePath)
		if err != nil {
			return err
		}
		if !sameI18NProtocolMarkers(string(source), output) {
			return fmt.Errorf("protocol token leaked after localized link postprocess: %s", path)
		}

		if rewrittenBody == body && updatedFrontMatter == frontMatter {
			continue
		}

		if err := os.WriteFile(path, []byte(output), 0o644); err != nil {
			return err
		}
	}

	return nil
}

func localizedSourcePath(docsRoot, targetLang, localizedPath string) (string, error) {
	localizedRoot, err := filepath.Abs(filepath.Join(docsRoot, targetLang))
	if err != nil {
		return "", err
	}
	absPath, err := filepath.Abs(localizedPath)
	if err != nil {
		return "", err
	}
	relPath, err := filepath.Rel(localizedRoot, absPath)
	if err != nil {
		return "", err
	}
	if relPath == "." || filepath.IsAbs(relPath) || relPath == ".." || strings.HasPrefix(relPath, ".."+string(filepath.Separator)) {
		return "", fmt.Errorf("localized file %s not under locale root %s", absPath, localizedRoot)
	}
	return filepath.Join(docsRoot, relPath), nil
}

func setPostprocessVersion(frontMatter, version string) string {
	if strings.TrimSpace(frontMatter) == "" {
		return frontMatter
	}

	lines := strings.Split(frontMatter, "\n")
	inXI18N := false
	xi18nLine := -1
	insertAt := -1
	childIndent := "  "

	for i, line := range lines {
		trimmed := strings.TrimSpace(line)
		if trimmed == "x-i18n:" {
			inXI18N = true
			xi18nLine = i
			insertAt = len(lines)
			continue
		}
		if !inXI18N {
			continue
		}
		if trimmed == "" {
			continue
		}
		indent := leadingWhitespace(line)
		if len(indent) <= len(leadingWhitespace(lines[xi18nLine])) {
			insertAt = i
			break
		}
		childIndent = indent
		if strings.HasPrefix(trimmed, "postprocess_version:") {
			lines[i] = indent + "postprocess_version: " + version
			return strings.Join(lines, "\n")
		}
	}

	if xi18nLine == -1 {
		return frontMatter
	}
	if insertAt == -1 {
		insertAt = len(lines)
	}

	lines = append(lines[:insertAt], append([]string{childIndent + "postprocess_version: " + version}, lines[insertAt:]...)...)
	return strings.Join(lines, "\n")
}

func leadingWhitespace(text string) string {
	return text[:len(text)-len(strings.TrimLeft(text, " \t"))]
}
