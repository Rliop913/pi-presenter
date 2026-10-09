// OFFLINE bounds and fairness regressions; no live reference research.
import test from "node:test";
import assert from "node:assert/strict";
import {
    collectDesignReferences,
    parseHtml,
} from "../src/design-references.js";
import { DESIGN_REFERENCE_SITES } from "../src/reference-sites.js";
import { agents, contract, fixture } from "./fixtures.js";

test("selecting all six sites preserves a reference budget for each site", async (t) => {
    const f = await fixture();
    t.after(f.cleanup);
    const sites = DESIGN_REFERENCE_SITES.map((site) => site.id);
    await f.store.define({ ...contract, designReferenceSites: sites });
    await f.store.configure(agents);
    await f.store.approve(await f.store.fingerprint(), "Approve & Start");
    const references = await collectDesignReferences(
        f.store,
        sites,
        undefined,
        {
            transport: {
                fetch: async ({ url }) => {
                    const site = DESIGN_REFERENCE_SITES.find(
                        (site) => site.url === url,
                    )!;
                    const prefix =
                        site.id === "behance"
                            ? "/gallery/"
                            : site.id === "dribbble"
                              ? "/shots/"
                              : "/presentation/";
                    const links = Array.from(
                        { length: 40 },
                        (_, i) =>
                            `<a href="${prefix}design-${i}">Design ${i}</a>`,
                    ).join("");
                    return {
                        status: 200,
                        headers: { "content-type": "text/html" },
                        finalUrl: url,
                        body: Buffer.from(
                            `<title>${site.label}</title>${links}`,
                        ),
                    };
                },
            },
        },
    );
    assert.equal(references.failures.length, 0);
    assert.equal(references.references.length, 24);
    for (const site of sites)
        assert.equal(
            references.references.filter((ref) => ref.site === site).length,
            4,
        );
});

test("HTML5 parsing handles malformed tags without script execution and bounds input/anchor count", () => {
    const malformed =
        "<title>Public deck</title><script>" +
        "<script>".repeat(1000) +
        '</script><a href="/template">Safe</a>';
    assert.equal(parseHtml(malformed).title, "Public deck");
    assert.throws(() => parseHtml("x".repeat(512 * 1024 + 1)), /parsing limit/);
    assert.equal(
        parseHtml('<a href="/template">Safe</a>'.repeat(2500)).anchors.length,
        2000,
    );
});
