// api/dashboard/config.js
// Returns NON-SENSITIVE configuration to the browser so the UI can show which
// integrations are live. No API tokens are ever returned here — the Meta token
// and GHL key stay server-side (used only by /api/dashboard/meta and /ghl).
//
// Vercel Environment Variables read here:
//   META_TOKEN       (presence only — value never returned)
//   GHL_API_KEY      (presence only — value never returned)
//   GHL_LOCATION_ID  (returned — this is an account identifier, not a secret)

export default function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  return res.status(200).json({
    metaConfigured: !!process.env.META_TOKEN,
    ghlConfigured:  !!process.env.GHL_API_KEY,
    ghlLocationId:  process.env.GHL_LOCATION_ID || '',
  });
}
