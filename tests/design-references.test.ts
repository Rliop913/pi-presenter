// OFFLINE tests for the design-references collector. The DI transport
// replaces real HTTPS / DNS so nothing on the network is exercised here.
import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  DESIGN_REFERENCE_SITES,
  getReferenceSite,
  type DesignReferenceSite,
} from "../src/reference-sites.js";
import {
  collectDesignReferences,
  designReferencesSchema,
  isPrivateOrReservedAddress,
  parseHtml,
  REFERENCE_LIMIT,
  FAILURE_LIMIT,
  type DesignReferenceTransport,
  type TransportResponse,
} from "../src/design-references.js";
import { Store } from "../src/storage.js";
import { MockRegistry, agents, sourceText } from "./fixtures.js";

function baseContract() {
  return {
    description: "",
    title: "Pilot findings",
    purpose: "Explain the pilot",
    audience: "Team",
    durationMinutes: 10,
    slideCount: 2,
    sources: [sourceText],
    output: "export/deck.pptx",
    requirements: "Editable grounded slides",
    maxRevisions: 2,
  };
}

async function freshStore() {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pi-presenter-dr-"));
  const registry = new MockRegistry();
  const store = new Store(cwd, registry);
  return {
    cwd,
    registry,
    store,
    cleanup: () => fs.rm(cwd, { recursive: true, force: true }),
  };
}

async function approvedStore(sites: DesignReferenceSite["id"][]) {
  const f = await freshStore();
  await f.store.define({ ...baseContract(), designReferenceSites: sites });
  await f.store.configure(agents);
  await f.store.approve(await f.store.fingerprint(), "Approve & Start");
  return f;
}

function fakeResponse(
  url: string,
  body: string,
  headers: Record<string, string> = {},
  status = 200,
): TransportResponse {
  return {
    status,
    headers: { "content-type": "text/html; charset=utf-8", ...headers },
    body: Buffer.from(body, "utf8"),
    finalUrl: url,
  };
}

class RecordingTransport implements DesignReferenceTransport {
  calls: { url: string; timeoutMs: number | undefined }[] = [];
  constructor(
    private readonly handler: (
      url: string,
    ) => TransportResponse | Promise<TransportResponse>,
  ) {}
  async fetch({
    url,
    timeoutMs,
  }: {
    url: string;
    signal?: AbortSignal;
    timeoutMs?: number;
  }): Promise<TransportResponse> {
    this.calls.push({ url, timeoutMs });
    return await this.handler(url);
  }
}

const LANDING_HTML = (
  label: string,
  anchors: { href: string; text: string }[] = [],
) =>
  `<!doctype html>
<html><head>
<title>${label} – design inspiration</title>
<meta name="description" content="${label} curated presentation designs.">
</head><body>
<header><a href="/login">Log in</a><a href="/about-us">About</a></header>
${anchors.map((a) => `<a href="${a.href}">${a.text}</a>`).join("\n")}
</body></html>`;

// ---------------------------------------------------------------------------
// Schema + helpers
// ---------------------------------------------------------------------------

test("designReferencesSchema rejects more than 24 references", () => {
  const overflow = Array.from({ length: 25 }, (_, i) => ({
    site: "pptnest",
    url: `https://www.pptnest.com/x${i}`,
    title: `T${i}`,
    description: "D",
  }));
  assert.throws(() =>
    designReferencesSchema.parse({ references: overflow, failures: [] }),
  );
});

test("designReferencesSchema rejects more than 6 failures", () => {
  const overflow = Array.from({ length: 7 }, () => ({
    site: "pptnest",
    url: "https://www.pptnest.com/",
    error: "boom",
  }));
  assert.throws(() =>
    designReferencesSchema.parse({ references: [], failures: overflow }),
  );
});

test("designReferencesSchema rejects unknown extra fields (strict)", () => {
  assert.throws(() =>
    designReferencesSchema.parse({
      references: [],
      failures: [],
      extra: true,
    } as never),
  );
});

