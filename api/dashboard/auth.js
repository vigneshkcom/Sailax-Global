// api/dashboard/auth.js
// Password verification for the Meta Ads dashboard.
// The password lives ONLY in a Vercel Environment Variable, never in the HTML.
//
// Set in Vercel → Project Settings → Environment Variables:
//   DASHBOARD_PASSWORD = your chosen password

export default function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const correctPassword = process.env.DASHBOARD_PASSWORD || '';
  if (!correctPassword) {
    return res.status(500).json({ error: 'DASHBOARD_PASSWORD not configured in Vercel.' });
  }

  const { password } = req.body || {};
  if (!password) {
    return res.status(400).json({ ok: false, error: 'No password provided.' });
  }

  return res.status(200).json({ ok: password === correctPassword });
}
