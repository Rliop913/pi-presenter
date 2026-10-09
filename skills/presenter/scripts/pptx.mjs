// Library adapter only. No prompt parsing, model calls, fixed slide schema or QA decisions.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
export const PptxGenJS = require('pptxgenjs');
export function createPresentation() {
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_WIDE';
  return pptx;
}
