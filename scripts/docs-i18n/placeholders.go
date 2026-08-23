package main

import (
	"fmt"
)

type PlaceholderState struct {
	counter int
	used    map[string]struct{}
}

func NewPlaceholderState(text string) *PlaceholderState {
	used := map[string]struct{}{}
	for _, hit := range placeholderRe.FindAllString(text, -1) {
		used[hit] = struct{}{}
	}
	return &PlaceholderState{counter: 900000, used: used}
}

func (s *PlaceholderState) Next() string {
	for {
		candidate := fmt.Sprintf("__OC_I18N_%d__", s.counter)
		s.counter++
		if _, ok := s.used[candidate]; ok {
			continue
		}
		s.used[candidate] = struct{}{}
		return candidate
	}
}
