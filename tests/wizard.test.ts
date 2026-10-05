import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBrief, defaultContract, mergeBrief } from '../src/wizard.js';

test('parseBrief returns empty object for empty input', () => {
  assert.deepEqual(parseBrief(''), {});
});

test('parseBrief returns empty object for whitespace-only input', () => {
  assert.deepEqual(parseBrief('   \n\t  '), {});
});

test('parseBrief extracts a single Title field', () => {
  assert.deepEqual(parseBrief('Title: Q4 Review'), { title: 'Q4 Review' });
});

test('parseBrief extracts all seven known fields from a structured brief', () => {
  const text = `Title: Q4 Review
Purpose: Show progress to the board
Audience: Executive team
Duration: 15 minutes
Slides: 8
Output: presentation.pptx
Requirements: Match brand colors`;
  assert.deepEqual(parseBrief(text), {
    title: 'Q4 Review',
    purpose: 'Show progress to the board',
    audience: 'Executive team',
    duration: 15,
    slides: 8,
    output: 'presentation.pptx',
    requirements: 'Match brand colors',
  });
});

test('parseBrief is case-insensitive on keys', () => {
  const text = `TITLE: A
purpose: B
Audience: C
duration: 5
SLIDES: 3
Output: x.pptx
REQUIREMENTS: y`;
  assert.deepEqual(parseBrief(text), {
    title: 'A',
    purpose: 'B',
    audience: 'C',
    duration: 5,
    slides: 3,
    output: 'x.pptx',
    requirements: 'y',
  });
});

test('parseBrief tolerates a leading bullet (- or *)', () => {
  const text = `- Title: Foo
* Purpose: Bar`;
  assert.deepEqual(parseBrief(text), { title: 'Foo', purpose: 'Bar' });
});

test('parseBrief strips trailing whitespace from values', () => {
  assert.deepEqual(parseBrief('Title:   Hello World   '), { title: 'Hello World' });
});

test('parseBrief extracts duration as a number (stripping non-digits)', () => {
  assert.deepEqual(parseBrief('Duration: 15 minutes'), { duration: 15 });
  assert.deepEqual(parseBrief('Duration: 30 min'), { duration: 30 });
  assert.deepEqual(parseBrief('Duration: 45'), { duration: 45 });
});

test('parseBrief extracts slides as a number', () => {
  assert.deepEqual(parseBrief('Slides: 8'), { slides: 8 });
});

test('parseBrief ignores lines that do not match a known key', () => {
  const text = `Title: Foo
This is freeform prose that should be ignored.
Purpose: Bar
Another freeform line.`;
  assert.deepEqual(parseBrief(text), { title: 'Foo', purpose: 'Bar' });
});

test('parseBrief handles CRLF line endings', () => {
  const text = 'Title: A\r\nPurpose: B\r\nAudience: C';
  assert.deepEqual(parseBrief(text), { title: 'A', purpose: 'B', audience: 'C' });
});

test('parseBrief ignores lines with an empty value after the colon', () => {
  const text = `Title:
Purpose: Real purpose`;
  assert.deepEqual(parseBrief(text), { purpose: 'Real purpose' });
});

test('parseBrief handles values containing colons', () => {
  assert.deepEqual(parseBrief('Title: Foo: Bar'), { title: 'Foo: Bar' });
  assert.deepEqual(parseBrief('Output: path/to/file.pptx'), { output: 'path/to/file.pptx' });
});

test('parseBrief ignores non-integer duration values', () => {
  // Duration must be a non-negative integer; non-numeric values are dropped.
  assert.deepEqual(parseBrief('Duration: TBD'), {});
  assert.deepEqual(parseBrief('Duration: fifteen'), {});
});

test('parseBrief extracts the last occurrence when a key appears twice', () => {
  // Last-write-wins matches user intuition: the user re-pasted the field
  // to correct it.
  assert.deepEqual(parseBrief('Title: First\nTitle: Second'), { title: 'Second' });
});

test('parseBrief returns a copy of the parsed object (no shared state)', () => {
  const a = parseBrief('Title: A');
  const b = parseBrief('Title: B');
  assert.notEqual(a, b);
  assert.equal(a.title, 'A');
  assert.equal(b.title, 'B');
});

