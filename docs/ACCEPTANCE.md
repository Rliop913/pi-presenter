# Release acceptance checklist

Implementation tests and live production acceptance are separate gates.

## Safety gate (offline automated tests)

- Cancel setup at every dialog: zero presentation model calls and zero compiler calls.
- Invoke run, resume, review and export without approval: reject without side effects.
- Confirm the displayed complete role × provider/model × effort matrix using **Approve & Start**.
- Change presentation inputs or any assignment: invalidate prior approval and downstream artifacts.
- Remove a selected model from discovery, remove image capability, or remove an effort level: stop; never substitute or clamp.
- Corrupt approved configuration, persisted checkpoints or output artifacts: stop or require a validated rebuild; never export stale output.
- Parallel operations cannot race configuration or run state.

## Artifact and production gate

- Every storyboard claim references the evidence database and a locatable source.
- The visual reviewer receives actual rendered slide images, not just a deck specification.
- Missing LibreOffice or Poppler is an actionable failure, not a successful mocked render.
- Failed review leads to a bounded patch of nominated slide specifications only; unaffected specifications remain unchanged.
- Compilation is deterministic in layout and content. Byte reproducibility needs a separate ZIP metadata test.
- Export requires the latest successful factual and visual review of the exact current deck.

## Live acceptance (requires user input and approval)

1. Install the packed package into an isolated Pi project and load `/presenter`.
2. Supply a real research source, audience, duration and slide target.
3. Select authenticated models with supported efforts and image input for the visual reviewer.
4. Review all assignments and explicitly approve. Record approved manifest and usage.
5. Complete research → narrative → design → compile → render → review.
6. Open the PPTX in PowerPoint or LibreOffice; check editability, citations, clipping and chart numbers.
7. Interrupt a run and verify safe resume. Edit assignments and verify renewed approval is mandatory.
8. Publish only after these checks and npm account/package ownership verification.

Mock integration tests do not satisfy live acceptance. No npm publication or live model-based deck is implied by passing offline tests.
