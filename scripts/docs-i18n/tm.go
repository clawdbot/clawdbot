package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

type TMEntry struct {
	CacheKey   string `json:"cache_key"`
	SegmentID  string `json:"segment_id"`
	SourcePath string `json:"source_path"`
	TextHash   string `json:"text_hash"`
	Text       string `json:"text"`
	Translated string `json:"translated"`
	Provider   string `json:"provider"`
	Model      string `json:"model"`
	SrcLang    string `json:"src_lang"`
	TgtLang    string `json:"tgt_lang"`
	UpdatedAt  string `json:"updated_at"`
}

type TranslationMemory struct {
	path    string
	entries map[string]TMEntry
}

func LoadTranslationMemory(path string) (*TranslationMemory, error) {
	tm := &TranslationMemory{path: path, entries: map[string]TMEntry{}}
	file, err := os.Open(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return tm, nil
		}
		return nil, err
	}
	defer func() {
		_ = file.Close()
	}()

	reader := bufio.NewReader(file)
	for {
		line, err := reader.ReadBytes('\n')
		if len(line) > 0 {
			trimmed := strings.TrimSpace(string(line))
			if trimmed != "" {
				var entry TMEntry
				if err := json.Unmarshal([]byte(trimmed), &entry); err != nil {
					return nil, fmt.Errorf("translation memory decode failed: %w", err)
				}
				if entry.CacheKey != "" && strings.TrimSpace(entry.Translated) != "" {
					tm.entries[entry.CacheKey] = entry
				}
			}
		}
		if err != nil {
			if errors.Is(err, io.EOF) {
				break
			}
			return nil, err
		}
	}
	return tm, nil
}

func (tm *TranslationMemory) Get(cacheKey string) (TMEntry, bool) {
	entry, ok := tm.entries[cacheKey]
	if !ok {
		return TMEntry{}, false
	}
	if strings.TrimSpace(entry.Translated) == "" {
		return TMEntry{}, false
	}
	return entry, true
}

func (tm *TranslationMemory) Put(entry TMEntry) {
	if entry.CacheKey == "" {
		return
	}
	tm.entries[entry.CacheKey] = entry
}

func (tm *TranslationMemory) Save() error {
	if tm.path == "" {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(tm.path), 0o755); err != nil {
		return err
	}
	tmpPath := tm.path + ".tmp"
	file, err := os.Create(tmpPath)
	if err != nil {
		return err
	}

	keys := make([]string, 0, len(tm.entries))
	for key := range tm.entries {
		keys = append(keys, key)
	}
	sort.Strings(keys)

	writer := bufio.NewWriter(file)
	for _, key := range keys {
		entry := tm.entries[key]
		payload, err := json.Marshal(entry)
		if err != nil {
			_ = file.Close()
			return err
		}
		if _, err := writer.Write(payload); err != nil {
			_ = file.Close()
			return err
		}
		if _, err := writer.WriteString("\n"); err != nil {
			_ = file.Close()
			return err
		}
	}
	if err := writer.Flush(); err != nil {
		_ = file.Close()
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	return os.Rename(tmpPath, tm.path)
}