test('defaultContract returns sensible defaults for a single source', () => {
  const d = defaultContract(['Pilot Alpha recorded 100 requests. Beta recorded 200 requests.']);
  assert.equal(d.title, 'Pilot Alpha recorded 100 requests');
  assert.equal(d.purpose, 'Explain the topic to the audience using the supplied sources.');
  assert.equal(d.audience, 'General audience');
  assert.equal(d.durationMinutes, 10);
  assert.equal(d.slideCount, 3);
  assert.deepEqual(d.sources, ['Pilot Alpha recorded 100 requests. Beta recorded 200 requests.']);
  assert.equal(d.output, 'presentation.pptx');
  assert.equal(d.requirements, 'Editable widescreen slides, grounded in supplied sources.');
});

test('defaultContract derives title from the first sentence of the first source', () => {
  assert.equal(defaultContract(['First sentence. Second sentence.']).title, 'First sentence');
  assert.equal(defaultContract(['Only one sentence and nothing else']).title, 'Only one sentence and nothing else');
});

test('defaultContract truncates a long first sentence to 180 characters', () => {
  const longSentence = 'x'.repeat(300);
  const d = defaultContract([longSentence + '. rest']);
  assert.equal(d.title.length, 180);
  assert.ok(!d.title.endsWith(' '));
});

test('defaultContract falls back to "Untitled Presentation" when sources are empty', () => {
  assert.equal(defaultContract([]).title, 'Untitled Presentation');
  assert.equal(defaultContract(['']).title, 'Untitled Presentation');
  assert.equal(defaultContract(['   ']).title, 'Untitled Presentation');
});

test('defaultContract scales slide count with the number of sources (capped at 20)', () => {
  assert.equal(defaultContract(['a']).slideCount, 3);
  assert.equal(defaultContract(['a', 'b']).slideCount, 5);
  assert.equal(defaultContract(['a', 'b', 'c']).slideCount, 7);
  assert.equal(defaultContract(new Array(10).fill('x')).slideCount, 20);
  assert.equal(defaultContract(new Array(50).fill('x')).slideCount, 20);
});

test('mergeBrief uses defaults when the brief is empty', () => {
  const c = mergeBrief({}, ['some source']);
  const d = defaultContract(['some source']);
  assert.equal(c.title, d.title);
  assert.equal(c.purpose, d.purpose);
  assert.equal(c.audience, d.audience);
  assert.equal(c.durationMinutes, d.durationMinutes);
  assert.equal(c.slideCount, d.slideCount);
  assert.equal(c.output, d.output);
  assert.equal(c.requirements, d.requirements);
  assert.equal(c.maxRevisions, 2);
});

test('mergeBrief applies parsed values over defaults', () => {
  const c = mergeBrief({ title: 'Custom', duration: 30, slides: 12 }, ['x']);
  assert.equal(c.title, 'Custom');
  assert.equal(c.durationMinutes, 30);
  assert.equal(c.slideCount, 12);
  assert.equal(c.purpose, defaultContract(['x']).purpose);
});

test('mergeBrief silently falls back to defaults for invalid values', () => {
  // Duration: 999 is out of range (1-180); Slides: 0 is out of range (1-30);
  // empty title and audience are out of range (min 1); bad output path is
  // rejected by outputField; requirements too long (> 2000) is rejected.
  const tooLong = 'x'.repeat(2001);
  const c = mergeBrief({ title: '', audience: '', duration: 999, slides: 0, output: '/abs/path.pptx', requirements: tooLong }, ['x']);
  const d = defaultContract(['x']);
  assert.equal(c.title, d.title);
  assert.equal(c.audience, d.audience);
  assert.equal(c.durationMinutes, d.durationMinutes);
  assert.equal(c.slideCount, d.slideCount);
  assert.equal(c.output, d.output);
  assert.equal(c.requirements, d.requirements);
});

test('mergeBrief honors prior.maxRevisions when re-running the wizard', () => {
  const c = mergeBrief({}, ['x'], { maxRevisions: 5, title: 'old', purpose: 'old', audience: 'old', durationMinutes: 1, slideCount: 1, sources: ['x'], output: 'old.pptx', requirements: 'old' } as any);
  assert.equal(c.maxRevisions, 5);
  // Other fields use defaults, not the prior values; the user re-pastes in the brief.
  assert.equal(c.title, defaultContract(['x']).title);
});

test('mergeBrief always sets sources from the parameter, not the brief', () => {
  const c = mergeBrief({}, ['a', 'b', 'c']);
  assert.deepEqual(c.sources, ['a', 'b', 'c']);
});
