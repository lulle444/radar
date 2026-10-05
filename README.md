# Launch Radar

New token launches on Robinhood Chain and Base, newest first, each with a rug score. Static page plus one Vercel
function; no build step. Run locally with `npx vercel dev`.

- `api/launches.js?chain=robinhood|base` (built in `lib/launches.js`), cached at the CDN for 60 seconds:
  - pools: GeckoTerminal `networks/{network}/new_pools` (3 pages), one row per token (its deepest new pool). Robinhood
    Chain's GeckoTerminal network id is looked up by name; set `GT_NETWORK_ROBINHOOD` (or `GT_NETWORK_BASE`) to pin it.
  - holders: each chain's Blockscout (`robinhoodchain.blockscout.com`, `base.blockscout.com`) for the 20 deepest tokens:
    the deployer (sender of the creation transaction, so launchpad factories don't count), its share of supply,
    the top-10 wallet share (contracts and burn addresses excluded), holder count, burned and pooled share.
  - the public explorers answer 403 to server requests, so set `BLOCKSCOUT_API_KEY` (free at dev.blockscout.com) in
    Vercel; requests then go to Blockscout's PRO API, `api.blockscout.com/{chainId}/api/v2` (4663 Robinhood Chain, 8453 Base).
  - launchpads are recognised from the DEX name (`launchpads` patterns per chain in `lib/launches.js`).
- `index.html` + `app.js` + `style.css`: chain switch (`?chain=base`), filters, a row per token with a detail panel
  listing why it scored what it did. Refreshes every minute and highlights tokens that just appeared.

The rug score (0–100, higher = riskier) is explained on the page; the points live in `score()` in `lib/launches.js`.