test("REFERENCE_LIMIT and FAILURE_LIMIT are the documented caps", () => {
  assert.equal(REFERENCE_LIMIT, 24);
  assert.equal(FAILURE_LIMIT, 6);
});

test("DESIGN_REFERENCE_SITES has exactly six ids in the expected order", () => {
  assert.deepEqual(
    DESIGN_REFERENCE_SITES.map((s) => s.id),
    [
      "pptnest",
      "beautifuldecks",
      "slideswiki",
      "behance",
      "dribbble",
      "slideshare",
    ],
  );
  for (const site of DESIGN_REFERENCE_SITES) {
    assert.ok(site.url.startsWith("https://"));
    assert.ok(getReferenceSite(site.id));
  }
});

test("getReferenceSite returns undefined for unknown ids", () => {
  assert.equal(getReferenceSite("not-a-site"), undefined);
  assert.equal(getReferenceSite(""), undefined);
});

// ---------------------------------------------------------------------------
// Preapproval / approval gate
// ---------------------------------------------------------------------------

test("preapproval: collectDesignReferences rejects with zero network calls", async (t) => {
  const f = await freshStore();
  t.after(f.cleanup);
  const transport = new RecordingTransport(() => {
    throw new Error("transport should not be called preapproval");
  });
  await assert.rejects(
    () =>
      collectDesignReferences(f.store, ["pptnest"], undefined, {
        transport,
      }),
    /Approve/,
  );
  assert.equal(transport.calls.length, 0);
});

test("selected sites that differ from the approved contract are rejected (no network)", async (t) => {
  const f = await approvedStore(["pptnest"]);
  t.after(f.cleanup);
  const transport = new RecordingTransport(() => {
    throw new Error("transport should not be called for unapproved sites");
  });
  await assert.rejects(
    () =>
      collectDesignReferences(f.store, ["pptnest", "behance"], undefined, {
        transport,
      }),
    /do not match/,
  );
  assert.equal(transport.calls.length, 0);
});

test("selected sites in different order are canonically equal to the approved contract (no network)", async (t) => {
  const f = await approvedStore(["pptnest", "behance"]);
  t.after(f.cleanup);
  const transport = new RecordingTransport(() => {
    throw new Error("transport should not be called for permuted sites");
  });
  // Order is irrelevant; canonical comparison is order-independent.
  const result = await collectDesignReferences(
    f.store,
    ["behance", "pptnest"],
    undefined,
    { transport },
  );
  assert.equal(result.references.length, 0);
  assert.equal(result.failures.length, 2);
  // The mock transport is configured to never be reached because every
  // fetch call would be a network call. Each site is added as a failure
  // because the mock throws.
  assert.equal(transport.calls.length, 2);
});

test("empty site list is accepted when contract.designReferenceSites is also empty", async (t) => {
  const f = await approvedStore([]);
  t.after(f.cleanup);
  const transport = new RecordingTransport(() => {
    throw new Error("transport should not be called for empty list");
  });
  const result = await collectDesignReferences(f.store, [], undefined, {
    transport,
  });
  assert.deepEqual(result.references, []);
  assert.deepEqual(result.failures, []);
  assert.equal(transport.calls.length, 0);
});

// ---------------------------------------------------------------------------
// Transport errors → failures recorded
// ---------------------------------------------------------------------------

test("transport errors are recorded as failures and the schema still validates", async (t) => {
  const f = await approvedStore(["pptnest", "behance"]);
  t.after(f.cleanup);
  const transport = new RecordingTransport((url) => {
    if (url.includes("pptnest"))
      return fakeResponse(url, LANDING_HTML("PPTNest"));
    throw new Error("DNS lookup failed for www.behance.net: ENOTFOUND");
  });
  const result = await collectDesignReferences(
    f.store,
    ["pptnest", "behance"],
    undefined,
    {
      transport,
    },
  );
  assert.equal(result.references.length, 1);
  assert.equal(result.references[0]?.site, "pptnest");
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0]?.site, "behance");
  assert.match(result.failures[0]?.error ?? "", /DNS lookup failed/);
});

