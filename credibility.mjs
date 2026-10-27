// Signal Flow — source credibility rules (Oct 2026). Kristen: "obscure non-credible journals are a no."
// Used by scan.mjs (drop at intake) and retriage.mjs (clean up what already reached Notion).
// Preprint servers and low-credibility "journal" hosts that kept reaching the library via HN/OpenAlex.
export const NONCREDIBLE = ["researchsquare.com", "preprints.org", "qeios.com", "zenodo.org", "ijisrt.com", "irejournals.com", "ijireeice.com", "iarjset.com", "ijsrcseit.com", "ijsrset.com", "ijraset.com", "jetir.org", "ijcrt.org", "ijfmr.com", "wjarr.com", "gsconlinepress.com", "ijsr.net", "papers.ssrn.com", "philpapers.org", "academia.edu", "researchgate.net", "scirp.org", "iiardjournals.org", "doi.org/10.32628", "doi.org/10.38124", "doi.org/10.21203", "doi.org/10.20944", "doi.org/10.32388", "doi.org/10.5281", "doi.org/10.56201"];

const PREPRINT_SOURCES = /research square|preprints\.org|qeios|zenodo|ssrn|philpapers|academia\.edu|researchgate/i;
export const isNonCredibleUrl = (normUrl) => NONCREDIBLE.some((d) => normUrl.startsWith(d) || normUrl.includes("." + d));
export const isNonCredibleSource = (name = "") => PREPRINT_SOURCES.test(name);

// OpenAlex lookup for DOIs: credible only if the venue is in OpenAlex's CORE set.
export async function openalexCore(dois) {
  const out = new Map();
  for (let i = 0; i < dois.length; i += 40) {
    const chunk = dois.slice(i, i + 40);
    const u = `https://api.openalex.org/works?filter=doi:${chunk.map((d) => encodeURIComponent(d)).join("|")}&per-page=50&select=doi,primary_location`;
    try {
      const j = await (await fetch(u, { headers: { "user-agent": "signal-flow (personal foresight tool)" } })).json();
      for (const w of j.results || []) out.set(String(w.doi).toLowerCase(), { core: !!w.primary_location?.source?.is_core, venue: w.primary_location?.source?.display_name || "unknown venue" });
    } catch (e) { console.error("  openalex lookup failed: " + e.message); }
    await new Promise((r) => setTimeout(r, 1200));
  }
  return out;
}
