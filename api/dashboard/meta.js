// api/dashboard/meta.js
// Server-side Meta Marketing API proxy.
//
// The Meta access token stays on the server and is NEVER exposed to the browser
// (this is a deliberate improvement over the original Goldsure dashboard, which
// returned the token to the client). The browser calls this endpoint, the server
// calls Graph API, and only the computed daily numbers are returned.
//
// Vercel Environment Variable:
//   META_TOKEN = a long-lived Meta access token with `ads_read` on both accounts
//
// Query params:
//   account = numeric ad account id, no "act_" prefix (e.g. 1220120669692442)
//   since   = YYYY-MM-DD
//   until   = YYYY-MM-DD

const META_API_VERSION = 'v21.0';

// Action types that represent a "lead". Lead-form (onsite) and website-pixel
// (offsite) leads are mutually exclusive per campaign, so onsite + pixel is a
// safe sum. We pick the single most-specific onsite type to avoid double counting.
const ONSITE_LEAD_TYPES = ['onsite_conversion.lead_grouped', 'leadgen_grouped', 'lead'];
const PIXEL_LEAD_TYPE = 'offsite_conversion.fb_pixel_lead';

function extractLeads(actions) {
  if (!Array.isArray(actions)) return 0;
  const val = (type) => {
    const a = actions.find((x) => x.action_type === type);
    return a ? parseInt(a.value, 10) || 0 : 0;
  };
  const onsite = ONSITE_LEAD_TYPES.reduce((acc, t) => acc || val(t), 0);
  const pixel = val(PIXEL_LEAD_TYPE);
  return onsite + pixel;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const token = process.env.META_TOKEN || '';
  if (!token) {
    return res.status(500).json({ error: 'META_TOKEN not configured in Vercel Environment Variables.' });
  }

  const { account, since, until } = req.query;
  if (!account || !since || !until) {
    return res.status(400).json({ error: 'Missing required query params: account, since, until.' });
  }
  const acct = String(account).replace(/^act_/, '');

  const fields = 'spend,impressions,clicks,actions';
  const timeRange = encodeURIComponent(JSON.stringify({ since, until }));
  let url =
    `https://graph.facebook.com/${META_API_VERSION}/act_${acct}/insights` +
    `?level=account&fields=${fields}&time_increment=1&time_range=${timeRange}` +
    `&limit=500&access_token=${encodeURIComponent(token)}`;

  try {
    let rows = [];
    let guard = 0;
    while (url && guard < 50) {
      guard++;
      const r = await fetch(url);
      const j = await r.json();
      if (j.error) {
        return res.status(502).json({ error: j.error.message || 'Meta API error', meta: j.error });
      }
      rows = rows.concat(j.data || []);
      url = j.paging && j.paging.next ? j.paging.next : '';
    }

    const days = rows.map((d) => ({
      date: d.date_start,
      spend: parseFloat(d.spend || 0),
      impressions: parseInt(d.impressions || 0, 10),
      clicks: parseInt(d.clicks || 0, 10),
      leads: extractLeads(d.actions),
    }));

    const totals = days.reduce(
      (t, d) => ({
        spend: t.spend + d.spend,
        impressions: t.impressions + d.impressions,
        clicks: t.clicks + d.clicks,
        leads: t.leads + d.leads,
      }),
      { spend: 0, impressions: 0, clicks: 0, leads: 0 }
    );

    return res.status(200).json({ account: acct, since, until, days, totals });
  } catch (err) {
    return res.status(500).json({ error: `Meta proxy failed: ${err.message}` });
  }
}
