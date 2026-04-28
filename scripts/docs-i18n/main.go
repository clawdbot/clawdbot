package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sync"
	"time"
)

type docJob struct {
	index int
	path  string
	rel   string
}

type docResult struct {
	index    int
	rel      string
	output   string
	duration time.Duration
	skipped  bool
	err      error
}

type runConfig struct {
	targetLang string
	sourceLang string
	docsRoot   string
	tmPath     string
	mode       string
	thinking   string
	overwrite  bool
	maxFiles   int
	parallel   int
}

func main() {
	var (
		targetLang = flag.String("lang", "zh-CN", "target language (e.g., zh-CN)")
		sourceLang = flag.String("src", "en", "source language")
		docsRoot   = flag.String("docs", "docs", "docs root")
		tmPath     = flag.String("tm", "", "translation memory path")
		mode       = flag.String("mode", "segment", "translation mode (segment|doc)")
		thinking   = flag.String("thinking", "high", "thinking level (low|medium|high|xhigh)")
		overwrite  = flag.Bool("overwrite", false, "overwrite existing translations")
		maxFiles   = flag.Int("max", 0, "max files to process (0 = all)")
		parallel   = flag.Int("parallel", 1, "parallel workers for doc mode")
	)
	flag.Parse()
	files := flag.Args()
	if len(files) == 0 {
		fatal(fmt.Errorf("no doc files provided"))
	}

	if err := runDocsI18N(context.Background(), runConfig{
		targetLang: *targetLang,
		sourceLang: *sourceLang,
		docsRoot:   *docsRoot,
		tmPath:     *tmPath,
		mode:       *mode,
		thinking:   *thinking,
		overwrite:  *overwrite,
		maxFiles:   *maxFiles,
		parallel:   *parallel,
	}, files, func(srcLang, tgtLang string, glossary []GlossaryEntry, thinking string) (docsTranslator, error) {
		return NewCodexTranslator(srcLang, tgtLang, glossary, thinking)
	}); err != nil {
		fatal(err)
	}
}

func runDocsI18N(ctx context.Context, cfg runConfig, files []string, newTranslator docsTranslatorFactory) error {
	if len(files) == 0 {
		return fmt.Errorf("no doc files provided")
	}

	resolvedDocsRoot, err := filepath.Abs(cfg.docsRoot)
	if err != nil {
		return err
	}

	tmPath := cfg.tmPath
	if tmPath == "" {
		tmPath = filepath.Join(resolvedDocsRoot, ".i18n", fmt.Sprintf("%s.tm.jsonl", cfg.targetLang))
	}

	glossaryPath := filepath.Join(resolvedDocsRoot, ".i18n", fmt.Sprintf("glossary.%s.json", cfg.targetLang))
	glossary, err := LoadGlossary(glossaryPath)
	if err != nil {
		return err
	}

	tm, err := LoadTranslationMemory(tmPath)
	if err != nil {
		return err
	}

	ordered, err := orderFiles(resolvedDocsRoot, files)
	if err != nil {
		return err
	}
	totalFiles := len(ordered)
	preSkipped := 0
	if cfg.mode == "doc" && !cfg.overwrite {
		filtered, skipped, err := filterDocQueue(resolvedDocsRoot, cfg.targetLang, ordered)
		if err != nil {
			return err
		}
		ordered = filtered
		preSkipped = skipped
	}
	if cfg.maxFiles > 0 && cfg.maxFiles < len(ordered) {
		ordered = ordered[:cfg.maxFiles]
	}

	parallel := cfg.parallel
	if parallel < 1 {
		parallel = 1
	}

	log.SetFlags(log.LstdFlags)
	start := time.Now()
	processed := 0
	skipped := 0
	localizedFiles := []string{}
	var runErr error

	log.Printf("docs-i18n: mode=%s total=%d pending=%d pre_skipped=%d overwrite=%t thinking=%s parallel=%d", cfg.mode, totalFiles, len(ordered), preSkipped, cfg.overwrite, cfg.thinking, parallel)
	switch cfg.mode {
	case "doc":
		if parallel > 1 {
			proc, skip, outputs, err := runDocParallel(ctx, ordered, resolvedDocsRoot, cfg.sourceLang, cfg.targetLang, cfg.overwrite, parallel, glossary, cfg.thinking, newTranslator)
			processed += proc
			skipped += skip
			localizedFiles = append(localizedFiles, outputs...)
			if err != nil {
				runErr = err
			}
		} else {
			translator, err := newTranslator(cfg.sourceLang, cfg.targetLang, glossary, cfg.thinking)
			if err != nil {
				return err
			}
			defer translator.Close()
			proc, skip, outputs, err := runDocSequential(ctx, ordered, translator, resolvedDocsRoot, cfg.sourceLang, cfg.targetLang, cfg.overwrite)
			processed += proc
			skipped += skip
			localizedFiles = append(localizedFiles, outputs...)
			if err != nil {
				runErr = err
			}
		}
	case "segment":
		if parallel > 1 {
			return fmt.Errorf("parallel processing is only supported in doc mode")
		}
		translator, err := newTranslator(cfg.sourceLang, cfg.targetLang, glossary, cfg.thinking)
		if err != nil {
			return err
		}
		defer translator.Close()
		proc, outputs, err := runSegmentSequential(ctx, ordered, translator, tm, resolvedDocsRoot, cfg.sourceLang, cfg.targetLang)
		processed += proc
		localizedFiles = append(localizedFiles, outputs...)
		if err != nil {
			runErr = err
		}
	default:
		return fmt.Errorf("unknown mode: %s", cfg.mode)
	}

	if err := tm.Save(); err != nil && runErr == nil {
		runErr = err
	}
	if err := postprocessLocalizedDocs(resolvedDocsRoot, cfg.targetLang, localizedFiles); err != nil && runErr == nil {
		runErr = err
	}
	elapsed := time.Since(start).Round(time.Millisecond)
	log.Printf("docs-i18n: completed processed=%d skipped=%d elapsed=%s", processed, skipped, elapsed)
	return runErr
}

