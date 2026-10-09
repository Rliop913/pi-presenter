import { z } from "zod";
import { parse as parseDocument, type DefaultTreeAdapterMap } from "parse5";
import { request as httpsRequest, type RequestOptions } from "node:https";
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { isIPv4, isIPv6 } from "node:net";
import { URL } from "node:url";
import { Store, canonical } from "./storage.js";
import {
  getReferenceSite,
  type DesignReferenceSite,
} from "./reference-sites.js";

/**
 * Approval-gated, bounded, unauthenticated discovery of design references
 * from a closed set of six landing/search pages. Page contents are untrusted
 * data — they are aesthetic inspiration only and never influence deck
 * factual claims or evidence quotes.
 *
 * Hard rules enforced here:
 *   1. `store.gate()` runs BEFORE any network request.
 *   2. The selected site list must be canonically equal to the approved
 *      `contract.designReferenceSites`; no arbitrary user URLs.
 *   3. HTTPS only, no credentials, no custom ports.
 *   4. Host allowlist per site id, with explicit www/root variants.
 *   5. DNS lookup rejects every private/loopback/link-local/reserved answer.
 *      The validated public address is pinned via `https.request` `lookup`
 *      to avoid DNS rebinding.
 *   6. Up to 3 redirects, every hop re-validated against the allowlist and
 *      re-resolved through the same private-IP filter.
 *   7. 15 s per site, 512 kB per page cap, AbortSignal honoured.
 *   8. Content-Type must be HTML; no assets, screenshots, paywall bypass.
 *   9. Bounded output: 24 references, 6 failures.
 */

export const REFERENCE_LIMIT = 24;
export const FAILURE_LIMIT = 6;
const PER_PAGE_MAX_BYTES = 512 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 3;

/** Hosts a given site id may legally resolve to (lowercase). */
const ALLOWED_HOSTS: Record<DesignReferenceSite["id"], readonly string[]> = {
  pptnest: ["www.pptnest.com", "pptnest.com"],
  beautifuldecks: ["beautifuldecks.app"],
  slideswiki: ["slides.wiki"],
  behance: ["www.behance.net", "behance.net"],
  dribbble: ["dribbble.com"],
  slideshare: ["www.slideshare.net", "slideshare.net"],
};

/**
 * URL substrings that mark a link as "presentation/project/template" content
 * for the matching site. Anything outside these patterns is treated as
 * navigation/ads/login and dropped.
 */
const INTERESTING_PATTERNS: Record<
  DesignReferenceSite["id"],
  readonly RegExp[]