test("failures array is capped at FAILURE_LIMIT", async (t) => {
  const f = await approvedStore([
    "pptnest",
    "beautifuldecks",
    "slideswiki",
    "behance",
    "dribbble",
    "slideshare",
  ]);
  t.after(f.cleanup);
  const transport = new RecordingTransport(() => {
    throw new Error("network down");
  });
  const result = await collectDesignReferences(
    f.store,
    [
      "pptnest",
      "beautifuldecks",
      "slideswiki",
      "behance",
      "dribbble",
      "slideshare",
    ],
    undefined,
    { transport },
  );
  assert.equal(result.failures.length, FAILURE_LIMIT);
  assert.equal(result.references.length, 0);
});

test("unknown site id (rejected by the DI lookup) is recorded as a failure", async (t) => {
  const f = await approvedStore(["pptnest", "behance"]);
  t.after(f.cleanup);
  // Behance is unknown to the DI lookup, so transport.fetch must never be
  // called for it. The pptnest site is recognised and the mock returns a
  // valid HTML response for it.
  const transport = new RecordingTransport((url) =>
    fakeResponse(url, LANDING_HTML("PPTNest")),
  );
  const result = await collectDesignReferences(
    f.store,
    ["pptnest", "behance"],
    undefined,
    {
      transport,
      siteLookup: (id) =>
        id === "pptnest" ? getReferenceSite("pptnest") : undefined,
    },
  );
  assert.equal(result.references.length, 1);
  assert.equal(result.references[0]?.site, "pptnest");
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0]?.site, "behance");
  assert.match(result.failures[0]?.error ?? "", /Unknown/);
  // The transport was only called for the recognised site, never for the
  // unknown id.
  assert.equal(transport.calls.length, 1);
  assert.ok(transport.calls[0]!.url.includes("pptnest"));
});

// ---------------------------------------------------------------------------
// Content-Type and abort
// ---------------------------------------------------------------------------

test("non-HTML content-type is rejected and recorded as a failure", async (t) => {
  const f = await approvedStore(["pptnest"]);
  t.after(f.cleanup);
  const transport = new RecordingTransport((url) => ({
    status: 200,
    headers: { "content-type": "application/json" },
    body: Buffer.from('{"hello":"world"}'),
    finalUrl: url,
  }));
  const result = await collectDesignReferences(
    f.store,
    ["pptnest"],
    undefined,
    {
      transport,
    },
  );
  assert.equal(result.references.length, 0);
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0]?.error ?? "", /Content-Type/);
});

test("missing content-type header is rejected", async (t) => {
  const f = await approvedStore(["pptnest"]);
  t.after(f.cleanup);
  const transport = new RecordingTransport((url) => ({
    status: 200,
    headers: {},
    body: Buffer.from("<html><body>oops</body></html>"),
    finalUrl: url,
  }));
  const result = await collectDesignReferences(
    f.store,
    ["pptnest"],
    undefined,
    {
      transport,
    },
  );
  assert.equal(result.references.length, 0);
  assert.equal(result.failures.length, 1);
});

test("HTTP error responses are recorded as failures (no fake ref)", async (t) => {
  const f = await approvedStore(["pptnest"]);
  t.after(f.cleanup);
  const transport = new RecordingTransport((url) => ({
    status: 503,
    headers: { "content-type": "text/html" },
    body: Buffer.from("down"),
    finalUrl: url,
  }));
  const result = await collectDesignReferences(
    f.store,
    ["pptnest"],
    undefined,
    {
      transport,
    },
  );
  assert.equal(result.references.length, 0);
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0]?.error ?? "", /503/);
});

