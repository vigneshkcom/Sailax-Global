// api/dashboard/meta.js
// Server-side Meta Marketing API proxy.
//
// Returns per-day account totals AND per-campaign totals for the date range.
// The Meta access token stays on the server — never exposed to the browser.
//
// Vercel Environment Variable:
//   META_TOKEN = a long-lived Meta access token with `ads_read` on both accounts
//
// Query params:
//   account = numeric ad account id, no "act_" prefix (e.g. 1220120669692442)
//   since   = YYYY-MM-DD
//   until   = YYYY-MM-DD

const META_API_VERSION = 'v21.0';

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

async function fetchAllPages(startUrl) {
  let rows = [];
  let url = startUrl;
  let guard = 0;
  while (url && guard < 50) {
    guard++;
    const r = await fetch(url);
    const j = await r.json();
    if (j.error) throw new Error(j.error.message || 'Meta API error');
    rows = rows.concat(j.data || []);
    url = j.paging && j.paging.next ? j.paging.next : '';
  }
  return rows;
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
  const timeRange = encodeURIComponent(JSON.stringify({ since, until }));
  const tok = encodeURIComponent(token);
  const base = `https://graph.facebook.com/${META_API_VERSION}/act_${acct}/insights`;

  try {
    // Fetch account-level daily breakdown and campaign totals in parallel.
    const [dayRows, campRows] = await Promise.all([
      fetchAllPages(
        `${base}?level=account&fields=spend,impressions,clicks,actions` +
        `&time_increment=1&time_range=${timeRange}&limit=500&access_token=${tok}`
      ),
      fetchAllPages(
        `${base}?level=campaign&fields=campaign_id,campaign_name,spend,impressions,clicks,actions` +
        `&time_range=${timeRange}&limit=500&access_token=${tok}`
      ),
    ]);

    const days = dayRows.map((d) => ({
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

    const campaigns = campRows
      .map((c) => ({
        id: c.campaign_id,
        name: c.campaign_name,
        spend: parseFloat(c.spend || 0),
        impressions: parseInt(c.impressions || 0, 10),
        clicks: parseInt(c.clicks || 0, 10),
        leads: extractLeads(c.actions),
      }))
      .sort((a, b) => b.spend - a.spend);

    return res.status(200).json({ account: acct, since, until, days, totals, campaigns });
  } catch (err) {
    return res.status(500).json({ error: `Meta proxy failed: ${err.message}` });
  }
}
