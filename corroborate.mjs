// Signal Flow — independent corroboration for design-press items (Oct 2026).
// Kristen: ArchDaily items only count if what they describe is ALSO reported by at least two other
// credible outlets. Design-showcase sites mostly republish architects' press kits, so they say a
// project exists, not that anything is changing. This module asks Claude (with live web search)
// to find independent coverage and returns the outlets it found.
//
// Credible = established news organisations, trade press with editorial standards, official /
// government records, or peer-reviewed journals. NOT counted: other design-showcase sites, the
// architect's / developer's / brand's own channels, press-release wires, social media, Wikipedia,
// or anything that is clearly a copy of the same press kit.
export const NEEDS_CORROBORATION = /(^|\.)archdaily\.(com|cn|mx|com\.br)/i;
const SHOWCASE = /superfuture|gooood|architectsdiary|abirpothi|casadevalentina|archdaily|dezeen|designboom|architizer|archello|divisare|archdaily|yankodesign|inhabitat|designwanted|amazingarchitecture|world-architects|e-architect|arquitecturaviva|plataformaarquitectura|leibal|contemporist|homeadore|prnewswire|businesswire|globenewswire|wikipedia|instagram|linkedin|facebook|x\.com|twitter/i;

const SYS = `You verify signals for a strategic-foresight library. Given an item first reported by a design-showcase website, use web search to find INDEPENDENT coverage of the same specific project, event or development by credible outlets: established news organisations, trade press with editorial standards, official/government records, or peer-reviewed journals.
Do NOT count: design-showcase or design-lifestyle sites (ArchDaily, Dezeen, Designboom, Architizer, Archello, Divisare, Superfuture, gooood, etc.), the architect's/developer's/brand's own website or channels, industry associations or award programmes promoting the project, personal or lifestyle blogs, press-release wires, social media, Wikipedia, or pages that merely copy the same press kit. When in doubt, do not count it.
It must be the same specific thing (same project/place/organisation), not just the general topic.
Search efficiently. Then reply with ONLY this JSON (no prose):
{"outlets":[{"name":"outlet name","url":"https://..."}],"note":"max 20 words"}
List only outlets you actually found in search results; an empty list is a valid answer.`;

export async function corroborate(item, { apiKey, model, maxUses = 4 } = {}) {
  const user = `Item: ${item.title}\nWhat it says: ${item.shift || item.evidence || ""}\nOriginal URL: ${item.url}\nDate: ${item.date || "unknown"}`;
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model, max_tokens: 2000, system: SYS, tools: [{ type: "web_search_20250305", name: "web_search", max_uses: maxUses }], messages: [{ role: "user", content: user }] }),
  });
  if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = await res.json();
  // Only trust URLs that actually appeared in the web-search results, so the model can't invent outlets.
  const host0 = (u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; } };
  const seenHosts = new Set();
  for (const b of j.content || []) if (b.type === "web_search_tool_result" && Array.isArray(b.content)) for (const r of b.content) if (r.url) seenHosts.add(host0(r.url));
  const text = (j.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
  let parsed = { outlets: [] };
  try { parsed = JSON.parse((text.match(/\{[\s\S]*\}/) || ["{}"])[0]); } catch {}
  const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; } };
  const byHost = new Map();
  for (const o of parsed.outlets || []) {
    const u = String(o.url || "").replace(/[#?].*$/, "").replace(/\/+$/, "");
    const h = host(u);
    if (!h || SHOWCASE.test(h) || host(item.url) === h) continue;
    if (!seenHosts.has(h)) continue;          // outlet never appeared in the actual search results → ignore
    if (!byHost.has(h)) byHost.set(h, { name: o.name || h, url: o.url });
  }
  const outlets = [...byHost.values()];
  return { ok: outlets.length >= 2, outlets, note: parsed.note || "" };
}
