# Repository Guidelines

## Project Shape

This repository builds `openclaw-cortex-memory`, an OpenClaw long-term memory plugin written in TypeScript for Node 22+.

- `index.ts` is the plugin entrypoint. It loads config, resolves the memory root, constructs stores and engines, registers tools, and wires lifecycle hooks.
- `src/engine/` owns the tool execution layer and shared tool argument/result types.
- `src/store/` owns active/archive/vector/graph storage and read fusion.
- `src/sync/`, `src/session/`, and `src/reflect/` own session import, session-end routing, and rule reflection.
- `src/wiki/` and `src/graph/` own graph schema, wiki projection, linting, and conflict-related helpers.
- `scripts/cli.js` is the shipped `cortex-memory` CLI.
- `openclaw.plugin.json`, `package.json`, root `SKILL.md`, and `skills/cortex-memory/` describe the public plugin/package surface.

Treat `dist/` as build output. Prefer changing TypeScript/source docs and rebuilding over editing generated files directly.

## Commands

Use the package scripts as the source of truth:

- Install: `npm install --no-audit --no-fund`
- Typecheck: `npm run typecheck`
- Build: `npm run build`
- Core CI regression set: `npm run test:ci-core`
- Full prepublish gate: `npm run prepublishOnly`
- Release readiness check: `npm run release:check`

Useful focused tests:

- Graph behavior: `npm run test:graph`
- Graph quality: `npm run test:graph-quality` and `npm run test:graph-quality-zh`
- Ingest regression: `npm run test:m1-ingest-regression`
- Cross-store regression: `npm run test:m5-cross-store`
- Wiki projection/lint: `npm run test:wiki-projection` and `npm run test:wiki-lint`
- Wiki page quality: `npm run test:wiki-projection` verifies rich entity/topic/timeline pages, and `npm run test:wiki-lint` verifies quality diagnostics.
- Length normalization: `npm run test:lengthnorm`

CI runs install, typecheck, build, and `test:ci-core` on Node 22 and 24.

## Change Coordination

When changing the public tool surface, update all relevant surfaces together:

- Runtime registration in `index.ts`
- Types/handlers in `src/engine/`
- Manifest entries in `openclaw.plugin.json`
- User-facing docs in `README.md`, root `SKILL.md`, and `skills/cortex-memory/references/`
- Tests or regression fixtures under `scripts/`, `eval/`, or `docs/progress-evidence/` when behavior changes

When changing config defaults or runtime requirements, check:

- `defaultConfig` and config merge logic in `index.ts`
- `openclaw.plugin.json` runtime requirement fields
- `package.json` `openclaw` metadata
- README minimal/full config examples
- Skill/reference docs that users may paste into agent prompts

When changing storage, retrieval, graph, wiki, or sync behavior, run at least `npm run typecheck` plus the narrow relevant regression script. Use `npm run test:ci-core` before treating shared behavior as done.

## Wiki Quality Notes

- `src/wiki/wiki_projector.ts` should keep generated pages useful as knowledge pages, not just relation dumps. Entity pages should retain `Current Conclusion`, `Recent Changes`, `High Confidence Facts`, `Current Facts`, `Open Conflicts`, `Disputed Facts`, `History`, and `Evidence Excerpts`.
- Topic pages should retain `Current Conclusion`, `Status Groups`, `Timeline`, `Latest Status`, `Relations`, and `Evidence Excerpts`.
- Timeline pages should retain `Current Conclusion`, `Event Flow`, `Timeline`, `Latest Status`, `Relations`, and `Evidence Excerpts`.
- When archive records are available, wiki projection should surface `cause`, `process`, and `result` in timeline/event-flow evidence instead of losing that context.
- `src/wiki/wiki_linter.ts` should flag missing rich sections, stale legacy Summary text, empty evidence excerpts, graph/wiki consistency drift, pending conflicts, and evidence gaps.
- Keep `scripts/wiki-projection-regression.js` and `scripts/wiki-lint-regression.js` aligned with any wiki page schema changes.

## Runtime And Data Safety

- Do not commit secrets or real endpoint keys. The plugin expects credentials from environment variables or plugin config: `EMBEDDING_API_KEY`, `LLM_API_KEY`, and `RERANKER_API_KEY`.
- Be careful with `data/`, `tmp/`, and local memory directories. They may contain local runtime state rather than fixtures.
- The default memory root resolution prefers `OPENCLAW_BASE_PATH/workspace/memory/openclaw-cortex-memory`, otherwise `<projectRoot>/data/memory`, unless `dbPath` overrides it.
- `sync_memory`, `backfill_embeddings`, `reflect_memory`, delete operations, and graph conflict resolution can mutate memory state. Do not run them against user data unless the task explicitly calls for it.
- The CLI intentionally puts OpenClaw into exclusive memory mode by disabling `memory-core` and `memory-lancedb` and setting `plugins.slots.memory` to `none`; keep that behavior explicit in CLI changes.

## Style Notes

- Keep TypeScript strict and compatible with `moduleResolution: NodeNext`.
- Prefer existing helpers in `src/net`, `src/quality`, `src/dedup`, `src/wiki`, and `src/graph` over adding parallel ad hoc logic.
- Preserve JSON/JSONL schema compatibility. For structured records, use the existing validators and normalizers instead of string-only parsing.
- Keep docs operational and copy-pastable. This repo has Chinese-facing README/skill content, so preserve existing Chinese wording style when editing those files.
