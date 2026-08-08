// Subscription storage: Vercel Blob when BLOB_READ_WRITE_TOKEN is present,
// in-memory fallback otherwise (Fluid Compute instance reuse makes this good
// enough for smoke testing; link the Blob store for real durability).
const crypto = require('crypto');

const PREFIX = 'push-subs/';
const LOG_PREFIX = 'push-log/';
const hasBlob = () => !!process.env.BLOB_READ_WRITE_TOKEN;

const CFG_PATH = 'push-config/config.json';
const mem = (globalThis.__pushSubs = globalThis.__pushSubs || new Map());
const memLog = (globalThis.__pushLog = globalThis.__pushLog || []);
const memCfg = (globalThis.__pushCfg = globalThis.__pushCfg || {});

function idFor(endpoint) {
  return crypto.createHash('sha256').update(endpoint).digest('hex');
}

// Overwritten blobs keep their URL, and the CDN can serve stale content for a long
// time; cap the cache and bust it on read so overwrites (group changes, config
// flips) become visible quickly.
const FRESH_PUT_OPTS = {
  access: 'private',
  addRandomSuffix: false,
  contentType: 'application/json',
  allowOverwrite: true,
  cacheControlMaxAge: 60,
};

function bust(url) {
  return url + (url.indexOf('?') >= 0 ? '&' : '?') + '_cb=' + Date.now();
}

async function fetchBlobJson(item) {
  const res = await fetch(bust(item.downloadUrl || item.url), {
    headers: { authorization: 'Bearer ' + process.env.BLOB_READ_WRITE_TOKEN },
  });
  return res.ok ? res.json() : null;
}

async function saveSub(sub) {
  const id = idFor(sub.endpoint);
  if (hasBlob()) {
    const { put } = require('@vercel/blob');
    await put(PREFIX + id + '.json', JSON.stringify(sub), FRESH_PUT_OPTS);
    return { id, mode: 'blob' };
  }
  mem.set(id, sub);
  return { id, mode: 'memory' };
}

async function removeSub(endpoint) {
  const id = idFor(endpoint);
  if (hasBlob()) {
    const { del } = require('@vercel/blob');
    await del(PREFIX + id + '.json').catch(() => {});
    return { id, mode: 'blob' };
  }
  mem.delete(id);
  return { id, mode: 'memory' };
}

async function listSubs() {
  if (hasBlob()) {
    const { list } = require('@vercel/blob');
    const subs = [];
    let cursor;
    do {
      const page = await list({ prefix: PREFIX, cursor, limit: 1000 });
      for (const item of page.blobs) {
        try {
          const sub = await fetchBlobJson(item);
          if (sub) subs.push({ sub, pathname: item.pathname });
        } catch (e) { /* skip unreadable blob */ }
      }
      cursor = page.cursor;
    } while (cursor);
    return { subs, mode: 'blob' };
  }
  return {
    subs: [...mem.entries()].map(([id, sub]) => ({ sub, pathname: PREFIX + id + '.json' })),
    mode: 'memory',
  };
}

async function pruneSub(pathname) {
  if (hasBlob()) {
    const { del } = require('@vercel/blob');
    await del(pathname).catch(() => {});
  } else {
    mem.delete(pathname.replace(PREFIX, '').replace('.json', ''));
  }
}

async function logSend(entry) {
  if (hasBlob()) {
    const { put } = require('@vercel/blob');
    const id = Date.now() + '-' + crypto.randomBytes(4).toString('hex');
    await put(LOG_PREFIX + id + '.json', JSON.stringify(entry), FRESH_PUT_OPTS);
    return { mode: 'blob' };
  }
  memLog.push(entry);
  return { mode: 'memory' };
}

async function listLog() {
  if (hasBlob()) {
    const { list } = require('@vercel/blob');
    const entries = [];
    let cursor;
    do {
      const page = await list({ prefix: LOG_PREFIX, cursor, limit: 1000 });
      for (const item of page.blobs) {
        try {
          const entry = await fetchBlobJson(item);
          if (entry) entries.push(entry);
        } catch (e) { /* skip unreadable blob */ }
      }
      cursor = page.cursor;
    } while (cursor);
    entries.sort((a, b) => String(b.ts || '').localeCompare(String(a.ts || '')));
    return { entries, mode: 'blob' };
  }
  return { entries: [...memLog].reverse(), mode: 'memory' };
}

// Config is written as immutable versioned blobs (push-config/v-<ts>.json) because
// overwriting a fixed path leaves reads stale for up to ~60s (origin propagation).
// New blobs list and fetch instantly. Older versions are pruned on each write.
const CFG_VER_PREFIX = 'push-config/v-';

async function getConfig() {
  if (hasBlob()) {
    const { list } = require('@vercel/blob');
    try {
      const page = await list({ prefix: 'push-config/', limit: 1000 });
      const vers = page.blobs.filter((b) => b.pathname.indexOf(CFG_VER_PREFIX) === 0);
      const pick = vers.length
        ? vers.reduce((a, b) => (a.pathname > b.pathname ? a : b))
        : page.blobs.find((b) => b.pathname === CFG_PATH); // legacy overwrite-style blob
      if (pick) {
        const config = await fetchBlobJson(pick);
        if (config) return { config, mode: 'blob' };
      }
    } catch (e) { /* fall through to defaults */ }
    return { config: {}, mode: 'blob' };
  }
  return { config: memCfg, mode: 'memory' };
}

async function setConfig(patch) {
  const next = Object.assign({}, (await getConfig()).config, patch);
  if (hasBlob()) {
    const { put, list, del } = require('@vercel/blob');
    const pathname = CFG_VER_PREFIX + String(Date.now()).padStart(14, '0') + '.json';
    await put(pathname, JSON.stringify(next), FRESH_PUT_OPTS);
    // best-effort prune of older versions (and the legacy config.json)
    try {
      const page = await list({ prefix: 'push-config/', limit: 1000 });
      const stale = page.blobs.map((b) => b.pathname).filter((p) => p !== pathname);
      if (stale.length) await del(stale);
    } catch (e) { /* pruning is optional */ }
    return { config: next, mode: 'blob' };
  }
  Object.assign(memCfg, patch);
  return { config: memCfg, mode: 'memory' };
}

module.exports = { saveSub, removeSub, listSubs, pruneSub, logSend, listLog, getConfig, setConfig };
