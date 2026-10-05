// New token launches on Robinhood Chain and Base, with a rug score from who holds the supply.
// Pools come from GeckoTerminal's newest pools per network (price, liquidity, volume, buys and sells);
// holders come from each chain's Blockscout: who deployed the token, how much they still hold and how
// concentrated the rest is.
const CHAINS = {
  robinhood: {
    name: "Robinhood Chain",
    gt: process.env.GT_NETWORK_ROBINHOOD || null,   // looked up by name when not set
    gtName: /robinhood/i,
    explorer: "https://robinhoodchain.blockscout.com",
    chainId: 4663,
    launchpads: /pons|hood\.?fun|pools\.?trade|trustswap/i,
  },
  base: {
    name: "Base",
    gt: process.env.GT_NETWORK_BASE || "base",
    gtName: /^base$/i,
    explorer: "https://base.blockscout.com",
    chainId: 8453,
    launchpads: /clanker|zora|virtuals|flaunch|bankr|wow|creator|ape\.?store|doppler/i,
  },
};
const GT = "https://api.geckoterminal.com/api/v2";
const PAGES = 2;            // 20 pools a page; GeckoTerminal's free API allows about 30 calls a minute
const ENRICH = 20;          // tokens checked on the explorer per request, deepest liquidity first
const BUDGET_MS = 18000;     // Vercel stops the function at 30 s
const PARALLEL = 4;          // explorer calls still go out one at a time (bsJson); this only overlaps the waits
const BURN = /^0x0{40}$|^0x0+dead$/i;   // zero and 0x…dead burn addresses

// The public explorers answer 403 to server traffic; Blockscout's PRO API (free key from dev.blockscout.com)
// serves the same /api/v2 routes for every chain under api.blockscout.com/{chainId}.
const KEY = process.env.BLOCKSCOUT_API_KEY || "";
const explorerApi = chain => KEY ? `https://api.blockscout.com/${CHAINS[chain].chainId}/api/v2` : CHAINS[chain].explorer + "/api/v2";

async function getJson(url, ms = 10000){
  const headers = {accept: "application/json", "user-agent": "Mozilla/5.0 (compatible; LaunchRadar/1.0)"};
  if (KEY && url.startsWith("https://api.blockscout.com/")){
    headers.authorization = "Bearer " + KEY;
    url += (url.includes("?") ? "&" : "?") + "apikey=" + encodeURIComponent(KEY);
  }
  const r = await fetch(url, {headers, signal: AbortSignal.timeout(ms)});
  url = url.replace(/apikey=[^&]+/, "apikey=…");
  if (!r.ok) throw new Error(`${url} → HTTP ${r.status}`);
  return r.json();
}

// Blockscout's free tier answers 429 to bursts, so explorer calls go out one at a time with a gap between
// them, and a 429 is retried once after a pause.
const GAP = +process.env.BLOCKSCOUT_GAP_MS || 250;
let lane = Promise.resolve();
function bsJson(url, ms = 8000){
  const run = lane.then(async () => {
    try { return await getJson(url, ms); }
    catch (e) {
      if (!/HTTP 429/.test(e.message)) throw e;
      await new Promise(r => setTimeout(r, 1500));
      return getJson(url, ms);
    }
  });
  lane = run.catch(() => {}).then(() => new Promise(r => setTimeout(r, GAP)));
  return run;
}
// GeckoTerminal answers 429 when the shared free quota runs out; wait once and try again.
async function gtJson(url){
  try { return await getJson(url); }
  catch (e) {
    if (!/HTTP 429/.test(e.message)) throw e;
    await new Promise(r => setTimeout(r, 2500));
    return getJson(url);
  }
}
const num = v => v == null || v === "" || !isFinite(+v) ? null : +v;
const addrOf = id => String(id || "").split("_").pop().toLowerCase();

// GeckoTerminal names networks its own way; find Robinhood Chain's id once and keep it.
const networkIds = {};
async function networkId(chain){
  const c = CHAINS[chain];
  if (c.gt) return c.gt;
  if (networkIds[chain]) return networkIds[chain];
  for (let page = 1; page <= 10; page++){
    const j = await gtJson(`${GT}/networks?page=${page}`);
    const hit = (j.data || []).find(n => c.gtName.test((n.attributes || {}).name || "") || c.gtName.test(n.id));
    if (hit) return networkIds[chain] = hit.id;
    if (!(j.data || []).length) break;
  }
  throw new Error(`GeckoTerminal has no network for ${c.name}`);
}