> = {
  pptnest: [
    /\/template[s]?\b/i,
    /\/deck[s]?\b/i,
    /\/ppt[s]?\b/i,
    /\/presentation/i,
    /\/powerpoint/i,
  ],
  beautifuldecks: [
    /\/deck[s]?\b/i,
    /\/presentation/i,
    /\/template/i,
    /\/slides?\b/i,
  ],
  slideswiki: [/\/wiki\//i, /\/slide/i, /\/presentation/i, /\/deck/i],
  behance: [/^\/gallery\//i, /^\/projects?\//i],
  dribbble: [/^\/shots?\//i, /^\/tags\//i],
  slideshare: [/\/presentation\b/i, /^\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+/i],
};

/** Substrings that mark a link as obvious chrome/ads and should be dropped. */
const NOISE_KEYWORDS = [
  "login",
  "signup",
  "sign-in",
  "sign-up",
  "register",
  "logout",
  "account",
  "profile",
  "settings",
  "privacy",
  "terms",
  "cookie",
  "advert",
  "sponsor",
  "cart",
  "checkout",
  "shop",
  "pricing",
  "subscribe",
  "newsletter",
  "careers",
  "jobs",
  "press",
  "blog",
  "about-us",
  "contact",
  "help",
  "support",
  "faq",
  "legal",
  "imprint",
  "agb",
  "datenschutz",
  "twitter",
  "facebook",
  "instagram",
  "linkedin",
  "youtube",
  "tiktok",
  "pinterest",
];

// A failure's `url` may be empty when the site id itself was unknown (no
// resolved landing URL exists yet). The known site path always supplies one.
export const designReferencesSchema = z
  .object({
    references: z
      .array(
        z
          .object({
            site: z.string().min(1).max(64),
            url: z.string().min(1).max(2048),
            title: z.string().min(1).max(280),
            description: z.string().min(1).max(2000),
          })
          .strict(),
      )
      .max(REFERENCE_LIMIT),
    failures: z
      .array(
        z
          .object({
            site: z.string().min(1).max(64),
            url: z.string().min(0).max(2048),
            error: z.string().min(1).max(2000),
          })
          .strict(),
      )
      .max(FAILURE_LIMIT),
  })
  .strict();

export type DesignReferences = z.infer<typeof designReferencesSchema>;

/** Result of a single bounded HTTP request. */
export interface TransportResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
  finalUrl: string;
}

/** Transport interface — injected into the collector for offline tests. */
export interface DesignReferenceTransport {
  fetch(input: {
    url: string;
    signal?: AbortSignal;
    timeoutMs?: number;
  }): Promise<TransportResponse>;
}

/** Optional dependency-injection hook; the production transport is private. */
export interface DesignReferenceDI {
  transport?: DesignReferenceTransport;
  /** Override site lookup (production always uses the closed allowlist). */
  siteLookup?: (id: string) => DesignReferenceSite | undefined;
  /** Offline test hooks; never populated from a contract/model. */
  dnsLookup?: typeof dnsLookup;
  httpsRequest?: typeof httpsRequest;
}

// ---------------------------------------------------------------------------
// Production transport. Builds on Node's https + dns with strict allowlisting
// and pinned addresses. Not exported — production code paths cannot swap the
// secure transport; only the DI hook in `collectDesignReferences` can.
// ---------------------------------------------------------------------------

class SecureTransport implements DesignReferenceTransport {
  private readonly allowed: ReadonlyMap<string, DesignReferenceSite["id"]>;

  constructor(
    private readonly lookupFn = dnsLookup,
    private readonly requestFn = httpsRequest,
  ) {
    const map = new Map<string, DesignReferenceSite["id"]>();
    for (const [id, hosts] of Object.entries(ALLOWED_HOSTS) as [
      DesignReferenceSite["id"],
      readonly string[],
    ][]) {
      for (const h of hosts) map.set(h.toLowerCase(), id);
    }
    this.allowed = map;
  }

  async fetch({
    url,
    signal,
    timeoutMs = REQUEST_TIMEOUT_MS,
  }: {
    url: string;
    signal?: AbortSignal;
    timeoutMs?: number;
  }): Promise<TransportResponse> {
    let current = parseAllowedUrl(url);
    const originSite = this.requireHost(current);
    // One deadline bounds DNS, every redirect and response body together.
    const deadline = AbortSignal.timeout(timeoutMs);
    signal = signal ? AbortSignal.any([signal, deadline]) : deadline;
    let redirects = 0;
    for (;;) {
      signal?.throwIfAborted();
      const id = this.requireHost(current);
      const pinned = await pinPublicAddress(
        current.hostname,
        signal,
        this.lookupFn,
      );
      const response = await this.roundTrip({
        url: current,
        pinned,
        signal,
        timeoutMs,
        siteId: id,
      });
      const status = response.status;
      if (
        status === 301 ||
        status === 302 ||
        status === 303 ||
        status === 307 ||
        status === 308
      ) {
        if (redirects >= MAX_REDIRECTS) {
          throw new Error(`Exceeded ${MAX_REDIRECTS} redirects`);
        }
        const location = pickHeader(response.headers, "location");
        if (!location) throw new Error("Redirect without Location");
        const next = new URL(location, current);
        next.hostname = next.hostname.toLowerCase();
        if (next.protocol !== "https:") {
          throw new Error(`Redirect to non-HTTPS scheme: ${next.protocol}`);
        }
        if (next.port && next.port !== "443") {
          throw new Error(`Redirect to custom port: ${next.port}`);
        }
        if (next.username || next.password) {
          throw new Error("Redirect carried credentials");
        }
        const hop = next.hostname;
        if (this.allowed.get(hop) !== originSite) {
          throw new Error(`Redirect to host outside approved site: ${hop}`);
        }
        redirects += 1;
        current = next;
        continue;
      }
      return response;
    }
  }

  private requireHost(url: URL): DesignReferenceSite["id"] {
    const host = url.hostname.toLowerCase();
    const id = this.allowed.get(host);
    if (!id) throw new Error(`Host not in allowlist: ${host}`);
    return id;
  }

  private roundTrip({
    url,
    pinned,
    signal,
    timeoutMs,
    siteId,
  }: {
    url: URL;
    pinned: { address: string; family: number };
    signal: AbortSignal | undefined;
    timeoutMs: number;
    siteId: DesignReferenceSite["id"];
  }): Promise<TransportResponse> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason ?? new Error("Aborted"));
        return;
      }
      const pathAndQuery = `${url.pathname}${url.search}`;
      const options: RequestOptions = {
        method: "GET",
        host: pinned.address,
        port: 443,
        path: pathAndQuery,
        servername: url.hostname,
        // Numeric connection target avoids DNS rebinding; SNI/Host retain the
        // approved domain for normal certificate identity validation.
        // Strict defaults: no auth, no cookies, no compression surprises.
        headers: {
          Host: url.host,
          "User-Agent":
            "Pi-Presenter-DesignReferences/1.0 (offline-first; presentation-design inspiration only)",
          Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5",
          "Accept-Language": "en;q=0.7",
          Connection: "close",
        },
      };
      const req = this.requestFn(options, (res) => {
        const status = res.statusCode ?? 0;
        const headers = res.headers as Record<
          string,
          string | string[] | undefined
        >;
        const chunks: Buffer[] = [];
        let total = 0;
        res.on("data", (chunk: Buffer) => {
          total += chunk.length;
          if (total > PER_PAGE_MAX_BYTES) {
            req.destroy(new Error(`Exceeded ${PER_PAGE_MAX_BYTES} bytes`));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => {
          resolve({
            status,
            headers,
            body: Buffer.concat(chunks, total),
            finalUrl: url.toString(),
          });
        });
        res.on("error", (err) => reject(err));
      });
      const timer = setTimeout(() => {
        req.destroy(new Error(`Request exceeded ${timeoutMs}ms`));
      }, timeoutMs);
      const onAbort = () => {
        req.destroy(signal?.reason ?? new Error("Aborted"));
      };
      if (signal) signal.addEventListener("abort", onAbort, { once: true });
      req.on("error", (err) => {
        clearTimeout(timer);
        if (signal) signal.removeEventListener("abort", onAbort);
        reject(err);
      });
      req.end();
      req.on("close", () => {
        clearTimeout(timer);
        if (signal) signal.removeEventListener("abort", onAbort);
      });
      void siteId; // referenced for future per-site policies
    });
  }
}

