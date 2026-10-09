// OFFLINE network/security and pipeline integration regressions; no real sites/models.
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { LookupAddress, lookup } from "node:dns";
import type { request, RequestOptions } from "node:https";
import type { IncomingMessage } from "node:http";
import {
  collectDesignReferences,
  isPrivateOrReservedAddress,
  parseHtml,
  type DesignReferenceDI,
} from "../src/design-references.js";
import { agents, contract, fixture, MockPipeline } from "./fixtures.js";
import {
  contractWizard,
  approvalDialog,
  type DialogUI,
} from "../src/wizard.js";

async function selectedFixture() {
  const f = await fixture();
  await f.store.define({ ...contract, designReferenceSites: ["pptnest"] });
  await f.store.configure(agents);
  await f.store.approve(await f.store.fingerprint(), "Approve & Start");
  return f;
}
function networkHooks(
  addresses: LookupAddress[],
  responses: { status?: number; location?: string; body?: Buffer }[] = [],
) {
  const requests: RequestOptions[] = [];
  const lookups: string[] = [];
  const dns = ((
    host: string,
    _options: unknown,
    callback: (error: null, addresses: LookupAddress[]) => void,
  ) => {
    lookups.push(host);
    callback(null, addresses);
  }) as unknown as typeof lookup;
  const https = ((
    options: RequestOptions,
    callback: (res: IncomingMessage) => void,
  ) => {
    requests.push(options);
    const reply = responses.shift() ?? {};
    const req = Object.assign(new EventEmitter(), {
      end: () =>
        queueMicrotask(() => {
          const res = Object.assign(new EventEmitter(), {
            statusCode: reply.status ?? 200,
            headers: {
              "content-type": "text/html",
              ...(reply.location ? { location: reply.location } : {}),
            },
          });
          callback(res as unknown as IncomingMessage);
          res.emit(
            "data",
            reply.body ?? Buffer.from("<title>Design reference</title>"),
          );
          res.emit("end");
          req.emit("close");
        }),
      destroy: (err?: Error) => {
        if (err) req.emit("error", err);
        req.emit("close");
        return req;
      },
    });
    return req;
  }) as unknown as typeof request;
  return {
    requests,
    lookups,
    di: { dnsLookup: dns, httpsRequest: https } satisfies DesignReferenceDI,
  };
}
const publicAddress = [{ address: "8.8.8.8", family: 4 }];

