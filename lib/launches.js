// New token launches on Robinhood Chain, Base and Solana, with a rug score from who holds the supply.
// Pools come from GeckoTerminal's newest pools per network (price, liquidity, volume, buys and sells).
// Holders come from Blockscout on the EVM chains and from a Solana RPC on Solana: who deployed the token,
// how much they still hold and how concentrated the rest is; on Solana also whether anyone can still mint
// or freeze it.
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
  solana: {
    name: "Solana",
    kind: "solana",
    gt: process.env.GT_NETWORK_SOLANA || "solana",
    gtName: /^solana$/i,
    explorer: "https://solscan.io",
    paths: {address: "/account/", token: "/token/"},
    launchpads: /pump|bonk|moonshot|launchlab|believe|boop|bags|heaven|dbc|dynamic bonding/i,
  },
};
const isSol = chain => CHAINS[chain].kind === "solana";
// EVM addresses are case-insensitive and get lowercased; Solana's base58 addresses must keep their case
const norm = (chain, a) => isSol(chain) ? String(a || "") : String(a || "").toLowerCase();
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
const addrOf = id => String(id || "").split("_").pop();

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
      pool: norm(chain, a.address || addrOf(p.id)),
      token: norm(chain, base.address || addrOf(rel(p, "base_token").id)),
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

// Solana: one JSON-RPC endpoint does everything. The public one rate-limits hard, so set SOLANA_RPC_URL to a
// keyed endpoint (Helius, QuickNode, ...). Calls go out one at a time like the explorer calls; errors never
// include the URL, since a keyed URL carries the key.
const SOL_RPC = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
const SOL_GAP = +process.env.SOLANA_GAP_MS || 120;
const SYSTEM = "11111111111111111111111111111111";
const INCINERATOR = "1nc1nerator11111111111111111111111111111111";
let solLane = Promise.resolve();
async function solCall(method, params){
  const once = async () => {
    const r = await fetch(SOL_RPC, {method: "POST", headers: {"content-type": "application/json"},
      body: JSON.stringify({jsonrpc: "2.0", id: 1, method, params}), signal: AbortSignal.timeout(8000)});
    if (!r.ok) throw new Error(`solana ${method} → HTTP ${r.status}`);
    const j = await r.json();
    if (j.error) throw new Error(`solana ${method} → ${j.error.code === 429 || /rate/i.test(j.error.message || "") ? "HTTP 429" : (j.error.message || "error")}`);
    return j.result;
  };
  const run = solLane.then(async () => {
    try { return await once(); }
    catch (e) {
      if (!/HTTP 429/.test(e.message)) throw e;
      await new Promise(r => setTimeout(r, 1500));
      return once();
    }
  });
  solLane = run.catch(() => {}).then(() => new Promise(r => setTimeout(r, SOL_GAP)));
  return run;
}

// Top holders are the 20 largest token accounts; each is owned by a wallet or by a program address (pool,
// bonding curve, locker). Owners that are plain System accounts are wallets; anything else counts as a contract.
async function solHolderStats(row){
  const mint = await solCall("getAccountInfo", [row.token, {encoding: "jsonParsed"}]);
  const info = ((((mint || {}).value || {}).data || {}).parsed || {}).info;
  if (!info) throw new Error("not a token mint yet");
  const supply = num(info.supply);
  if (!supply) throw new Error("no supply yet");
  const largest = ((await solCall("getTokenLargestAccounts", [row.token])) || {}).value || [];
  const accts = largest.map(a => a.address);
  const parsed = accts.length ? ((await solCall("getMultipleAccounts", [accts, {encoding: "jsonParsed"}])) || {}).value || [] : [];
  const owners = parsed.map(a => ((((a || {}).data || {}).parsed || {}).info || {}).owner || null);
  const uniq = [...new Set(owners.filter(Boolean))];
  const ownerInfo = uniq.length ? ((await solCall("getMultipleAccounts", [uniq, {encoding: "base64", dataSlice: {offset: 0, length: 0}}])) || {}).value || [] : [];
  const isWallet = new Map(uniq.map((o, i) => [o, !!ownerInfo[i] && ownerInfo[i].owner === SYSTEM]));

  // the creator paid for the mint's first transaction; only look if the history is short enough to reach it
  let dev = null;
  const sigs = await solCall("getSignaturesForAddress", [row.token, {limit: 1000}]).catch(() => null);
  if (sigs && sigs.length && sigs.length < 1000){
    const tx = await solCall("getTransaction", [sigs[sigs.length - 1].signature, {encoding: "json", maxSupportedTransactionVersion: 0}]).catch(() => null);
    dev = ((((tx || {}).transaction || {}).message || {}).accountKeys || [])[0] || null;
  }

  const items = largest.map((a, i) => ({address: owners[i] || a.address, contract: !isWallet.get(owners[i]), share: num(a.amount) / supply}))
    .filter(h => h.share != null);
  const burned = items.filter(h => h.address === INCINERATOR).reduce((s, h) => s + h.share, 0);
  const pool = items.filter(h => h.address === row.pool).reduce((s, h) => s + h.share, 0);
  const wallets = items.filter(h => !h.contract && h.address !== INCINERATOR);
  const top10 = wallets.slice().sort((a, b) => b.share - a.share).slice(0, 10).reduce((s, h) => s + h.share, 0);
  const devShare = dev ? items.filter(h => h.address === dev).reduce((s, h) => s + h.share, 0) : null;
  const contracts = items.filter(h => h.contract && h.address !== row.pool).reduce((s, h) => s + h.share, 0);
  return {
    dev, devShare, top10, burned, inPool: pool, inContracts: contracts, holders: null,
    mintAuthority: info.mintAuthority || null, freezeAuthority: info.freezeAuthority || null,
  };
}

// Holder checks are kept for a while per warm instance, so each refresh only looks up tokens it hasn't seen.
const CACHE_MS = 10 * 60 * 1000;
const cache = new Map();

// The deployer is whoever sent the creation transaction; for launchpad tokens the contract creator is the
// launchpad's factory, so the transaction sender is the one that matters.
async function holderStats(chain, row){
  const key = chain + ":" + row.token, hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.stats;
  if (isSol(chain)){
    const stats = await solHolderStats(row);
    cache.set(key, {at: Date.now(), stats});
    return stats;
  }
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
  if (r.mintAuthority) add(25, "Someone can still mint more tokens");
  if (r.freezeAuthority) add(25, "Someone can freeze holders' tokens");
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
  const limited = errors.some(e => / (403|429)$/.test(e));
  const keyHint = isSol(chain)
    ? (!process.env.SOLANA_RPC_URL && limited ? "The public Solana RPC is rate-limiting holder checks. Set SOLANA_RPC_URL to a keyed endpoint (a free Helius key works) in Vercel." : null)
    : (!KEY && limited ? "The public Blockscout explorer turns away server requests. Set BLOCKSCOUT_API_KEY (free at dev.blockscout.com) in Vercel to switch on holder checks." : null);
  const now = Date.now();
  const out = rows.map(r => {
    const h = byToken.get(r.token);
    const row = {...r, ...(h || {}), checked: !!h};
    return {...row, risk: score(row, now)};
  }).sort((a, b) => Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0));
  return {chain, chainName: CHAINS[chain].name, network, explorer: CHAINS[chain].explorer,
    paths: CHAINS[chain].paths || {address: "/address/", token: "/token/"}, keyHint,
    checked: stats.filter(ok).length, tried: stats.filter(st => st && !st.skipped).length, holderErrors: errors,
    launches: out};
}

module.exports = {launches, CHAINS, _test: {score, holderStats, solHolderStats, newPools}};
