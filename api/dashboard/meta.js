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

  const { account, since, until, campaign } = req.query;
  if (!account || !since || !until) {
    return res.status(400).json({ error: 'Missing required query params: account, since, until.' });
  }
  const acct = String(account).replace(/^act_/, '');
  const camp = campaign ? String(campaign).replace(/[^0-9]/g, '') : '';
  const timeRange = encodeURIComponent(JSON.stringify({ since, until }));
  const tok = encodeURIComponent(token);
  // When a campaign id is supplied (e.g. HWS runs as one campaign inside a
  // shared account), query the campaign node so figures cover only that campaign.
  const node = camp ? camp : `act_${acct}`;
  const dayLevel = camp ? 'campaign' : 'account';
  const base = `https://graph.facebook.com/${META_API_VERSION}/${node}/insights`;

  try {
    // Daily breakdown + per-campaign spend (insights only return campaigns that
    // delivered in the range) + the list of currently-active campaigns (so a
    // running campaign shows even before it spends in the selected window).
    const [dayRows, campRows, activeRows] = await Promise.all([
      fetchAllPages(
        `${base}?level=${dayLevel}&fields=spend,impressions,clicks,actions` +
        `&time_increment=1&time_range=${timeRange}&limit=500&access_token=${tok}`
      ),
      fetchAllPages(
        `${base}?level=campaign&fields=campaign_id,campaign_name,spend,impressions,clicks,actions` +
        `&time_range=${timeRange}&limit=500&access_token=${tok}`
      ),
      // Account-level only — HWS targets a single campaign node directly.
      // Fault-tolerant: any failure here falls back to the spend-based list.
      (async () => {
        if (camp) return [];
        const statuses = encodeURIComponent(JSON.stringify(['ACTIVE', 'WITH_ISSUES', 'PENDING_REVIEW', 'IN_PROCESS']));
        const url = `https://graph.facebook.com/${META_API_VERSION}/act_${acct}/campaigns` +
          `?fields=id,name,effective_status&effective_status=${statuses}&limit=500&access_token=${tok}`;
        try { return await fetchAllPages(url); } catch { return []; }
      })(),
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

    // Merge: every active campaign (with its in-range spend, or 0) plus any
    // non-active campaign that did spend in range. Sorted by spend.
    const ACTIVE_RE = /ACTIVE|WITH_ISSUES|PENDING_REVIEW|IN_PROCESS/i;
    const insightsById = {};
    campRows.forEach((c) => { insightsById[c.campaign_id] = c; });
    const mk = (id, name, status, ins) => ({
      id,
      name,
      status,
      spend: ins ? parseFloat(ins.spend || 0) : 0,
      impressions: ins ? parseInt(ins.impressions || 0, 10) : 0,
      clicks: ins ? parseInt(ins.clicks || 0, 10) : 0,
      leads: ins ? extractLeads(ins.actions) : 0,
    });
    const campaigns = [];
    const seen = new Set();
    activeRows
      .filter((c) => ACTIVE_RE.test(c.effective_status || ''))
      .forEach((c) => { campaigns.push(mk(c.id, c.name, c.effective_status || 'ACTIVE', insightsById[c.id])); seen.add(c.id); });
    campRows.forEach((c) => {
      if (seen.has(c.campaign_id)) return;
      campaigns.push(mk(c.campaign_id, c.campaign_name, 'INACTIVE', c));
    });
    campaigns.sort((a, b) => b.spend - a.spend);

    return res.status(200).json({ account: acct, since, until, days, totals, campaigns });
  } catch (err) {
    return res.status(500).json({ error: `Meta proxy failed: ${err.message}` });
  }
}