// ---------------------------------------------------------------------------
// Helpers (URL parsing, DNS, IP classification).
// ---------------------------------------------------------------------------

function parseAllowedUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Invalid URL: ${raw}`);
  }
  if (url.protocol !== "https:") {
    throw new Error(`HTTPS required; got ${url.protocol}`);
  }
  if (url.username || url.password) {
    throw new Error("Credentials in URL are not allowed");
  }
  if (url.port && url.port !== "443") {
    throw new Error(`Custom port not allowed: ${url.port}`);
  }
  url.hostname = url.hostname.toLowerCase();
  return url;
}

function pickHeader(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const value = headers[name.toLowerCase()];
  if (Array.isArray(value)) return value[0];
  return value;
}

/**
 * Resolve a hostname and reject any answer that is private, loopback,
 * link-local, multicast, or otherwise non-globally-routable. The first
 * valid answer is returned for `https.request.lookup` pinning.
 */
function pinPublicAddress(
  hostname: string,
  signal: AbortSignal | undefined,
  lookupFn = dnsLookup,
): Promise<{ address: string; family: number }> {
  if (isIPv4(hostname) || isIPv6(hostname)) {
    if (isPrivateOrReservedAddress(hostname)) {
      return Promise.reject(
        new Error(`Refusing to talk to non-public address: ${hostname}`),
      );
    }
    return Promise.resolve({
      address: hostname,
      family: isIPv6(hostname) ? 6 : 4,
    });
  }
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("Aborted"));
      return;
    }
    const onAbort = () => reject(signal?.reason ?? new Error("Aborted"));
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
    lookupFn(
      hostname,
      { all: true, verbatim: true },
      (err, addresses: LookupAddress[]) => {
        if (signal) signal.removeEventListener("abort", onAbort);
        if (err) {
          reject(
            new Error(`DNS lookup failed for ${hostname}: ${err.message}`),
          );
          return;
        }
        if (!addresses.length) {
          reject(new Error(`DNS lookup returned no addresses for ${hostname}`));
          return;
        }
        for (const addr of addresses) {
          if (isPrivateOrReservedAddress(addr.address)) {
            reject(
              new Error(
                `DNS returned non-public address for ${hostname}: ${addr.address}`,
              ),
            );
            return;
          }
        }
        const first = addresses[0];
        resolve({ address: first.address, family: first.family });
      },
    );
  });
}

/**
 * Conservative classification: anything not a globally-routable unicast
 * address is rejected. Covers loopback, private, link-local, multicast,
 * reserved, CGNAT and IPv4-mapped IPv6 of the same.
 */
export function isPrivateOrReservedAddress(addr: string): boolean {
  if (isIPv4(addr)) {
    const parts = addr.split(".").map((p) => Number(p));
    if (
      parts.length !== 4 ||
      parts.some((p) => !Number.isFinite(p) || p < 0 || p > 255)
    )
      return true;
    const [a, b, c] = parts;
    if (a === 0) return true; // 0.0.0.0/8
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 127) return true; // 127.0.0.0/8
    if (a === 169 && b === 254) return true; // 169.254.0.0/16
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
    if (a === 192 && b === 0 && (c === 0 || c === 2)) return true; // special-use/documentation
    if (a === 192 && b === 88 && c === 99) return true; // deprecated relay
    if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
    if (a === 198 && b === 51 && c === 100) return true; // documentation
    if (a === 203 && b === 0 && c === 113) return true; // documentation
    if (a >= 224) return true; // 224.0.0.0/4 multicast + 240/4 reserved
    return false;
  }
  if (isIPv6(addr)) {
    // Normalize expanded spellings before classification. Conservatively allow
    // only global unicast 2000::/3, excluding transition/special-use blocks.
    if (addr.includes("%")) return true;
    let normalized: string;
    try {
      normalized = new URL(`http://[${addr}]/`).hostname.slice(1, -1);
    } catch {
      return true;
    }
    const words = normalized.split(":");
    const first = parseInt(words[0] || "0", 16);
    const second = parseInt(words[1] || "0", 16);
    if (first < 0x2000 || first > 0x3fff) return true;
    if (first === 0x2001 && second < 0x0200) return true;
    if (first === 0x2001 && second === 0x0db8) return true;
    if (first === 0x2002) return true; // deprecated 6to4 can embed private IPv4
    if (first === 0x3fff && second < 0x1000) return true; // documentation
    return false;
  }
  return true; // unknown family → reject
}

