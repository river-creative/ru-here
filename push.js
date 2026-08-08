// Single push endpoint (one function so the in-memory fallback shares state):
//   POST { action:"subscribe",   subscription }          -> store subscription
//   POST { action:"unsubscribe", endpoint }              -> remove subscription
//   POST { action:"send", key|idToken, title, body, url?, dryRun? } -> broadcast (PUSH_ADMIN_KEY / allowlist gated)
//   POST { action:"history", key|idToken }                  -> log of sent broadcasts (same gate)
const webpush = require('web-push');
const { saveSub, removeSub, listSubs, pruneSub, logSend, listLog, getConfig, setConfig } = require('./_store');

// Everyone is implicitly in "all"; these are the opt-in extras a device may carry.
const VALID_GROUPS = ['youth', 'kids', 'admin'];

function subGroups(sub) { return Array.isArray(sub.groups) ? sub.groups : []; }

// auth: static admin key (programmatic) OR a Google ID token from an allowed account
async function authSender(body) {
  const adminKey = process.env.PUSH_ADMIN_KEY;
  if (adminKey && body.key === adminKey) return { authed: true, sender: 'API key' };
  if (!body.idToken) return { authed: false };
  try {
    const info = await (await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(body.idToken))).json();
    const email = String(info.email || '').toLowerCase();
    const okToken = info.aud === process.env.GOOGLE_CLIENT_ID && info.email_verified === 'true';
    const allowEmails = (process.env.PUSH_ALLOWED_EMAILS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    let authed;
    if (allowEmails.length) {
      authed = okToken && allowEmails.includes(email);   // strict allowlist when configured
    } else {
      const domains = (process.env.PUSH_ALLOWED_DOMAINS || 'revival.com').split(',').map(s => s.trim().toLowerCase());
      authed = okToken && domains.includes(email.split('@')[1] || '');
    }
    return { authed, sender: email };
  } catch (e) {
    return { authed: false };
  }
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'method not allowed' });
  }
  const body = req.body || {};
  try {
    if (body.action === 'subscribe') {
      const sub = body.subscription;
      if (!sub || !sub.endpoint || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) {
        return res.status(400).json({ ok: false, error: 'invalid subscription' });
      }
      const groups = (Array.isArray(body.groups) ? body.groups : [])
        .map((g) => String(g).toLowerCase()).filter((g) => VALID_GROUPS.includes(g));
      const { mode } = await saveSub(Object.assign({}, sub, { groups }));
      return res.status(200).json({ ok: true, mode, groups });
    }

    if (body.action === 'unsubscribe') {
      if (!body.endpoint) return res.status(400).json({ ok: false, error: 'missing endpoint' });
      const { mode } = await removeSub(body.endpoint);
      return res.status(200).json({ ok: true, mode });
    }

    if (body.action === 'send') {
      const adminKey = process.env.PUSH_ADMIN_KEY;
      const pub = process.env.VAPID_PUBLIC_KEY;
      const priv = process.env.VAPID_PRIVATE_KEY;
      if (!adminKey || !pub || !priv) {
        return res.status(503).json({ ok: false, error: 'push env vars not configured' });
      }
      const { authed, sender } = await authSender(body);
      if (!authed) return res.status(401).json({ ok: false, error: 'unauthorized' });

      const group = VALID_GROUPS.includes(body.group) ? body.group : 'all';
      const { subs, mode } = await listSubs();
      const counts = { all: subs.length };
      for (const g of VALID_GROUPS) counts[g] = subs.filter((x) => subGroups(x.sub).includes(g)).length;
      const targets = group === 'all' ? subs : subs.filter((x) => subGroups(x.sub).includes(group));
      if (body.dryRun) return res.status(200).json({ ok: true, dryRun: true, group, total: targets.length, counts, mode });
      if (!body.title || !body.body) return res.status(400).json({ ok: false, error: 'title and body required' });

      webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:tony@kingsarmscoffee.com', pub, priv);
      const payload = JSON.stringify({
        title: String(body.title).slice(0, 120),
        body: String(body.body).slice(0, 400),
        url: body.url || '/',
        icon: '/icon-192.png',
        badge: '/icon-192.png',
      });

      let sent = 0, failed = 0, pruned = 0; const errors = [];
      await Promise.all(targets.map(async ({ sub, pathname }) => {
        try {
          await webpush.sendNotification(sub, payload, { TTL: 3600 });
          sent++;
        } catch (e) {
          const code = e && e.statusCode;
          if (code === 404 || code === 410) { await pruneSub(pathname); pruned++; }
          else { failed++; if (errors.length < 3) errors.push(code || String(e && e.message).slice(0, 80)); }
        }
      }));
      // Log the broadcast; a logging failure must never fail the send itself.
      try {
        await logSend({
          ts: new Date().toISOString(),
          sender,
          group,
          title: String(body.title).slice(0, 120),
          body: String(body.body).slice(0, 400),
          url: body.url || '/',
          sent, failed, pruned, total: targets.length,
        });
      } catch (e) { /* ignore */ }
      return res.status(200).json({ ok: true, sent, failed, pruned, total: targets.length, group, mode, errors });
    }

    if (body.action === 'history') {
      const { authed } = await authSender(body);
      if (!authed) return res.status(401).json({ ok: false, error: 'unauthorized' });
      const { entries, mode } = await listLog();
      return res.status(200).json({ ok: true, entries, mode });
    }

    if (body.action === 'config') {
      // public read: the app uses this to decide which opt-in toggles to show
      const { config, mode } = await getConfig();
      return res.status(200).json({ ok: true, config, mode });
    }

    if (body.action === 'setConfig') {
      const { authed } = await authSender(body);
      if (!authed) return res.status(401).json({ ok: false, error: 'unauthorized' });
      const patch = {};
      if (typeof (body.config || {}).adminToggle === 'boolean') patch.adminToggle = body.config.adminToggle;
      if (!Object.keys(patch).length) return res.status(400).json({ ok: false, error: 'no valid config keys' });
      const { config, mode } = await setConfig(patch);
      return res.status(200).json({ ok: true, config, mode });
    }

    return res.status(400).json({ ok: false, error: 'unknown action' });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String((e && e.message) || e) });
  }
};
