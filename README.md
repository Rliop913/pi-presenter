# Pi Presenter (MVP)

Approval-gated, local-source presentation production for Pi. Package name: `@rliop/pi-presenter`. **Not published to npm.** No real presentation model calls or user-source deck validation have been performed for this implementation.

## Install locally

Requires Node.js 22+ and a current Pi host exposing `ctx.modelRegistry.streamSimple()` and Pi AI's `getSupportedThinkingLevels()`.

```sh
npm install
pi install ./
# Or try once from this directory:
pi --extension ./src/index.ts
```

Pi supplies the `@earendil-works/pi-coding-agent` and `@earendil-works/pi-ai` peers; both have `*` ranges. Runtime dependencies are PptxGenJS, YAML, and Zod. The manifest loads `./src/index.ts` and `./skills/presenter`. Pi loads TypeScript directly; no generated build is shipped.

### Real rendering prerequisites

Install **LibreOffice** (`soffice`) and **Poppler** (`pdftoppm`; `pdftotext` for PDF sources) and put their executables on Pi's PATH. On Windows, LibreOffice's `program` directory and the Poppler binary directory must be on PATH. Fonts Arial, Calibri, or Aptos must exist for consistent appearance. Verify:

```sh
soffice --version
pdftoppm -v
pdftotext -v
```

Missing tools, bad PDF output, malformed PNGs, or wrong page counts fail closed. Production rendering is exclusively **compiled PPTX → LibreOffice PDF → pdftoppm PNGs**. No HTML previews, placeholder slides, or synthetic screenshots satisfy production QA.

## Commands

Run Pi in the project containing your local source files.

| Command | Behavior |
|---|---|
| `/presenter new` | Collect user-defined contract and all seven assignments, show full approval matrix, then start only after **Approve & Start** |
| `/presenter configure` | Revoke approval; edit contract + agents or agents only; show a new approval matrix |
| `/presenter status` | Check integrity and show state, fingerprint, revision, artifact count and call count; no model calls |
| `/presenter run` | Show approval dialog if awaiting approval, otherwise continue already-approved work |
| `/presenter resume` | Revalidate saved approval, live registry, source hashes and artifact hashes; continue without silently approving |
| `/presenter review` | Require a current built/rendered workspace; rerun factual and actual-image visual QA; revoke COMPLETE while reviewing |
| `/presenter export` | Copy current PPTX to the contract's output path only when COMPLETE and all current QA hashes/scores pass |
| `/presenter cancel` | Abort the owned operation/dialogs; keep validated checkpoints for resume |

Setup collects title, purpose, audience, duration, slide count, project-relative source paths, output path and requirements. Paths are entered one per line (source list also permits pasted newlines). Input dialogs show existing/default values as placeholders: enter the value you want to retain. Native `input`, `select` and `notify` dialogs work in TUI and dialog-capable RPC; headless modes cannot create approval. Cancellation never initiates production. Entering configure revokes existing approval even if subsequently cancelled. New replaces the project presentation after contract collection.

**Before approval there are no presentation model calls, source extraction/research, narrative/design calls, or compilation.** Reading raw bytes to fingerprint approved files and discovering the synchronous available registry are configuration validation, not research. The initial contract is supplied by the user. Director refinement happens only after approval and cannot change approved counts, sources, output or scope.

### Exact assignments, not aliases or fallback

Roles: `director`, `evidence_researcher`, `narrative_architect`, `art_director`, `visual_designer`, `fact_reviewer`, `visual_reviewer`.

Presets suggest IDs only, not presumed providers or executable defaults:

| Preset | Director | Evidence | Narrative | Art | Visual | Fact | Visual review | Suggested effort |
|---|---|---|---|---|---|---|---|---|
| economy | gpt-5.6-terra | gpt-5.6-luna | gpt-5.6-terra | gpt-5.6-terra | gpt-5.6-luna | gpt-5.6-terra | gpt-5.6-terra | medium; Evidence low |
| balanced | gpt-5.6-sol | gpt-5.6-luna | gpt-5.6-sol | gpt-5.6-sol | gpt-5.6-terra | gpt-5.6-sol | gpt-5.6-sol | high; Evidence and Visual medium |
| maximum | gpt-6-astra | gpt-5.6-sol | gpt-6-astra | gpt-6-astra | gpt-5.6-sol | gpt-6-astra | gpt-6-astra | high |