async function newPools(chain){
  const net = await networkId(chain);
  // the first page has to load (an empty feed would look like a quiet chain); later pages are a bonus
  const page = i => gtJson(`${GT}/networks/${net}/new_pools?include=base_token,quote_token,dex&page=${i + 1}`);
  const pages = [await page(0)];
  for (let i = 1; i < PAGES; i++) pages.push(await page(i).catch(() => ({data: []})));
  const included = new Map();
  for (const p of pages) for (const x of p.included || []) included.set(x.id, x.attributes || {});
  const rel = (p, k) => ((p.relationships || {})[k] || {}).data || {};
  const pools = pages.flatMap(p => p.data || []).map(p => {
    const a = p.attributes || {}, tx = a.transactions || {}, vol = a.volume_usd || {}, ch = a.price_change_percentage || {};
    const base = included.get(rel(p, "base_token").id) || {}, quote = included.get(rel(p, "quote_token").id) || {};
    const dexId = rel(p, "dex").id || "", dex = (included.get(dexId) || {}).name || dexId;
    return {
      pool: String(a.address || addrOf(p.id)).toLowerCase(),
      token: String(base.address || addrOf(rel(p, "base_token").id)).toLowerCase(),
      symbol: base.symbol || "?", name: base.name || base.symbol || "Unknown", image: base.image_url && !/missing/.test(base.image_url) ? base.image_url : null,
      quote: quote.symbol || null, dex, dexId,
      launchpad: CHAINS[chain].launchpads.test(`${dexId} ${dex}`),
      createdAt: a.pool_created_at || null,
      priceUsd: num(a.base_token_price_usd), mcap: num(a.market_cap_usd) ?? num(a.fdv_usd), fdv: num(a.fdv_usd),
      liquidity: num(a.reserve_in_usd),
      vol1h: num(vol.h1), vol24h: num(vol.h24),
      change1h: num(ch.h1), change24h: num(ch.h24),
      buys1h: num((tx.h1 || {}).buys), sells1h: num((tx.h1 || {}).sells),
      buys24h: num((tx.h24 || {}).buys), sells24h: num((tx.h24 || {}).sells),
      buyers24h: num((tx.h24 || {}).buyers), sellers24h: num((tx.h24 || {}).sellers),
    };
  });
  // one row per token: its deepest new pool
  const byToken = new Map();
  for (const p of pools) if (!byToken.has(p.token) || (p.liquidity || 0) > (byToken.get(p.token).liquidity || 0)) byToken.set(p.token, p);
  return {network: net, rows: [...byToken.values()]};
}

// Holder checks are kept for a while per warm instance, so each refresh only looks up tokens it hasn't seen.
const CACHE_MS = 10 * 60 * 1000;
const cache = new Map();

// The deployer is whoever sent the creation transaction; for launchpad tokens the contract creator is the
// launchpad's factory, so the transaction sender is the one that matters.
async function holderStats(chain, row){
  const key = chain + ":" + row.token, hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.stats;
  const ex = explorerApi(chain);
  // brand-new tokens can take a few minutes to show up on the explorer; say which lookup failed
  const holders = await bsJson(`${ex}/tokens/${row.token}/holders`).catch(e => { throw new Error("holders: " + e.message); });
  // each holder entry carries the token, so the separate token call is only needed when it doesn't
  const first = ((holders.items || [])[0] || {}).token || {};
  const token = first.total_supply ? first : await bsJson(`${ex}/tokens/${row.token}`).catch(() => ({}));
  const addr = await bsJson(`${ex}/addresses/${row.token}`).catch(() => ({}));
  let dev = null;
  if (addr.creation_tx_hash){
    const tx = await bsJson(`${ex}/transactions/${addr.creation_tx_hash}`).catch(() => null);
    dev = (((tx || {}).from || {}).hash || addr.creator_address_hash || "").toLowerCase() || null;
  } else if (addr.creator_address_hash) dev = addr.creator_address_hash.toLowerCase();

  const supply = num(token.total_supply) ?? num((((holders.items || [])[0] || {}).token || {}).total_supply);
  if (!supply) throw new Error("not indexed on the explorer yet");
  const items = (holders.items || []).map(h => ({
    address: String((h.address || {}).hash || "").toLowerCase(),
    contract: !!(h.address || {}).is_contract,
    share: supply ? num(h.value) / supply : null,
  })).filter(h => h.share != null);
  const burned = items.filter(h => BURN.test(h.address)).reduce((s, h) => s + h.share, 0);
  const pool = items.filter(h => h.address === row.pool).reduce((s, h) => s + h.share, 0);
  // wallets only: pools, bonding curves and lockers are contracts and aren't anyone's bag
  const wallets = items.filter(h => !h.contract && !BURN.test(h.address));
  const top10 = wallets.slice().sort((a, b) => b.share - a.share).slice(0, 10).reduce((s, h) => s + h.share, 0);
  const devShare = dev ? items.filter(h => h.address === dev).reduce((s, h) => s + h.share, 0) : null;
  const contracts = items.filter(h => h.contract && h.address !== row.pool).reduce((s, h) => s + h.share, 0);
  const stats = {
    dev, devShare, top10, burned, inPool: pool, inContracts: contracts,
    holders: num(token.holders_count ?? token.holders),
  };
  cache.set(key, {at: Date.now(), stats});
  return stats;
}