test("AbortSignal rejection is propagated and recorded as a failure", async (t) => {
  const f = await approvedStore(["pptnest"]);
  t.after(f.cleanup);
  const controller = new AbortController();
  controller.abort(new Error("cancelled by test"));
  const transport = new RecordingTransport(async () => {
    controller.signal.throwIfAborted();
    return fakeResponse("https://www.pptnest.com/", LANDING_HTML("PPTNest"));
  });
  await assert.rejects(
    () =>
      collectDesignReferences(f.store, ["pptnest"], controller.signal, {
        transport,
      }),
    /cancelled by test/,
  );
});

test("collector-level abort after a successful fetch is honoured before the next site", async (t) => {
  const f = await approvedStore(["pptnest", "behance"]);
  t.after(f.cleanup);
  const controller = new AbortController();
  let fetched = 0;
  const transport: DesignReferenceTransport = {
    async fetch({ url }) {
      fetched += 1;
      // Abort right after the first fetch resolves, before the next
      // iteration's `signal.throwIfAborted()` runs.
      if (fetched === 1) {
        controller.abort(new Error("stop after first"));
      }
      return fakeResponse(url, LANDING_HTML("X"));
    },
  };
  await assert.rejects(
    () =>
      collectDesignReferences(
        f.store,
        ["pptnest", "behance"],
        controller.signal,
        {
          transport,
        },
      ),
    /stop after first/,
  );
});

// ---------------------------------------------------------------------------
// Limits (references cap)
// ---------------------------------------------------------------------------

test("references array is capped at REFERENCE_LIMIT even with many interesting links", async (t) => {
  const f = await approvedStore(["pptnest"]);
  t.after(f.cleanup);
  const anchors = Array.from({ length: 50 }, (_, i) => ({
    href: `https://www.pptnest.com/templates/awesome-deck-${i}`,
    text: `Deck ${i}`,
  }));
  const transport = new RecordingTransport((url) =>
    fakeResponse(url, LANDING_HTML("PPTNest", anchors)),
  );
  const result = await collectDesignReferences(
    f.store,
    ["pptnest"],
    undefined,
    { transport },
  );
  // 1 landing metadata + as many interesting links as fit up to REFERENCE_LIMIT
  assert.equal(result.references.length, REFERENCE_LIMIT);
  assert.equal(result.failures.length, 0);
});

// ---------------------------------------------------------------------------
// HTML parser: entity decoding, script stripping, anchor + meta extraction
// ---------------------------------------------------------------------------

test("parseHtml decodes HTML entities and strips script/style/noscript/template", () => {
  const html = `
    <html>
      <head>
        <title>Foo &amp; Bar &lt;Design&gt;</title>
        <meta name="description" content="Inspiration &quot;hub&quot; for designers &mdash; free &amp; paid">
        <script>const evil = "<a href='javascript:alert(1)'>click</a>";</script>
        <style>body::before { content: "<a>foo</a>"; }</style>
      </head>
      <body>
        <a href="/templates/cool-deck">Cool &amp; Useful deck</a>
        <a href="/login">Sign in</a>
        <a href="javascript:alert(1)">Run js</a>
        <noscript>old text <a href="/x">noscript</a></noscript>
      </body>
    </html>
  `;
  const doc = parseHtml(html);
  assert.equal(doc.title, "Foo & Bar <Design>");
  assert.equal(
    doc.description,
    'Inspiration "hub" for designers \u2014 free & paid',
  );
  // Only the legitimate anchor survives; script/style/noscript bodies were stripped
  assert.equal(doc.anchors.length, 3);
  assert.deepEqual(
    doc.anchors.map((a) => a.href),
    ["/templates/cool-deck", "/login", "javascript:alert(1)"],
  );
  // Anchor text is entity-decoded and whitespace-collapsed
  const cool = doc.anchors.find((a) => a.href === "/templates/cool-deck");
  assert.equal(cool?.text, "Cool & Useful deck");
});

