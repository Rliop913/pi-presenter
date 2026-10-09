# Pi Presenter — agent-owned skill

Presenter is a **skill**, not a code-driven model workflow. `skills/presenter/SKILL.md` tells the approved coordinator how to delegate to real agents, read their untouched work, interpret independent review and decide revisions/completion.

## Ownership boundary

| Responsibility | Owner |
| --- | --- |
| Work decomposition, role delegation, source interpretation, narrative and design planning | Approved skill agent |
| Factual/visual review | Fresh independent approved reviewer agents; natural-language reports |
| Understanding review, choosing repairs, deciding readiness | Approved coordinator, not a parser/score function |
| PPTX construction | Approved builder authors a normal PptxGenJS program |
| Native approval, file hashes/path safety, real rendering and export confirmation | Narrow mechanical helpers |

There is **no schema/JSON requirement on research, planning or reviewer responses**, no exact quotation/numeric/typography gate and no normalized evidence/argument/storyboard handoff. The intentional PPTX-generation program is code; other agents' language is not. Native configuration/tool arguments and software-generated file/provenance receipts remain machine-readable because software needs them. They do not judge model prose.

## Skill resources

```text
skills/presenter/
  SKILL.md
  references/orchestration.md
  references/pptx-authoring.md
  scripts/pptx.mjs              # PptxGenJS library adapter only
```

References resolve relative to the skill directory. The adapter does not invent content, constrain slide layouts or run a model.

The optional companion extension supplies `presenter_authority` and `presenter_files`. It is optional packaging/integration, but native approval remains mandatory for this workflow: if those helpers are unavailable, the skill must stop, not synthesize authority.

## Approval and use

1. Load `/skill:presenter` and describe the presentation.
2. The agent uses `presenter_authority new` (or `/presenter new`) to save **pending** configuration. No production work starts and no approval is implied.
3. Before approval, the agent aligns `.presentation/config/presentation.yaml` metadata with the actual user brief. Defaults must not override requested count/duration/output.
4. `presenter_authority approve` opens the native full source/assignment/effort matrix and agent-execution disclosures. Only the user's **Approve & Start** grants authority.
5. `/presenter run|resume|review|export` merely hands off instructions to the skill agent. It never constructs a `Pipeline`, streams a model, parses a reviewer verdict or retries a worker.
6. The agent uses `presenter_files authorize` before work, launches actual isolated agents, preserves versioned raw notes/reports and records genuine lifecycle results.

If the host agent is not the approved planner identity/effort, it only routes to an approved fresh planner/coordinator. Do not insert an unapproved host model into presentation content/QA. Missing identities, unsupported effort, missing topology/deadline controls or credentials mean stop; no fallback or clamp.

Tool-capable agent execution is a **new approval boundary**. Existing four/seven-role pipeline approvals keep their configuration/fingerprint history but cannot silently authorize the new mode. The new native approval records `skill/authority.json`. No real workspace approval is written by code migration or offline tests.

## Mechanical file operations

`presenter_files` explicitly performs one requested operation:

- `authorize`: validate current native scope and return exact assignments/sources.
- `register`: hash an existing file under `.presentation/skill/`.
- `render`: inspect actual PPTX page structure and run real LibreOffice PDF → Poppler PNG conversion.
- `references`: collect bounded approved design-site link/metadata inspiration only.
- `record-review`: bind an untouched `.md`/`.txt` report and actual job/model/effort/page metadata to the current render. **Recording is not QA acceptance.**
- `export`: require current factual/per-page reports and the user's native **Approve export** confirmation, then copy the verified bytes to the approved destination.

The coordinator reads the full reports, retains all approved quality requirements and resolves substantive blocking issues. Helpers do not interpret scores, severity prose or acceptance words. Before requesting final export the coordinator explains its QA decision. The native dialog explicitly states the distinction between mechanical verification and semantic judgment.

Use versioned files instead of overwriting registered work. New drafts need new actual renders and independent reviews. Old pipeline checkpoints/JSON reviews never certify a skill-produced draft.

`/presenter dependencies` remains a separate native **Approve installation** flow. No installation, asset/source/network expansion, source-executable instructions or approval substitution is implied by a presentation request. Builder programs use host trust/permissions; the helper is not a sandbox. Review metadata is an auditable agent assertion, not cryptographic proof of the agent runtime.

## Historical engine retirement

The old `Pipeline` run/review/export and `Dispatcher.call` entrypoints now stop before any model work. Old engine sources/tests and real-run artifacts remain as historical material, **not a supported production route**. The package allowlist and production import graph exclude `pipeline`, `dispatch`, `natural-flow`, `compact`, the old analysis `schema`, `evidence`, `compiler`, `renderer`, recovery and heartbeat engines. They are not published as runtime APIs. No history or pre-existing `.pi/` was deleted.

`npm test` now explicitly runs current skill/authority/file operations, catalog compatibility and dependency/network-boundary tests. Tests for the removed automatic model pipeline are retained as historical specifications; their former totals are not claimed as validation of this architecture.

## Verification status — repository migration verified; live execution pending

- With `PRESENTER_REAL_RENDER_TEST=1`, **76 tests all pass**, including actual editable PPTX generation and LibreOffice PDF → Poppler PNG conversion in disposable test fixtures. The default suite skips that one opt-in real-render test. Tests do not establish live M3 semantic orchestration or production approval.
- Production AST/import-graph checks pass: no model streaming or workflow controller reachable from the production entrypoint.
- Raw multilingual/Markdown/non-JSON report preservation, authority migration, handoff-only commands, native export cancellation, stale bindings, exact reviewer metadata, path/receipt safety and separate installation checks pass.
- `npm run typecheck` and `git diff --check` pass. After explicit user permission, the missing dispatcher retirement helper was added and its retirement regression test passes.
- The current-session extension registers its own `pdje_presenter_authority` / `pdje_presenter_files` helpers as well as command aliases. The prior alias-only registration omission was found during live preflight and fixed. Names do not collide with canonical package tools; registration starts no model call or workflow. Strict standalone typecheck and three session regression tests pass. Reload is required to replace the in-memory extension; repository edits do not update the installed user-skill checkout.
- `npm pack --dry-run` verifies that the production package excludes the retired engines. Nothing was published or committed.
- The catalog lists `minimax/MiniMax-M3` with credentials configured; its live API has not been tested in this migration. Real validated LibreOffice `.com` / Poppler discovery and a two-slide mechanical render smoke test pass. The smoke test uses mocked native UI only in disposable OFFLINE fixtures, zero model calls and no semantic QA or certified export; it never creates authority in the live workspace. The current session still exposes no new presenter helpers before reload, and no live agent-mode authority receipt exists.

The repository migration, adapter and real mechanical renderer checks pass. Live-session deployment, M3 orchestration, independent semantic/image QA and PDJE export remain unverified; they require reload and genuine native agent-mode approval. Repeat the real-render suite with: `powershell -NoProfile -Command '$env:PRESENTER_REAL_RENDER_TEST="1"; npm test; exit $LASTEXITCODE'`.
