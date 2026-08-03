package main

import (
	"path/filepath"
	"sort"
)

type orderedFile struct {
	path string
	rel  string
}

func orderFiles(docsRoot string, files []string) ([]string, error) {
	entries := make([]orderedFile, 0, len(files))
	for _, file := range files {
		abs, err := filepath.Abs(file)
		if err != nil {
			return nil, err
		}
		rel, err := filepath.Rel(docsRoot, abs)
		if err != nil {
			rel = abs
		}
		entries = append(entries, orderedFile{path: file, rel: rel})
	}
	if len(entries) == 0 {
		return nil, nil
	}
	sort.Slice(entries, func(i, j int) bool {
		return entries[i].rel < entries[j].rel
	})
	ordered := make([]string, 0, len(entries))
	for _, entry := range entries {
		ordered = append(ordered, entry.path)
	}
	return ordered, nil
}