Every role requires an explicit selection from the actual credential-available Pi registry, preserving exact **provider + model ID + effort**. Missing suggested IDs require explicit replacement. Visual review requires image input capability. Effort choices come from the host helper, not a hardcoded model-name heuristic. No silent clamp, model substitution, provider guess, or fallback is allowed. A provider reporting a different response model also fails closed; alias/snapshot mismatches may therefore need an exact catalog assignment.

Approval records the full matrix and a SHA-256 fingerprint of raw presentation/agent configuration, local sources, and relevant registry capability/effort metadata. Any change to those inputs invalidates approval. The generated design-system configuration is also hash-tracked; changing it revokes approval. Reconfigure to restart after stale artifacts or config changes. Checkpoint hashes detect accidental edits, **not an attacker rewriting both files and checkpoint hashes**; this is not a signature/security boundary against trusted local code.

## Pipeline and artifacts

```text
UNINITIALIZED → PRESENTATION_DEFINED → AGENTS_CONFIGURED → AWAITING_APPROVAL
 → APPROVED → RESEARCH → STORYBOARD → DESIGN → BUILD → QA → COMPLETE
                                                   ↑        |
                                                   +--------+ bounded revision
```

The workflow owns isolated provider calls: fresh system/user messages, no parent conversation, no agent tools, no arbitrary executable commands from models. Calls are sequential and bounded (180 calls, 180 seconds/call, 12k maximum output tokens, strict output schemas and payload bounds). Actual provider-native effort mapping remains the host's responsibility. Requested exact effort, role/model, task, timestamps, usage and outcomes are recorded in the checkpoint trace; command-owned usage is not added to the parent conversation's token totals.

```text
.presentation/
  config/presentation.yaml       # user contract
  config/agents.yaml             # exact assignments
  config/design-system.yaml     # approved-run Art Director output
  checkpoint.json               # durable state, approval, hashes, trace
  evidence/sources.json
  evidence/evidence.json         # canonical combined database
  evidence/claims.json
  evidence/figures.json
  narrative/director-contract.yaml
  narrative/argument-map.yaml
  narrative/director-acceptance.yaml
  narrative/storyboard.yaml
  deck/deck-spec.yaml
  deck/before-revision-N.yaml
  deck/patch-N.yaml
  assets/
  renders/presentation.pdf
  renders/slide-N.png
  renders/manifest.json
  reviews/fact-N.json
  reviews/visual-N-SLIDE.json
  reviews/visual-N.json
  output/presentation.pptx
```

Evidence claims require exact source quotes and valid source IDs. Numbers are conservatively checked against literal citations: a numeric-bearing claim must be an exact sourced statement; numeric titles must be an exact supported claim substring. No derived arithmetic. Charts require literal label/value associations and source unit provenance. Models cannot invent claim references. Qualitative entailment and nuanced data interpretation still require the fact reviewer and human judgment.

Narrative Architect builds an argument map; Director must accept it at narrative ≥8 before storyboard. Storyboards must match the approved slide count and valid claims. Art Director emits a bounded design system. Visual Designer can choose only fixed layouts and known assets/figures. Compiler inserts evidence text directly, not model-authored executable content. Titles and storyboard claim IDs remain immutable during visual design/revisions.

The six widescreen layouts are **title, two-column, bullets, process, chart, image**. Text, shapes and charts are editable; embedded images remain raster images. Typography, margins and density limits are fixed. Slide footers and speaker notes carry citation refs/quotes. Geometry/spec interpretation is deterministic, but **PPTX bytes are not promised identical**: ZIP timestamps and document metadata are not normalized.