func runDocSequential(ctx context.Context, ordered []string, translator docsTranslator, docsRoot, srcLang, tgtLang string, overwrite bool) (int, int, []string, error) {
	processed := 0
	skipped := 0
	outputs := []string{}
	for index, file := range ordered {
		relPath := resolveRelPath(docsRoot, file)
		log.Printf("docs-i18n: [%d/%d] start %s", index+1, len(ordered), relPath)
		start := time.Now()
		skip, outputPath, err := processFileDoc(ctx, translator, docsRoot, file, srcLang, tgtLang, overwrite)
		if err != nil {
			return processed, skipped, outputs, err
		}
		if skip {
			skipped++
			log.Printf("docs-i18n: [%d/%d] skipped %s (%s)", index+1, len(ordered), relPath, time.Since(start).Round(time.Millisecond))
		} else {
			processed++
			outputs = append(outputs, outputPath)
			log.Printf("docs-i18n: [%d/%d] done %s (%s)", index+1, len(ordered), relPath, time.Since(start).Round(time.Millisecond))
		}
	}
	return processed, skipped, outputs, nil
}

func runDocParallel(ctx context.Context, ordered []string, docsRoot, srcLang, tgtLang string, overwrite bool, parallel int, glossary []GlossaryEntry, thinking string, newTranslator docsTranslatorFactory) (int, int, []string, error) {
	jobs := make(chan docJob)
	results := make(chan docResult, len(ordered))
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()

	var wg sync.WaitGroup
	for worker := 0; worker < parallel; worker++ {
		wg.Add(1)
		go func(workerID int) {
			defer wg.Done()
			translator, err := newTranslator(srcLang, tgtLang, glossary, thinking)
			if err != nil {
				results <- docResult{err: err}
				return
			}
			defer translator.Close()
			for job := range jobs {
				if ctx.Err() != nil {
					return
				}
				log.Printf("docs-i18n: [w%d %d/%d] start %s", workerID, job.index, len(ordered), job.rel)
				start := time.Now()
				skip, outputPath, err := processFileDoc(ctx, translator, docsRoot, job.path, srcLang, tgtLang, overwrite)
				results <- docResult{
					index:    job.index,
					rel:      job.rel,
					output:   outputPath,
					duration: time.Since(start),
					skipped:  skip,
					err:      err,
				}
				if err != nil {
					cancel()
					return
				}
			}
		}(worker + 1)
	}

	go func() {
		defer close(jobs)
		for index, file := range ordered {
			job := docJob{index: index + 1, path: file, rel: resolveRelPath(docsRoot, file)}
			select {
			case <-ctx.Done():
				return
			case jobs <- job:
			}
		}
	}()

	go func() {
		wg.Wait()
		close(results)
	}()

	processed := 0
	skipped := 0
	outputs := []string{}
	var firstErr error
	for result := range results {
		if result.err != nil && firstErr == nil {
			firstErr = result.err
		}
		if result.skipped {
			skipped++
			log.Printf("docs-i18n: [w* %d/%d] skipped %s (%s)", result.index, len(ordered), result.rel, result.duration.Round(time.Millisecond))
		} else if result.err == nil {
			processed++
			outputs = append(outputs, result.output)
			log.Printf("docs-i18n: [w* %d/%d] done %s (%s)", result.index, len(ordered), result.rel, result.duration.Round(time.Millisecond))
		}
	}
	return processed, skipped, outputs, firstErr
}

func runSegmentSequential(ctx context.Context, ordered []string, translator docsTranslator, tm *TranslationMemory, docsRoot, srcLang, tgtLang string) (int, []string, error) {
	processed := 0
	outputs := []string{}
	for index, file := range ordered {
		relPath := resolveRelPath(docsRoot, file)
		log.Printf("docs-i18n: [%d/%d] start %s", index+1, len(ordered), relPath)
		start := time.Now()
		_, outputPath, err := processFile(ctx, translator, tm, docsRoot, file, srcLang, tgtLang)
		if err != nil {
			return processed, outputs, err
		}
		processed++
		outputs = append(outputs, outputPath)
		log.Printf("docs-i18n: [%d/%d] done %s (%s)", index+1, len(ordered), relPath, time.Since(start).Round(time.Millisecond))
	}
	return processed, outputs, nil
}

func resolveRelPath(docsRoot, file string) string {
	relPath := file
	if _, rel, err := resolveDocsPath(docsRoot, file); err == nil {
		relPath = rel
	}
	return relPath
}

func filterDocQueue(docsRoot, targetLang string, ordered []string) ([]string, int, error) {
	pending := make([]string, 0, len(ordered))
	skipped := 0
	for _, file := range ordered {
		absPath, relPath, err := resolveDocsPath(docsRoot, file)
		if err != nil {
			return nil, skipped, err
		}
		content, err := os.ReadFile(absPath)
		if err != nil {
			return nil, skipped, err
		}
		sourceHash := hashBytes(content)
		outputPath := filepath.Join(docsRoot, targetLang, relPath)
		skip, err := shouldSkipDoc(outputPath, sourceHash)
		if err != nil {
			return nil, skipped, err
		}
		if skip {
			skipped++
			continue
		}
		pending = append(pending, file)
	}
	return pending, skipped, nil
}
