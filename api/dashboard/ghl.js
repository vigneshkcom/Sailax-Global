// api/dashboard/ghl.js
// Per-account server-side proxy for the GoHighLevel API.
//
// UK and AU are separate GHL locations, each with its own Private Integration
// (pit-) token, so the caller specifies which account's token to use. The keys
// never reach the browser and there are no CORS issues.
//
// Vercel Environment Variables:
//   GHL_API_KEY_UK = UK location's Private Integration token (pit-xxxx...)
//   GHL_API_KEY_AU = AU location's Private Integration token (pit-xxxx...)
//
// Usage from the browser:
//   /api/dashboard/ghl?account=uk&path=/opportunities/search?location_id=XXXX&limit=100

const TOKEN_ENV = { uk: 'GHL_API_KEY_UK', au: 'GHL_API_KEY_AU' };

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { account, path } = req.query;
  const envName = TOKEN_ENV[String(account || '').toLowerCase()];
  if (!envName) {
    return res.status(400).json({ error: 'Invalid or missing `account` query param (expected "uk" or "au").' });
  }

  const ghlKey = process.env[envName] || '';
  if (!ghlKey) {
    return res.status(500).json({ error: `${envName} not configured in Vercel Environment Variables.` });
  }
  if (!path) {
    return res.status(400).json({ error: 'Missing required `path` query parameter.' });
  }

  // Private Integration tokens use services.leadconnectorhq.com with Version 2021-07-28.
  const targetUrl = `https://services.leadconnectorhq.com${path}`;

  try {
    const ghlResp = await fetch(targetUrl, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${ghlKey}`,
        Version: '2021-07-28',
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
    });

    const text = await ghlResp.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      return res.status(500).json({
        error: `GHL returned non-JSON response (HTTP ${ghlResp.status})`,
        raw: text.slice(0, 500),
      });
    }

    if (!ghlResp.ok) {
      return res.status(ghlResp.status).json({
        error: data.message || data.msg || data.error || `GHL HTTP ${ghlResp.status}`,
        raw: data,
      });
    }

    return res.status(200).json(data);
  } catch (err) {
    return res.status(500).json({ error: `GHL proxy fetch failed: ${err.message}` });
  }
}