Fact review must score factual ≥9 and narrative ≥8. Actual PNG image blocks are sent to the vision reviewer separately for every slide; narrative, hierarchy, consistency and readability must each be ≥8. Any major/critical finding blocks completion regardless of scores. Director integrates failed reviews into a slide-specific patch plan. Only named affected slides can change; all blocking findings must be covered, and unaffected specs/evidence/design/storyboard are preserved. The default is two revision attempts (configurable `maxRevisions` 0–3 before approval). Each patch recompiles, rerenders and rechecks the whole deck. A factual/narrative error requiring evidence or storyboard changes intentionally cannot be repaired by the visual patcher: correct sources/requirements and reconfigure. Exhaustion or failure leaves export blocked.

## Source and safety limits

Supported local `.txt`, `.md`, `.markdown`, `.csv`, `.json`, `.pdf`, `.png`, `.jpg`, `.jpeg`; UTF-8 text only. CSV/JSON remain quoted source text, not arbitrary code or formulas. PDF extraction uses fixed-argv `pdftotext`; scanned PDFs without text need external preparation (no OCR). Images are assets, not primary factual evidence in this MVP. Sources must stay under the project root; symlink/junction escapes are rejected. No web research, OCR, network asset fetching, generated images, SVG, or remote sources. Export must be a root-relative `.pptx` outside `.presentation` and can overwrite that approved destination.

Limits: 20 files, 8 MiB/file, 24 MiB/raw total, 300k extracted characters/file, 500k extracted characters total, 30 slides, bounded claim/title lengths and density. Model prompt instructions explicitly classify all source/artifact data as untrusted; deterministic validation and absence of tools reduce prompt injection risks but cannot guarantee semantic model compliance. LibreOffice/Poppler process untrusted files with host permissions; keep them patched. This extension is not a sandbox.

One exclusive disk operation lock covers setup/run/review/export. Normal errors/cancel release it. Atomic writes use temp files, file fsync and rename; each completed unit is hash-checkpointed. Resume reuses only validated registered artifacts, never leftover files. A process crash between an artifact rename and checkpoint update can conservatively require reconfiguration rather than reuse partially committed data. Directory fsync/power-loss durability is not guaranteed on every filesystem. After a hard crash, inspect `.presentation/operation.lock` and verify its recorded PID is dead before deleting the lock; do not remove a live process's lock.

## Verification / current status

```sh
npm install
npm run typecheck
npm test
npm pack --dry-run
```

Validation on the implementation environment: TypeScript passed; **32 tests passed, 0 failed/skipped**; installed Pi's native extension loader reported one extension, `/presenter`, and zero loading errors; package dry-run includes 17 files and excludes tests/mocks. Active LSP probes were inconclusive (no clean confirmation); `tsc` is the authoritative type check.

Dependency caveat: PptxGenJS is pinned to 4.0.0. `npm audit` still reports **one high-severity transitive `image-size` advisory group** (ICNS/JXL/HEIF parser denial of service). Those input formats are not accepted by this pipeline, but the installed dependency is not patched. `npm audit fix` did not resolve it within the allowed version range. Review/update the upstream dependency before production deployment; do not use force-upgrades blindly. Environment policy also blocked three dependency lifecycle scripts during install; tests/typecheck still passed.
Tests are offline. They cover preapproval command/dispatch/compiler/ingestion denial; wizard cancellation; exact identities/effort/vision; edits/fingerprints; cancellation and locks; evidence/ref/provenance failures; targeted immutability; bounded revisions; stale resume/export; and actual ZIP/XML/PPTX chart/image compilation across all layouts. **MOCK integration fixtures explicitly mock model responses and slide rendering**, while using the real compiler. Missing executable tests and fixed-argv/page-count tests verify fail-closed renderer behavior; they are not real rendering certification. Mocks are under `tests/`, excluded from the package, and cannot be selected by production configuration.

Remaining validation: install external rendering tools, use real user sources, explicitly approve available exact assignments, run the workflow, inspect actual rendered slides and PowerPoint/LibreOffice output, and evaluate model review quality. This MVP has not been published, committed, or demonstrated with real presentation model calls. See `examples/` for a small local source and contract example, not a certified/generated deck.
