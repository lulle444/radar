/* Launch Radar: the newest tokens on Robinhood Chain and Base, refreshed every minute. */
(function(){
"use strict";
const REFRESH = 60 * 1000;
const NAMES = {robinhood: "Robinhood Chain", base: "Base"};
const GT_NET = {robinhood: null, base: "base"};

const $ = id => document.getElementById(id);
const set = (id, v) => { const el = $(id); if (el) el.textContent = v; };
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const usd = v => {
  if (v == null || !isFinite(v)) return "–";
  const a = Math.abs(v);
  if (a >= 1e9) return "$" + (v/1e9).toFixed(2) + "B";
  if (a >= 1e6) return "$" + (v/1e6).toFixed(a >= 1e8 ? 0 : 1) + "M";
  if (a >= 1e3) return "$" + (v/1e3).toFixed(a >= 1e5 ? 0 : 1) + "k";
  return "$" + v.toFixed(0);
};
const pct = v => v == null || !isFinite(v) ? "–" : Math.round(v * 100) + "%";
const chg = v => v == null || !isFinite(v) ? "–" : (v > 0 ? "+" : v < 0 ? "−" : "") + Math.abs(v).toFixed(Math.abs(v) < 10 ? 1 : 0) + "%";
const age = t => {
  if (!t) return "–";
  const m = Math.max(0, (Date.now() - Date.parse(t)) / 60000);
  if (m < 60) return Math.floor(m) + "m";
  if (m < 1440) return Math.floor(m / 60) + "h";
  return Math.floor(m / 1440) + "d";
};
const short = a => a ? a.slice(0, 6) + "…" + a.slice(-4) : "";

const params = new URLSearchParams(location.search);
const state = {
  chain: NAMES[params.get("chain")] ? params.get("chain") : "robinhood",
  data: null, open: null, seen: new Set(), first: true,
};

async function load(){
  const chain = state.chain;
  try {
    const r = await fetch("/api/launches?chain=" + chain, {headers: {accept: "application/json"}});
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || "HTTP " + r.status);
    if (chain !== state.chain) return;
    const fresh = new Set();
    if (!state.first) for (const l of j.launches) if (!state.seen.has(l.token)) fresh.add(l.token);
    j.launches.forEach(l => state.seen.add(l.token));
    state.first = false;
    state.data = j; state.fresh = fresh;
    if (j.network) GT_NET[chain] = j.network;
    $("dot").className = "dot on";
    const at = new Date(j.updatedAt || Date.now());
    set("status", "Live · " + at.toLocaleTimeString([], {hour: "2-digit", minute: "2-digit"}));
    set("updated", "Updated " + at.toLocaleString([], {dateStyle: "medium", timeStyle: "short"}));
    render();
  } catch (e) {
    if (chain !== state.chain) return;
    $("dot").className = "dot off";
    set("status", "Data unavailable");
    if (!state.data) $("rows").innerHTML = `<tr><td colspan="9" class="empty">Launch data couldn’t be loaded right now. It will retry in a minute.</td></tr>`;
  }
}

function filtered(){
  const minLiq = +$("minLiq").value, pads = $("padsOnly").checked, hide = $("hideHigh").checked;
  const q = $("q").value.trim().toLowerCase();
  return state.data.launches.filter(l =>
    (l.liquidity || 0) >= minLiq && (!pads || l.launchpad) && (!hide || l.risk.band !== "high") &&
    (!q || `${l.symbol} ${l.name} ${l.token} ${l.dex}`.toLowerCase().includes(q)));
}

function renderTiles(){
  const all = state.data.launches;
  const pads = all.filter(l => l.launchpad), high = all.filter(l => l.risk.band === "high");
  set("tCount", all.length);
  const day = all.filter(l => l.createdAt && Date.now() - Date.parse(l.createdAt) < 864e5).length;
  set("tCountSub", `${day} in the last 24 hours`);
  set("tPads", pads.length);
  const names = [...new Set(pads.map(l => l.dex))].slice(0, 3).join(", ");
  set("tPadsSub", names || "None recognised yet");
  set("tHigh", high.length);
  const checked = all.filter(l => l.checked).length;
  set("tHighSub", `of ${all.length}; holders checked for ${checked}`);
  set("tVol", usd(all.reduce((s, l) => s + (l.vol24h || 0), 0)));
  set("tVolSub", "Across these new pools");
}

function riskPill(r){ return `<span class="risk ${r.band}">${r.value}<span class="sr"> out of 100, ${r.band} risk</span></span>`; }

function detail(l){
  const ex = state.data.explorer, net = GT_NET[state.chain];
  const reasons = l.risk.reasons.filter(x => x.pts > 0);
  return `<tr class="detail"><td colspan="9"><div class="det">
    <div>
      <h3>Why it scores ${l.risk.value}</h3>
      ${reasons.length ? `<ul>${reasons.map(x => `<li><b>+${x.pts}</b> ${esc(x.text)}</li>`).join("")}</ul>` : `<p class="muted">${l.checked ? "Nothing stands out." : "Holders haven’t been checked for this token yet; only pool data counts so far."}</p>`}
    </div>
    <dl>
      <dt>Contract</dt><dd class="mono">${esc(short(l.token))}</dd>
      <dt>Deployer</dt><dd class="mono">${l.dev ? `<a href="${esc(ex)}/address/${esc(l.dev)}" target="_blank" rel="noopener">${esc(short(l.dev))}</a>` : "–"}</dd>
      <dt>Holders</dt><dd>${l.holders ?? "–"}</dd>
      <dt>In the pool</dt><dd>${pct(l.inPool)}</dd>
      <dt>In other contracts</dt><dd>${pct(l.inContracts)}</dd>
      <dt>Burned</dt><dd>${pct(l.burned)}</dd>
      <dt>24h buys / sells</dt><dd>${l.buys24h ?? "–"} / ${l.sells24h ?? "–"}</dd>
      <dt>24h volume</dt><dd>${usd(l.vol24h)}</dd>
    </dl>
    <div class="links">
      ${net ? `<a href="https://www.geckoterminal.com/${esc(net)}/pools/${esc(l.pool)}" target="_blank" rel="noopener">Chart ↗</a>` : ""}
      <a href="${esc(ex)}/token/${esc(l.token)}" target="_blank" rel="noopener">Explorer ↗</a>
      <button type="button" class="copy" data-copy="${esc(l.token)}">Copy address</button>
    </div>
  </div></td></tr>`;
}

function render(){
  renderTiles();
  const rows = filtered();
  set("note", rows.length ? `${rows.length} of ${state.data.launches.length} new tokens shown. Tap a row for details.` : "");
  if (!rows.length){ $("rows").innerHTML = `<tr><td colspan="9" class="empty">No launches match these filters.</td></tr>`; return; }
  $("rows").innerHTML = rows.map(l => {
    const ratio = l.buys1h != null && l.sells1h != null ? `${l.buys1h} / ${l.sells1h}` : "–";
    const open = state.open === l.token;
    return `<tr class="row${state.fresh.has(l.token) ? " fresh" : ""}" data-token="${esc(l.token)}" tabindex="0" aria-expanded="${open}">
      <td><div class="tok">${l.image ? `<img src="${esc(l.image)}" alt="" width="28" height="28" loading="lazy">` : `<span class="ph">${esc(l.symbol.slice(0, 2))}</span>`}
        <div><b>${esc(l.symbol)}</b><span>${esc(l.name)}</span><span class="tag${l.launchpad ? " pad" : ""}">${esc(l.dex || "DEX")}</span></div></div></td>
      <td class="mono">${age(l.createdAt)}</td>
      <td class="r mono">${usd(l.mcap)}</td>
      <td class="r mono">${usd(l.liquidity)}</td>
      <td class="r mono ${l.change1h > 0 ? "up" : l.change1h < 0 ? "down" : ""}">${chg(l.change1h)}</td>
      <td class="r mono">${ratio}</td>
      <td class="r mono">${l.checked ? pct(l.devShare) : "–"}</td>
      <td class="r mono">${l.checked ? pct(l.top10) : "–"}</td>
      <td>${riskPill(l.risk)}</td></tr>${open ? detail(l) : ""}`;
  }).join("");
}

function setChain(c){
  if (c === state.chain) return;
  state.chain = c; state.data = null; state.open = null; state.seen = new Set(); state.first = true;
  document.querySelectorAll("[data-chain]").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.chain === c)));
  set("chainName", NAMES[c]);
  const u = new URL(location.href); u.searchParams.set("chain", c); history.replaceState(null, "", u);
  $("rows").innerHTML = `<tr><td colspan="9" class="empty">Loading launches…</td></tr>`;
  ["tCount", "tPads", "tHigh", "tVol"].forEach(id => set(id, "–"));
  load();
}

document.addEventListener("click", e => {
  const c = e.target.closest("[data-chain]");
  if (c) return setChain(c.dataset.chain);
  const cp = e.target.closest("[data-copy]");
  if (cp){ navigator.clipboard && navigator.clipboard.writeText(cp.dataset.copy).then(() => { cp.textContent = "Copied"; }); return; }
  if (e.target.closest("a")) return;
  const r = e.target.closest("tr.row");
  if (r && state.data){ state.open = state.open === r.dataset.token ? null : r.dataset.token; render(); }
});
document.addEventListener("keydown", e => {
  const r = e.target.closest && e.target.closest("tr.row");
  if (r && (e.key === "Enter" || e.key === " ")){ e.preventDefault(); r.click(); }
});
["padsOnly", "hideHigh", "minLiq"].forEach(id => $(id).addEventListener("change", () => state.data && render()));
$("q").addEventListener("input", () => state.data && render());

document.querySelectorAll("[data-chain]").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.chain === state.chain)));
set("chainName", NAMES[state.chain]);
load();
setInterval(() => { if (!document.hidden) load(); }, REFRESH);
})();