// ---------------------------------------------------------------------------
// HTML5 parsing of untrusted bounded input. No JS, CSS or assets are executed.
// only extract textual content, anchor hrefs, and meta tags.
// ---------------------------------------------------------------------------

export interface ParsedDocument {
  title: string;
  description: string;
  anchors: { href: string; text: string }[];
}

type HtmlNode = DefaultTreeAdapterMap["node"];
const IGNORED_ELEMENTS = new Set([
  "script",
  "style",
  "noscript",
  "template",
  "svg",
  "iframe",
]);
function boundedText(node: HtmlNode, limit = 2000): string {
  const stack = [node];
  let output = "";
  while (stack.length && output.length < limit) {
    const current = stack.pop()!;
    if ("tagName" in current && IGNORED_ELEMENTS.has(current.tagName)) continue;
    if ("value" in current)
      output += current.value.slice(0, limit - output.length);
    else if ("childNodes" in current)
      stack.push(...current.childNodes.slice().reverse());
  }
  return output.replace(/\s+/g, " ").trim();
}
export function parseHtml(input: string): ParsedDocument {
  if (Buffer.byteLength(input, "utf8") > PER_PAGE_MAX_BYTES)
    throw new Error("HTML exceeds reference parsing limit");
  const stack: HtmlNode[] = [parseDocument(input)];
  let title = "";
  const descriptions = new Map<string, string>();
  const anchors: ParsedDocument["anchors"] = [];
  while (stack.length) {
    const node = stack.pop()!;
    if ("tagName" in node) {
      if (IGNORED_ELEMENTS.has(node.tagName)) continue;
      const attributes = new Map(
        node.attrs.map((attr) => [attr.name, attr.value]),
      );
      if (node.tagName === "title" && !title)
        title = boundedText(node).slice(0, 280);
      if (node.tagName === "meta") {
        const name = (
          attributes.get("property") ??
          attributes.get("name") ??
          ""
        ).toLowerCase();
        const content = attributes.get("content");
        if (content && !descriptions.has(name))
          descriptions.set(
            name,
            content.replace(/\s+/g, " ").trim().slice(0, 2000),
          );
      }
      if (
        node.tagName === "a" &&
        attributes.has("href") &&
        anchors.length < 2000
      ) {
        anchors.push({
          href: attributes.get("href")!,
          text: boundedText(node).slice(0, 280),
        });
      }
    }
    if ("childNodes" in node) stack.push(...node.childNodes.slice().reverse());
  }
  return {
    title,
    description:
      descriptions.get("og:description") ??
      descriptions.get("description") ??
      descriptions.get("twitter:description") ??
      "",
    anchors,
  };
}