// Higher means riskier. Each reason is kept so the page can say why.
function score(r, now = Date.now()){
  const reasons = [];
  let s = 0;
  const add = (pts, text) => { s += pts; reasons.push({pts, text}); };
  const pct = x => Math.round(x * 100) + "%";
  if (r.devShare != null){
    if (r.devShare > 0.10) add(30, `Deployer still holds ${pct(r.devShare)}`);
    else if (r.devShare > 0.05) add(15, `Deployer holds ${pct(r.devShare)}`);
  }
  if (r.top10 != null){
    if (r.top10 > 0.50) add(25, `Top 10 wallets hold ${pct(r.top10)}`);
    else if (r.top10 > 0.30) add(12, `Top 10 wallets hold ${pct(r.top10)}`);
  }
  if (r.liquidity != null){
    if (r.liquidity < 10000) add(20, "Under $10k of liquidity");
    else if (r.liquidity < 50000) add(10, "Under $50k of liquidity");
  }
  if (r.liquidity != null && r.mcap && r.liquidity / r.mcap < 0.02) add(10, "Liquidity under 2% of market cap");
  if (r.holders != null && r.holders < 50) add(10, `Only ${r.holders} holders`);
  if (r.sells1h != null && r.buys1h != null && r.sells1h > 2 * Math.max(r.buys1h, 1)) add(15, "Sells outnumber buys 2:1 this hour");
  if (r.change1h != null && r.change1h < -50) add(15, `Down ${Math.round(-r.change1h)}% in the last hour`);
  const age = r.createdAt ? now - Date.parse(r.createdAt) : null;
  if (age != null && age < 3600e3) add(10, "Less than an hour old");
  if (!r.checked) add(0, "Holders not checked yet");
  const value = Math.min(100, s);
  return {value, band: value < 25 ? "low" : value < 50 ? "mid" : "high", reasons};
}

async function mapLimit(items, n, fn){
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({length: Math.min(n, items.length)}, async () => {
    while (i < items.length){ const k = i++; out[k] = await fn(items[k]).catch(e => ({error: String(e && e.message || e)})); }
  }));
  return out;
}

async function launches(chain){
  if (!CHAINS[chain]) throw new Error("unknown chain");
  const {network, rows} = await newPools(chain);
  const deepest = rows.slice().sort((a, b) => (b.liquidity || 0) - (a.liquidity || 0)).slice(0, ENRICH);
  // stop starting new explorer lookups well before the function's time limit; cached tokens are instant,
  // so each refresh checks a few more until all of them are covered
  const deadline = Date.now() + BUDGET_MS;
  const stats = await mapLimit(deepest, PARALLEL, r => {
    const hit = cache.get(chain + ":" + r.token);
    return hit || Date.now() < deadline ? holderStats(chain, r) : Promise.resolve({skipped: true});
  });
  const ok = st => st && !st.error && !st.skipped;
  const byToken = new Map(deepest.map((r, i) => [r.token, ok(stats[i]) ? stats[i] : null]));
  // a few distinct failure messages, so a broken explorer shows up on the page instead of silently
  const errors = [...new Set(stats.filter(s => s && s.error).map(s => s.error.replace(/0x[0-9a-f]{40}/gi, "0x…")))].slice(0, 3);
  const now = Date.now();
  const out = rows.map(r => {
    const h = byToken.get(r.token);
    const row = {...r, ...(h || {}), checked: !!h};
    return {...row, risk: score(row, now)};
  }).sort((a, b) => Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0));
  return {chain, chainName: CHAINS[chain].name, network, explorer: CHAINS[chain].explorer,
    checked: stats.filter(ok).length, tried: stats.filter(st => st && !st.skipped).length, holderErrors: errors,
    needsKey: !KEY && errors.some(e => / 403$/.test(e)), launches: out};
}

module.exports = {launches, CHAINS, _test: {score, holderStats, newPools}};
