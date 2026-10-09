/**
 * Closed allowlist of design reference sites. The collector only ever talks
 * to one of these six landing/search pages and only after the user explicitly
 * approved the matching ids in the presentation contract. No arbitrary URLs.
 */
export interface DesignReferenceSite {
  readonly id:
    | "pptnest"
    | "beautifuldecks"
    | "slideswiki"
    | "behance"
    | "dribbble"
    | "slideshare";
  readonly label: string;
  /** Canonical landing or search page; the collector pins to this exact URL. */
  readonly url: string;
}

export const DESIGN_REFERENCE_SITES: readonly DesignReferenceSite[] = [
  {
    id: "pptnest",
    label: "PPTNest",
    url: "https://www.pptnest.com/",
  },
  {
    id: "beautifuldecks",
    label: "Beautiful Decks",
    url: "https://beautifuldecks.app/",
  },
  {
    id: "slideswiki",
    label: "Slides.wiki",
    url: "https://slides.wiki/",
  },
  {
    id: "behance",
    label: "Behance (presentation design)",
    url: "https://www.behance.net/search/projects/presentation%20design",
  },
  {
    id: "dribbble",
    label: "Dribbble (presentation design)",
    url: "https://dribbble.com/tags/presentation-design",
  },
  {
    id: "slideshare",
    label: "SlideShare",
    url: "https://www.slideshare.net/",
  },
] as const;

export const DESIGN_REFERENCE_SITE_IDS: readonly DesignReferenceSite["id"][] =
  DESIGN_REFERENCE_SITES.map((s) => s.id);

const SITES_BY_ID = new Map(
  DESIGN_REFERENCE_SITES.map((s) => [s.id, s] as const),
);

export function getReferenceSite(id: string): DesignReferenceSite | undefined {
  return SITES_BY_ID.get(id as DesignReferenceSite["id"]);
}
