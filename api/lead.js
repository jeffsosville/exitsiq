// api/lead.js — Vercel serverless function.
//
// Resend needs the API key server-side, so the form posts here rather than
// calling Resend from the browser.
//
// Writes the lead to the CRM (inhouse of the Sosville app DB) and sends two
// emails: one to the owner with their score, one to John with the detail.
//
// Env required on the Vercel project:
//   RESEND_API_KEY
//   CRM_SUPABASE_URL, CRM_SUPABASE_SERVICE_KEY   (optional - email still works without)

const NOTIFY_TO = ['john@atmbrokerage.com', 'jeff@sosville.co'];
const FROM = 'ExitsIQ <hello@exitsiq.com>';

// Where an owner goes when they are ready to list. Keep in sync with the
// INDUSTRIES table in index.html.
const ROUTES = {
  cleaning:   { name: 'CleaningExits', url: 'https://cleaningexits.com' },
  landscaping:{ name: 'CleaningExits', url: 'https://cleaningexits.com' },
  vending:    { name: 'VendingExits',  url: 'https://vendingexits.com' },
  atm:        { name: 'ATM Brokerage', url: 'https://atmbrokerage.com' },
};

const esc = (s) =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const money = (n) =>
  n == null || isNaN(n) ? '—' : '$' + Math.round(Number(n)).toLocaleString('en-US');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const b = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});

    // Honeypot. Bots fill hidden fields; return success so they don't retry.
    if (String(b.website || '').trim()) return res.status(200).json({ ok: true });

    const name = String(b.name || '').trim();
    const email = String(b.email || '').trim();
    if (name.length < 2) return res.status(400).json({ error: 'Please enter your name.' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      return res.status(400).json({ error: 'Please enter a valid email address.' });

    const lead = {
      name,
      email,
      phone: String(b.phone || '').trim() || null,
      industry: String(b.industry || 'other').trim(),
      score: Number(b.score) || null,
      revenue: Number(b.revenue) || null,
      sde: Number(b.sde) || null,
      valuation: Number(b.valuation) || null,
      net_proceeds: Number(b.netProceeds) || null,
      years_to_exit: Number(b.years) || null,
      verdict: String(b.verdict || '').trim() || null,
      ip: (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || null,
      user_agent: req.headers['user-agent'] || null,
    };

    const route = ROUTES[lead.industry] || null;

    // ── 1. Persist. Never let a database problem cost us the lead. ──
    const url = process.env.CRM_SUPABASE_URL;
    const key = process.env.CRM_SUPABASE_SERVICE_KEY;
    if (url && key) {
      try {
        const r = await fetch(`${url}/rest/v1/owner_profiles`, {
          method: 'POST',
          headers: {
            apikey: key,
            Authorization: `Bearer ${key}`,
            'Content-Type': 'application/json',
            Prefer: 'return=minimal,resolution=merge-duplicates',
          },
          body: JSON.stringify({ ...lead, source: 'exitsiq' }),
        });
        if (!r.ok) console.error('owner_profiles write failed', r.status, (await r.text()).slice(0, 300));
      } catch (e) {
        console.error('owner_profiles write threw:', e);
      }
    }

    // ── 2. Email. ──
    // Track whether the owner's copy actually sent. Saying "Sent." when it
    // didn't is worse than saying nothing - the person waits for an email that
    // is never coming, and we look broken instead of honest.
    let ownerEmailSent = false;
    let emailError = null;

    const apiKey = process.env.RESEND_API_KEY;
    if (apiKey) {
      const send = async (payload) => {
        const r = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (!r.ok) {
          const body = (await r.text()).slice(0, 300);
          console.error('Resend', r.status, body);
          throw new Error(`Resend ${r.status}: ${body}`);
        }
        return true;
      };

      try {
        await send({
          from: FROM,
          to: [lead.email],
          reply_to: 'hello@exitsiq.com',
          subject: `Your readiness score: ${lead.score ?? '—'} of 100`,
          html: ownerHtml(lead, route),
          text: ownerText(lead, route),
        });
        ownerEmailSent = true;
      } catch (e) {
        emailError = String(e.message || e);
        console.error('owner email failed:', emailError);
      }

      await send({
        from: FROM,
        to: NOTIFY_TO,
        reply_to: lead.email,
        subject: `[ExitsIQ] ${lead.name} — ${lead.verdict || 'score ' + lead.score} — ${lead.industry}`,
        html: brokerHtml(lead),
      }).catch((e) => console.error('broker email', e));
    } else {
      emailError = 'RESEND_API_KEY not set';
      console.error('RESEND_API_KEY missing - lead recorded, no email sent.');
    }

    // The lead is saved either way. Report the email honestly so the page can
    // say "we have it, John will follow up" rather than "check your inbox".
    return res.status(200).json({ ok: true, emailed: ownerEmailSent, emailError });
  } catch (err) {
    console.error('lead handler error:', err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
};

function ownerHtml(l, route) {
  const next = route
    ? `<p>When you are ready to test the market, <a href="${route.url}" style="color:#B45309">${esc(route.name)}</a> is where businesses like yours get listed.</p>`
    : '';
  return `<!DOCTYPE html><html><body style="font-family:Arial,Helvetica,sans-serif;color:#1a1a1a;line-height:1.6;max-width:600px;margin:0 auto;padding:24px">
<p>Hi ${esc(l.name.split(' ')[0])},</p>
<p>Here is where you stand today.</p>
<table style="border-collapse:collapse;margin:20px 0;width:100%">
<tr><td style="padding:8px 16px 8px 0;color:#555">Readiness score</td><td style="padding:8px 0;font-weight:bold;font-size:20px">${l.score ?? '—'} / 100</td></tr>
<tr><td style="padding:8px 16px 8px 0;color:#555">Where that puts you</td><td style="padding:8px 0;font-weight:bold">${esc(l.verdict || '')}</td></tr>
<tr><td style="padding:8px 16px 8px 0;color:#555">Estimated business value</td><td style="padding:8px 0;font-weight:bold">${money(l.valuation)}</td></tr>
<tr><td style="padding:8px 16px 8px 0;color:#555">After tax and debt</td><td style="padding:8px 0;font-weight:bold">${money(l.net_proceeds)}</td></tr>
</table>
<p style="font-size:13px;color:#666">That valuation uses the median asking multiple for your industry from our listings index. It is a starting point, not an appraisal — what a business actually sells for depends on customer concentration, how much of it runs without you, and how clean the books are.</p>
${next}
<p>If you want to talk through what would move that number, just reply to this email.</p>
<p>&mdash; ExitsIQ</p>
<p style="font-size:12px;color:#999;margin-top:28px;border-top:1px solid #eee;padding-top:14px">
<a href="https://exitsiq.com" style="color:#999">exitsiq.com</a></p>
</body></html>`;
}

function ownerText(l, route) {
  return `Hi ${l.name.split(' ')[0]},

Here is where you stand today.

Readiness score:            ${l.score ?? '—'} / 100
Where that puts you:        ${l.verdict || ''}
Estimated business value:   ${money(l.valuation)}
After tax and debt:         ${money(l.net_proceeds)}

That valuation uses the median asking multiple for your industry from our
listings index. It is a starting point, not an appraisal.

${route ? `When you are ready to test the market, ${route.name} (${route.url}) is where businesses like yours get listed.\n` : ''}
If you want to talk through what would move that number, just reply to this email.

-- ExitsIQ
exitsiq.com
`;
}

function brokerHtml(l) {
  const row = (k, v) =>
    `<tr><td style="padding:6px 16px 6px 0;font-weight:bold;width:170px">${esc(k)}</td><td style="padding:6px 0">${v}</td></tr>`;
  return `<!DOCTYPE html><html><body style="font-family:Arial,Helvetica,sans-serif;color:#1a1a1a;line-height:1.55;max-width:620px;margin:0 auto;padding:24px">
<div style="font-size:11px;text-transform:uppercase;letter-spacing:.1em;color:#B45309;margin-bottom:6px">New ExitsIQ lead</div>
<h2 style="margin:0 0 20px;font-size:21px">${esc(l.name)} &mdash; ${l.score ?? '—'}/100 &mdash; ${esc(l.verdict || '')}</h2>
<table style="border-collapse:collapse;width:100%;margin-bottom:20px">
${row('Email', `<a href="mailto:${esc(l.email)}">${esc(l.email)}</a>`)}
${l.phone ? row('Phone', `<a href="tel:${esc(l.phone)}">${esc(l.phone)}</a>`) : ''}
${row('Industry', esc(l.industry))}
${row('Revenue', money(l.revenue))}
${row('SDE', money(l.sde))}
${row('Est. valuation', money(l.valuation))}
${row('After tax + debt', money(l.net_proceeds))}
${row('Years to exit', l.years_to_exit ?? '—')}
</table>
<p style="font-size:13px;color:#555">Reply goes straight to them.</p>
</body></html>`;
}
