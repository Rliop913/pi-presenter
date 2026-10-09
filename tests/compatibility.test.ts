// OFFLINE regressions; model responses and rendering are mocked, not a real M3 deck.
import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/storage.js";
import { evidenceSchema } from "../src/schema.js";
import { fallbackEvidence } from "../src/evidence.js";
import {
  agents,
  board,
  contract,
  deck,
  fixture,
  MockPipeline,
  sourceText,
} from "./fixtures.js";

test("description-only wizard contract completes and exports with matching source provenance", async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  f.registry.failVisual = 1;
  await f.store.define({ ...contract, description: sourceText, sources: [] });
  await f.store.configure(agents);
  await f.store.approve(await f.store.fingerprint(), "Approve & Start");
  const pipeline = new MockPipeline(f.store);
  await pipeline.run();
  assert.equal(f.store.checkpoint.state, "COMPLETE");
  await pipeline.export();
});

test("empty model evidence is persisted canonically before downstream claims and resume", async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  f.registry.failVisual = 1;
  const expected = fallbackEvidence(f.sources);
  const slides = board.slides.map((s) => ({
    ...s,
    claimIds: ["claim_fallback"],
  }));
  f.registry.responseOverride = (system) => {
    if (system.includes("Task: Extract")) return {};
    if (system.includes("Task: Create a logical"))
      return {
        thesis: "Explain the source",
        sections: [
          {
            title: "Source evidence",
            claimIds: ["claim_fallback"],
            rationale: "Ground the narrative",
          },
        ],
      };
    if (system.includes("Task: Create exactly")) return { slides };
    if (system.includes("Task: Produce fixed"))
      return {
        slides: slides.map((s, i) => ({
          id: s.id,
          title: s.title,
          claimIds: s.claimIds,
          layout: deck.slides[i].layout,
        })),
      };
    return undefined;
  };
  const pipeline = new MockPipeline(f.store);
  await pipeline.run();
  assert.deepEqual(
    await f.store.read("evidence/evidence.json", evidenceSchema),
    expected,
  );
  assert.deepEqual(
    await f.store.read("evidence/claims.json", evidenceSchema.shape.claims),
    expected.claims,
  );
  await pipeline.export();
  const calls = f.registry.calls.length;
  const restored = new Store(f.cwd, f.registry);
  await restored.load();
  await new MockPipeline(restored).run();
  assert.equal(f.registry.calls.length, calls);
});

test("resume after a rendering interruption reuses the validated cached visual specification", async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  f.registry.failVisual = 1;
  class InterruptedPipeline extends MockPipeline {
    protected override async renderDeck(): Promise<never> {
      throw new Error("test rendering interruption");
    }
  }
  await assert.rejects(
    () => new InterruptedPipeline(f.store).run(),
    /test rendering interruption/,
  );
  const restored = new Store(f.cwd, f.registry);
  await restored.load();
  await new MockPipeline(restored).run();
  assert.equal(restored.checkpoint.state, "COMPLETE");
  assert.equal(
    f.registry.calls.filter((c) =>
      JSON.stringify(c.context.messages[0]).includes("Task: Produce fixed"),
    ).length,
    1,
  );
});