test("parseHtml handles named entities and numeric character references", () => {
  const html = `<title>A&nbsp;B&hellip;&copy;</title><meta name="description" content="&#39;hi&#39; &#x26; bye">`;
  const doc = parseHtml(html);
  assert.equal(doc.title, "A B\u2026\u00a9");
  assert.equal(doc.description, "'hi' & bye");
});

test("parseHtml leaves an empty document alone", () => {
  const doc = parseHtml("<html><body></body></html>");
  assert.equal(doc.title, "");
  assert.equal(doc.description, "");
  assert.equal(doc.anchors.length, 0);
});

// ---------------------------------------------------------------------------
// Link filtering rules
// ---------------------------------------------------------------------------

test("noise keywords (login, about, blog, etc.) drop links; presentation templates survive", async (t) => {
  const f = await approvedStore(["pptnest"]);
  t.after(f.cleanup);
  const transport = new RecordingTransport((url) =>
    fakeResponse(
      url,
      LANDING_HTML("PPTNest", [
        { href: "/templates/cool-deck", text: "Cool deck" },
        { href: "/login", text: "Sign in" },
        { href: "/about-us", text: "About" },
        { href: "/blog/post-1", text: "Blog post" },
        { href: "/decks/sales-pitch", text: "Sales pitch deck" },
      ]),
    ),
  );
  const result = await collectDesignReferences(
    f.store,
    ["pptnest"],
    undefined,
    { transport },
  );
  const kept = result.references.map((r) => r.url);
  assert.ok(kept.some((u) => u.endsWith("/templates/cool-deck")));
  assert.ok(kept.some((u) => u.endsWith("/decks/sales-pitch")));
  assert.ok(!kept.some((u) => u.includes("/login")));
  assert.ok(!kept.some((u) => u.includes("/about-us")));
  assert.ok(!kept.some((u) => u.includes("/blog/")));
});

test("anchors pointing off the allowlisted hosts are dropped", async (t) => {
  const f = await approvedStore(["pptnest"]);
  t.after(f.cleanup);
  const transport = new RecordingTransport((url) =>
    fakeResponse(
      url,
      LANDING_HTML("PPTNest", [
        { href: "https://www.pptnest.com/templates/x", text: "x" },
        { href: "https://malicious.example.com/track", text: "tracker" },
        { href: "http://www.pptnest.com/templates/insecure", text: "insecure" },
      ]),
    ),
  );
  const result = await collectDesignReferences(
    f.store,
    ["pptnest"],
    undefined,
    { transport },
  );
  const urls = result.references.map((r) => r.url);
  assert.ok(urls.some((u) => u.startsWith("https://www.pptnest.com/")));
  assert.ok(!urls.some((u) => u.includes("malicious.example.com")));
  assert.ok(!urls.some((u) => u.startsWith("http://")));
});

test("landing page metadata is marked as landing only, never as factual claim", async (t) => {
  const f = await approvedStore(["pptnest"]);
  t.after(f.cleanup);
  const transport = new RecordingTransport((url) =>
    fakeResponse(url, LANDING_HTML("PPTNest")),
  );
  const result = await collectDesignReferences(
    f.store,
    ["pptnest"],
    undefined,
    { transport },
  );
  assert.equal(result.references.length, 1);
  assert.match(result.references[0]?.title ?? "", /landing metadata/);
  assert.match(result.references[0]?.description ?? "", /Landing page|curated/);
});

// ---------------------------------------------------------------------------
// DNS / address classification
// ---------------------------------------------------------------------------

