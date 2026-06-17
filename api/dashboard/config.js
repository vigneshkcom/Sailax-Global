// api/dashboard/config.js
// Returns NON-SENSITIVE configuration to the browser so the UI can show which
// integrations are live. No API tokens are ever returned here — the Meta token
// and GHL keys stay server-side (used only by /api/dashboard/meta and /ghl).
//
// UK and AU are SEPARATE GoHighLevel locations, each with its own Private
// Integration token, so config is reported per account.
//
// Vercel Environment Variables read here:
//   META_TOKEN                            (presence only)
//   GHL_API_KEY_UK / GHL_API_KEY_AU       (presence only — values never returned)
//   GHL_LOCATION_ID_UK / GHL_LOCATION_ID_AU (returned — identifiers, not secret)

const ACCOUNT_KEYS = ['uk', 'au'];

export default function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const accounts = {};
  for (const k of ACCOUNT_KEYS) {
    const K = k.toUpperCase();
    accounts[k] = {
      ghlConfigured: !!process.env[`GHL_API_KEY_${K}`],
      ghlLocationId: process.env[`GHL_LOCATION_ID_${K}`] || '',
    };
  }

  return res.status(200).json({
    metaConfigured: !!process.env.META_TOKEN,
    accounts,
  });
}