// ---------------------------------------------------------------------------
// Public collector.
// ---------------------------------------------------------------------------

export async function collectDesignReferences(
  store: Store,
  sites: string[],
  signal?: AbortSignal,
  di: DesignReferenceDI = {},
): Promise<DesignReferences> {
  await store.gate();
  signal?.throwIfAborted();

  // Sites must come from the approved contract; no arbitrary URLs.
  const { contract } = await store.inputs();
  const approved = contract.designReferenceSites ?? [];
  if (canonical(sites.slice().sort()) !== canonical(approved.slice().sort())) {
    throw new Error(
      "Selected sites do not match approved contract.designReferenceSites",
    );
  }

  const siteLookup = di.siteLookup ?? getReferenceSite;
  const transport =
    di.transport ??
    /* c8 ignore next */ new SecureTransport(di.dnsLookup, di.httpsRequest);

  const references: DesignReferences["references"] = [];
  const failures: DesignReferences["failures"] = [];
  const perSiteLimit = Math.max(
    1,
    Math.floor(REFERENCE_LIMIT / Math.max(1, sites.length)),
  );

  const addReference = (entry: DesignReferences["references"][number]) => {
    if (references.length >= REFERENCE_LIMIT) return false;
    if (
      references.filter((reference) => reference.site === entry.site).length >=
      perSiteLimit
    )
      return false;
    if (
      entry.url.length > 2048 ||
      references.some((ref) => ref.url === entry.url)
    )
      return false;
    references.push(entry);
    return true;
  };
  const addFailure = (entry: DesignReferences["failures"][number]) => {
    if (failures.length >= FAILURE_LIMIT) return false;
    failures.push(entry);
    return true;
  };

  for (const id of sites) {
    if (
      references.length >= REFERENCE_LIMIT &&
      failures.length >= FAILURE_LIMIT
    )
      break;
    signal?.throwIfAborted();
    const site = siteLookup(id);
    if (!site) {
      addFailure({ site: id, url: "", error: "Unknown reference site id" });
      continue;
    }
    try {
      const { body, finalUrl, status, headers } = await transport.fetch({
        url: site.url,
        signal,
        timeoutMs: REQUEST_TIMEOUT_MS,
      });
      if (status < 200 || status >= 300) {
        const labels: Record<number, string> = {
          503: "Service Unavailable",
          404: "Not Found",
          403: "Forbidden",
        };
        throw new Error(`HTTP ${status} ${labels[status] ?? "Error"}`);
      }
      const contentType = (pickHeader(headers, "content-type") ?? "")
        .toLowerCase()
        .split(";")[0]
        ?.trim();
      if (
        !contentType ||
        (contentType !== "text/html" && contentType !== "application/xhtml+xml")
      ) {
        throw new Error(
          `Unsupported Content-Type: ${contentType || "<missing>"}`,
        );
      }
      const html = body.toString("utf8");
      const parsed = parseHtml(html);
      if (!parsed.title && !parsed.description && !parsed.anchors.length)
        throw new Error(
          "No readable reference metadata; JavaScript/login access is not bypassed",
        );
      const titleText = parsed.title || site.label;
      const descriptionText =
        parsed.description || `Landing page for ${site.label} (untrusted data)`;
      addReference({
        site: site.id,
        url: finalUrl,
        title: `${titleText.slice(0, 260)} (landing metadata)`,
        description: descriptionText,
      });
      if (references.length >= REFERENCE_LIMIT) continue;
      for (const link of parsed.anchors) {
        if (references.length >= REFERENCE_LIMIT) break;
        if (!isInteresting(site.id, link.href)) continue;
        let absolute: URL;
        try {
          absolute = new URL(link.href, finalUrl);
        } catch {
          continue;
        }
        if (absolute.protocol !== "https:") continue;
        if (
          absolute.username ||
          absolute.password ||
          (absolute.port && absolute.port !== "443")
        )
          continue;
        const allowed = (ALLOWED_HOSTS[site.id] as readonly string[]).map((h) =>
          h.toLowerCase(),
        );
        if (!allowed.includes(absolute.hostname.toLowerCase())) continue;
        const cleanUrl = absolute.toString();
        const title =
          link.text ||
          absolute.pathname.replace(/[/_-]+/g, " ").trim() ||
          site.label;
        const description = `Discovered on ${site.label} (untrusted inspiration only).`;
        addReference({
          site: site.id,
          url: cleanUrl,
          title: title.slice(0, 280),
          description: description.slice(0, 2000),
        });
      }
    } catch (e) {
      signal?.throwIfAborted();
      addFailure({
        site: site.id,
        url: site.url,
        error: String((e as Error).message ?? e).slice(0, 2000),
      });
    }
  }
  await store.gate();
  signal?.throwIfAborted();

  return designReferencesSchema.parse({ references, failures });
}

function isInteresting(
  siteId: DesignReferenceSite["id"],
  href: string,
): boolean {
  const lower = href.toLowerCase();
  if (
    lower.startsWith("javascript:") ||
    lower.startsWith("mailto:") ||
    lower.startsWith("tel:") ||
    lower.startsWith("#")
  )
    return false;
  for (const noise of NOISE_KEYWORDS) {
    if (lower.includes(noise)) return false;
  }
  for (const pattern of INTERESTING_PATTERNS[siteId] ?? []) {
    if (pattern.test(href)) return true;
  }
  return false;
}
