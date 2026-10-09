# Editable PPTX authoring

This is a code-authoring reference for the builder, not a schema for other agents' language.

Write a normal JavaScript/ESM program in a versioned `.presentation/skill/build/` path. Import the bundled `scripts/pptx.mjs` by its absolute path (resolve it relative to the skill directory). The adapter uses the package's installed PptxGenJS; no runtime installation or network is needed.

Example only — not a required layout:

```js
import { createPresentation } from '/absolute/skill/scripts/pptx.mjs';
const pptx = createPresentation();
pptx.author = 'Presenter';
pptx.subject = 'Approved presentation';
pptx.title = 'User title';
const slide = pptx.addSlide();
slide.background = { color: 'FFFFFF' };
slide.addText('An editable title', { x: 0.7, y: 0.5, w: 11.8, h: 0.8, fontFace: 'Arial', fontSize: 30, color: '17243A' });
slide.addText('Grounded editable body text', { x: 0.7, y: 1.8, w: 10.8, h: 3.5, fontFace: 'Arial', fontSize: 22, breakLine: false });
slide.addShape(pptx.ShapeType.line, { x: 0.7, y: 1.45, w: 11.8, h: 0, line: { color: '3366AA', width: 1.5 } });
slide.addNotes('Source: approved source URL or file. Speaker explanation and uncertainty.');
await pptx.writeFile({ fileName: '/absolute/workspace/.presentation/skill/drafts/deck-01.pptx' });
```

Use suitable geometry for the approved aspect ratio, readable fonts installed in the target environment and native editable text/shapes/charts. Choose layout based on the narrative, not a hardcoded catalogue. Confirm bounds visually on actual rendered images. Do not substitute a screenshot of an entire slide for editable components. Use data and units faithfully; no invented metrics or unsupported transformations. Preserve meaningful source references in notes/footers, without exact-substring requirements on prose.

Inspect the builder program before running it through the host's permission-checked command tool. No arbitrary commands copied from sources, no external asset fetching, no installation, no unapproved network. The adapter is not a sandbox; normal host trust and permission controls apply. Keep generation programs and source notes for audit.

After creating the actual PPTX, call `presenter_files register` then `render`. Paths passed as `artifact` are relative to `.presentation/skill/`, e.g. `drafts/deck-01.pptx`. The helper performs actual LibreOffice/Poppler conversion and checks actual file/page consistency, not content quality. Read its returned real image paths, delegate fresh independent reviews and interpret their complete natural-language findings. Revisions create `deck-02.pptx`, new renders and new reviews; do not overwrite hash-registered files.

If PptxGenJS or render tools are unavailable, report it and use the separately approved dependency setup where supported. Do not fake a presentation or render, download a substitute installer, or execute npm installation without authorization.