test("secure transport rejects mixed public/private DNS before opening a socket", async (t) => {
  const f = await selectedFixture();
  t.after(f.cleanup);
  const hooks = networkHooks([
    ...publicAddress,
    { address: "127.0.0.1", family: 4 },
  ]);
  const result = await collectDesignReferences(
    f.store,
    ["pptnest"],
    undefined,
    hooks.di,
  );
  assert.equal(hooks.requests.length, 0);
  assert.match(result.failures[0].error, /non-public/);
});
test("secure transport pins a public address and revalidates same-site redirects", async (t) => {
  const f = await selectedFixture();
  t.after(f.cleanup);
  const hooks = networkHooks(publicAddress, [
    { status: 302, location: "https://pptnest.com/templates" },
    {},
  ]);
  const result = await collectDesignReferences(
    f.store,
    ["pptnest"],
    undefined,
    hooks.di,
  );
  assert.equal(result.failures.length, 0);
  assert.equal(hooks.requests.length, 2);
  assert.deepEqual(hooks.lookups, ["www.pptnest.com", "pptnest.com"]);
  assert.ok(hooks.requests.every((r) => r.host === "8.8.8.8"));
  assert.equal(hooks.requests[0].servername, "www.pptnest.com");
  assert.equal(hooks.requests[1].servername, "pptnest.com");
});
test("redirects cannot contact another allowed but unapproved reference site", async (t) => {
  const f = await selectedFixture();
  t.after(f.cleanup);
  const hooks = networkHooks(publicAddress, [
    { status: 302, location: "https://slides.wiki/" },
  ]);
  const result = await collectDesignReferences(
    f.store,
    ["pptnest"],
    undefined,
    hooks.di,
  );
  assert.equal(hooks.requests.length, 1);
  assert.deepEqual(hooks.lookups, ["www.pptnest.com"]);
  assert.match(result.failures[0].error, /outside approved site/);
});
test("secure transport limits redirect count and response bytes", async (t) => {
  const f = await selectedFixture();
  t.after(f.cleanup);
  const redirects = networkHooks(
    publicAddress,
    Array.from({ length: 5 }, () => ({ status: 302, location: "/again" })),
  );
  const result = await collectDesignReferences(
    f.store,
    ["pptnest"],
    undefined,
    redirects.di,
  );
  assert.equal(redirects.requests.length, 4);
  assert.match(result.failures[0].error, /Exceeded 3 redirects/);
  const huge = networkHooks(publicAddress, [
    { body: Buffer.alloc(512 * 1024 + 1) },
  ]);
  const limited = await collectDesignReferences(
    f.store,
    ["pptnest"],
    undefined,
    huge.di,
  );
  assert.equal(limited.references.length, 0);
  assert.match(limited.failures[0].error, /Exceeded.*bytes/);
});
test("user cancellation interrupts even stalled DNS and cannot become a success artifact", async (t) => {
  const f = await selectedFixture();
  t.after(f.cleanup);
  const controller = new AbortController();
  const pending = collectDesignReferences(
    f.store,
    ["pptnest"],
    controller.signal,
    {
      dnsLookup: (() => {}) as unknown as typeof lookup,
    },
  );
  const timer = setTimeout(
    () => controller.abort(new Error("test user cancellation")),
    10,
  );
  t.after(() => clearTimeout(timer));
  await assert.rejects(pending, /test user cancellation/);
});
test("reserved IP ranges and expanded IPv6 spellings fail closed", () => {
  for (const address of [
    "192.0.0.5",
    "192.0.2.1",
    "198.18.0.1",
    "198.51.100.1",
    "203.0.113.1",
    "0:0:0:0:0:0:0:1",
    "fe80:0:0:0:0:0:0:1",
    "2001:0000::1",
    "2002:c0a8:1::1",
    "3fff::1",
  ]) {
    assert.equal(isPrivateOrReservedAddress(address), true, address);
  }
  assert.equal(isPrivateOrReservedAddress("2001:4860:4860::8888"), false);
});
test("Open Graph metadata and invalid Unicode entities are parsed without throwing", () => {
  const parsed = parseHtml(
    '<title>Deck</title><meta property="og:description" content="A &amp; B"><a href="/templates/a">&#x110000; &#55296;</a>',
  );
  assert.equal(parsed.description, "A & B");
  assert.equal(parsed.anchors.length, 1);
});
test("long titles remain bounded and duplicate/credential/port links are not collected", async (t) => {
  const f = await selectedFixture();
  t.after(f.cleanup);
  const html =
    `<title>${"T".repeat(280)}</title>` +
    '<a href="/templates/a">A</a><a href="/templates/a">Again</a>' +
    '<a href="https://user@www.pptnest.com/templates/b">Credential</a>' +
    '<a href="https://www.pptnest.com:8443/templates/c">Port</a>';
  const result = await collectDesignReferences(
    f.store,
    ["pptnest"],
    undefined,
    networkHooks(publicAddress, [{ body: Buffer.from(html) }]).di,
  );
  assert.equal(result.references.length, 2);
  assert.ok(result.references.every((r) => r.title.length <= 280));
});
test("empty JavaScript-only pages are reported unavailable rather than invented inspiration", async (t) => {
  const f = await selectedFixture();
  t.after(f.cleanup);
  const hooks = networkHooks(publicAddress, [
    { body: Buffer.from('<div id="app"></div><script>start()</script>') },
  ]);
  const result = await collectDesignReferences(
    f.store,
    ["pptnest"],
    undefined,
    hooks.di,
  );
  assert.equal(result.references.length, 0);
  assert.match(result.failures[0].error, /No readable reference metadata/);
});
test("cached references reach design roles only and are required for export without refetch", async (t) => {
  const f = await selectedFixture();
  t.after(f.cleanup);
  f.registry.failVisual = 1;
  const references = {
    references: [
      {
        site: "pptnest",
        url: "https://www.pptnest.com/templates/a",
        title: "OFFLINE reference",
        description: "Untrusted design inspiration",
      },
    ],
    failures: [],
  };
  await f.store.artifact("design/references.json", references);
  const pipeline = new MockPipeline(f.store);
  await pipeline.run();
  await pipeline.export();
  const art = f.registry.calls.find((c) =>
    JSON.stringify(c.context.messages[0]).includes("Pi Presenter's art_director."),
  )!;
  assert.ok(JSON.stringify(art.context).includes("OFFLINE reference"));
  const evidence = f.registry.calls.find((c) =>
    JSON.stringify(c.context.messages[0]).includes("Pi Presenter's evidence_researcher."),
  )!;
  assert.ok(!JSON.stringify(evidence.context).includes("OFFLINE reference"));
  delete f.store.checkpoint.artifacts["design/references.json"];
  await f.store.save();
  await assert.rejects(() => pipeline.export(), /Workspace is incomplete/);
});
test("wizard network opt-in is explicit, cancellable and visible in full matrix approval", async (t) => {
  const ui: DialogUI = {
    input: async () => "PDJE brief",
    select: async () => "Use all six reference sites",
    notify: () => {},
  };
  const configured = await contractWizard(ui);
  assert.equal(configured?.designReferenceSites?.length, 6);
  assert.equal(
    await contractWizard({ ...ui, select: async () => undefined }),
    undefined,
  );
  const f = await fixture(false);
  t.after(f.cleanup);
  await f.store.define({ ...contract, designReferenceSites: ["pptnest"] });
  await f.store.configure(agents);
  let title = "";
  await approvalDialog(
    {
      ...ui,
      select: async (s) => {
        title = s;
        return "Cancel";
      },
    },
    f.store,
  );
  assert.match(title, /https:\/\/www\.pptnest\.com\//);
  assert.match(title, /no brief\/source text is uploaded/);
  assert.equal(f.store.checkpoint.approval, undefined);
  assert.equal(f.registry.calls.length, 0);
});
