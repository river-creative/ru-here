# River University App (ru-here)

Handoff notes from the FIRE CONF app team (Tony / the parent project's Claude sessions).
This app is a fork of **river-creative/rmihq-map** (the FIRE CONF 2026 event app,
live at map.fire.revival.com). That parent repo absorbed weeks of production
hardening **after** this fork was taken — read this file before touching
service workers, navigation, or installed-app (PWA) behavior, or you will
re-hit bugs we already fixed in production.

## What this repo is

- Static, no-build single-file app: `index.html` (~1.7MB, inline CSS/JS + three.js
  campus map), hosted on Vercel. Push to `main` = production deploy once linked.
- Spanish twins: `index-es.html`, `handbook-es.html`. **Any content edit to
  `index.html` or `handbook.html` likely needs mirroring into the `-es` files.**
- `handbook.html` — R.U. 1st Quarter Curriculum 2026–2027.
- This repo is **public**: never commit secrets, API keys, or admin URLs.

## ⚠️ Broken as of the fork: PWA plumbing is missing

`index.html` registers `/sw.js` and references a web-app manifest, and
`vercel.json` sets no-cache headers for `/sw.js` — **but neither `sw.js` nor
`manifest.webmanifest` exists in this repo.** Result: add-to-home-screen,
offline mode, and push notifications are silent 404s.

Fix: copy `sw.js` and `manifest.webmanifest` from **rmihq-map `main` (any commit
after 2026-07-14)** and rebrand the manifest (name, icons, theme color). Do NOT
copy from an older commit — the early sw.js had a cache-poisoning bug (below).
If PWA features aren't wanted, instead strip the `serviceWorker.register` call
and the apple-mobile-web-app meta tags.

## Hard-won iOS/PWA rules (violate these and you ship white screens)

1. **iOS standalone navigation must use `location.replace()`** for every
   cross-page navigation (detect standalone via
   `matchMedia('(display-mode: standalone)').matches || navigator.standalone`).
   Keeping history depth-1 means the edge-swipe back gesture has nothing to
   restore. If history grows, iOS may restore a memory-evicted page as a **dead
   white screen** that only force-quit fixes. Never call `history.back()` in
   standalone. (This 1.7MB WebGL page is a prime eviction target.)
2. **`WindowClient.navigate()` does not work on iOS.** A push notification
   click handler must `postMessage({nav:url})` to the focused client and let the
   page navigate itself (delay the page-side navigation ~250ms — navigating
   during iOS resume can also kill the webview). See parent repo's sw.js +
   the `navigator.serviceWorker.addEventListener('message', ...)` block.
3. **Service worker fetch handler: only cache `'/'` for requests whose pathname
   is `'/'`.** The original handler cached EVERY navigation response under the
   `'/'` key, so visiting any other page poisoned the offline app shell.
4. **`apple-mobile-web-app-status-bar-style` must be `black`, not
   `black-translucent`** (translucent letterboxes the installed app: dead strip
   below the tab bar). This meta is baked at install time — users must delete
   and re-add the app to pick up a change.
5. **`element.scrollTo({behavior:'smooth'})` silently no-ops on older iOS**, and
   embedded webviews can suspend BOTH `requestAnimationFrame` and scroll events
   entirely. Animated scrolling must be `setTimeout`-driven; scroll-spy logic
   needs a polling fallback. (Parent repo: `nwsScrollTo` / poll pattern in
   newspaper.html.)
6. **CSS: a media-query override loses to a later base rule of equal
   specificity.** Keep `@media (display-mode: standalone)` overrides AFTER the
   base rules they override (this bit us on tab-bar padding: the standalone
   tweak was silently dead and a bottom sheet rendered behind the bar).
7. **Lazy images need baked `aspect-ratio` styles** (compute from the real image
   dimensions). Without them, late loads shift layout and anchor-jumps land in
   the wrong place.
8. **Safari and the installed PWA have separate storage** on iOS: localStorage,
   service worker, and push subscription do not transfer between them.

## Strongly recommended port: silent auto-update

Installed PWAs otherwise require a force-quit ritual (sometimes twice) to see
new deploys. The parent repo ships a small self-updater you can lift verbatim
from `rmihq-map/index.html` (search `auto_update_reload`):

- HEAD-poll the page's own URL with `cache:'no-store'` every 10 min and on every
  return-to-foreground; compare the **ETag** to the load-time baseline.
  (Do NOT rely on `controllerchange` — sw.js bytes rarely change per deploy.)
- When the ETag moves, reload at unnoticeable moments only: right after resume,
  or after 60s with no user interaction. Persist any state (active tab, scroll
  position) before reloading so the reload is invisible.

## Working conventions

- Prefer real git commits (Claude Code can commit/push) over the GitHub web
  "upload files" flow — upload-and-delete cycles destroy diffability and make
  collaborating with the parent project's sessions much harder.
- Test installed-app behavior on a physical iPhone; desktop Chromium hides every
  bug listed above. A change can look perfect in browser preview and white-screen
  in standalone.
- Analytics: the FIRE CONF app uses GA property `G-QVBXMKZHM4` (fire.revival.com).
  If this fork still contains that ID, replace it with an R.U.-specific property
  before launch or R.U. traffic will pollute FIRE CONF data.
- The pavilion booth diagram inside index.html is an inline `srcdoc` iframe — a
  historical artifact from before the SW fix. It's safe to leave, or to extract
  to its own page now that navigations don't poison the cache (parent repo's
  newspaper.html shows the standalone-page pattern end-to-end).

## Where to look in the parent repo (river-creative/rmihq-map, `main`)

| Concern | Look at |
|---|---|
| Correct sw.js (nav caching, push, notification click, runtime image cache) | `sw.js` |
| Silent auto-update snippet | `index.html` (search `auto_update_reload`) |
| Standalone `location.replace()` navigation policy | `index.html` + `newspaper.html` (search `isStandalone()` / `nwsStandalone`) |
| Standalone content page done right (reader, themes, offline) | `newspaper.html` |
| Deep-link params pattern (`?tab=`, `?booth=1`) | `index.html` boot code |

Questions about any of this: ask Tony — his Claude sessions carry the full
history of why each rule exists.
