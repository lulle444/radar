// New launches for one chain (?chain=robinhood|base), cached at the edge for a minute.
const {launches, CHAINS} = require("../lib/launches");

module.exports = async function handler(req, res){
  const chain = String((req.query || {}).chain || "robinhood").toLowerCase();
  if (!CHAINS[chain]) return res.status(400).json({error: "chain must be robinhood or base"});
  try {
    const data = await launches(chain);
    res.setHeader("Cache-Control", "public, s-maxage=60, stale-while-revalidate=300");
    res.status(200).json({updatedAt: new Date().toISOString(), ...data});
  } catch (e) {
    res.setHeader("Cache-Control", "no-store");
    res.status(502).json({error: String(e.message || e)});
  }
};