test("isPrivateOrReservedAddress flags private, loopback, link-local, multicast, reserved", () => {
  // IPv4 private / loopback / link-local
  assert.equal(isPrivateOrReservedAddress("10.0.0.1"), true);
  assert.equal(isPrivateOrReservedAddress("172.16.5.4"), true);
  assert.equal(isPrivateOrReservedAddress("172.31.255.255"), true);
  assert.equal(isPrivateOrReservedAddress("192.168.1.1"), true);
  assert.equal(isPrivateOrReservedAddress("127.0.0.1"), true);
  assert.equal(isPrivateOrReservedAddress("127.255.255.254"), true);
  assert.equal(isPrivateOrReservedAddress("169.254.0.1"), true);
  // CGNAT
  assert.equal(isPrivateOrReservedAddress("100.64.0.1"), true);
  assert.equal(isPrivateOrReservedAddress("100.127.255.254"), true);
  // Reserved / multicast
  assert.equal(isPrivateOrReservedAddress("0.0.0.0"), true);
  assert.equal(isPrivateOrReservedAddress("224.0.0.1"), true);
  assert.equal(isPrivateOrReservedAddress("255.255.255.255"), true);
  // Public addresses
  assert.equal(isPrivateOrReservedAddress("8.8.8.8"), false);
  assert.equal(isPrivateOrReservedAddress("1.1.1.1"), false);
  // IPv6
  assert.equal(isPrivateOrReservedAddress("::1"), true);
  assert.equal(isPrivateOrReservedAddress("::"), true);
  assert.equal(isPrivateOrReservedAddress("fe80::1"), true);
  assert.equal(isPrivateOrReservedAddress("fc00::1"), true);
  assert.equal(isPrivateOrReservedAddress("ff02::1"), true);
  assert.equal(isPrivateOrReservedAddress("2001:db8::1"), true);
  assert.equal(isPrivateOrReservedAddress("::ffff:127.0.0.1"), true);
  // Public IPv6
  assert.equal(isPrivateOrReservedAddress("2606:4700:4700::1111"), false);
  // Garbage
  assert.equal(isPrivateOrReservedAddress("not-an-ip"), true);
  assert.equal(isPrivateOrReservedAddress("999.0.0.1"), true);
});

// ---------------------------------------------------------------------------
// Production secure transport: URL validation rules
// ---------------------------------------------------------------------------

// The production SecureTransport is the only way to verify HTTPS, port,
// credentials, and host allowlist rejection. We do NOT inject a transport
// here, so the production code path runs; every failure here occurs at
// URL parsing or host allowlist checking — both happen BEFORE any DNS
// lookup or network I/O.
test("production SecureTransport rejects malformed URLs and off-allowlist hosts without network", async (t) => {
  const cases: Array<{ url: string; expect: RegExp }> = [
    { url: "http://www.pptnest.com/", expect: /HTTPS/ },
    { url: "https://www.pptnest.com:8443/", expect: /Custom port/ },
    { url: "https://user:pass@www.pptnest.com/", expect: /Credentials/ },
    { url: "https://malicious.example.com/", expect: /allowlist/i },
  ];
  for (const c of cases) {
    const f = await freshStore();
    t.after(f.cleanup);
    await f.store.define({
      ...baseContract(),
      designReferenceSites: ["pptnest"],
    });
    await f.store.configure(agents);
    await f.store.approve(await f.store.fingerprint(), "Approve & Start");
    const site: DesignReferenceSite = {
      id: "pptnest",
      label: "test",
      url: c.url,
    };
    const result = await collectDesignReferences(
      f.store,
      ["pptnest"],
      undefined,
      {
        siteLookup: (id) => (id === "pptnest" ? site : undefined),
      },
    );
    assert.equal(result.references.length, 0);
    assert.equal(result.failures.length, 1);
    assert.match(result.failures[0]?.error ?? "", c.expect);
  }
});

// ---------------------------------------------------------------------------
// End-to-end: pipeline integration is no-op when no sites selected
// ---------------------------------------------------------------------------

test("collector returns empty result without touching transport for empty approved list", async (t) => {
  const f = await approvedStore([]);
  t.after(f.cleanup);
  const transport = new RecordingTransport(() => {
    throw new Error("transport should not run when sites=[]");
  });
  const result = await collectDesignReferences(f.store, [], undefined, {
    transport,
  });
  assert.deepEqual(result, { references: [], failures: [] });
  assert.equal(transport.calls.length, 0);
});
