// ==UserScript==
// @name         Steam Ownership Highlighter - Stable
// @namespace    https://github.com/wolfyrion
// @version      5.7.3
// @description  Steam ownership and wishlist badges (including name matching on Humble, Fanatical, IndieGala and Green Man Gaming), resilient refresh, safe owned-row filtering, and Steam/ITAD hover prices.
// @author       Wolfyrion + ChatGPT
// @homepageURL  https://github.com/wolfyrion/tampermonkey-scripts
// @supportURL   https://github.com/wolfyrion/tampermonkey-scripts/issues
// @updateURL    https://raw.githubusercontent.com/wolfyrion/tampermonkey-scripts/main/steam-ownership-highlighter/steam-ownership-highlighter.user.js
// @downloadURL  https://raw.githubusercontent.com/wolfyrion/tampermonkey-scripts/main/steam-ownership-highlighter/steam-ownership-highlighter.user.js
// @match        https://www.steamgifts.com/*
// @match        https://www.reddit.com/r/GameDeals/*
// @match        https://www.reddit.com/r/FreeGameFindings/*
// @match        https://old.reddit.com/r/GameDeals/*
// @match        https://old.reddit.com/r/FreeGameFindings/*
// @match        https://gg.deals/*
// @match        https://isthereanydeal.com/*
// @match        https://www.indiegala.com/*
// @match        https://www.humblebundle.com/*
// @match        https://www.fanatical.com/*
// @match        https://www.greenmangaming.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addStyle
// @grant        GM_registerMenuCommand
// @grant        GM_addValueChangeListener
// @connect      store.steampowered.com
// @connect      api.isthereanydeal.com
// @connect      www.fanatical.com
// @noframes
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const VERSION = '5.7.3';
  const USERDATA_URL = 'https://store.steampowered.com/dynamicstore/userdata/';
  const CACHE_KEY = 'steam_highlighter_stable_userdata_v1';
  const SETTINGS_KEY = 'steam_highlighter_stable_settings_v1';
  const LOCK_KEY = 'steam_highlighter_stable_refresh_lock_v1';
  const ERROR_TOAST_KEY = 'steam_highlighter_stable_error_toast_v1';

  const LOCK_MS = 30000;              // one tab refreshes, the others wait
  const ERROR_TOAST_MS = 30 * 60000;  // background errors toast at most every 30 min
  const RETRY_MIN_MS = 60000;
  const RETRY_MAX_MS = 30 * 60000;
  const MAX_CONCURRENT = 4;
  const INFO_TTL_MS = 5 * 60000;
  const INFO_ERROR_TTL_MS = 30000;

  // Bundle and store pages that list games by name instead of linking to
  // Steam. Names are matched to Steam app IDs and a small "Steam" link is
  // injected next to each title. Title selectors are best guesses; the
  // "Pick Game Titles on This Page" menu command teaches the script any site.
  const NAME_CACHE_KEY = 'steam_highlighter_humble_matches_v2'; // name kept so saved matches survive
  const LEARNED_KEY = 'steam_highlighter_learned_titles_v1';
  const NAME_HIT_TTL = 30 * 86400000;  // confirmed matches kept 30 days
  const NAME_MISS_TTL = 86400000;      // "no match" retried after 1 day
  const NAME_SOFT_MISS_TTL = 10 * 60000; // Steam returned no results at all: likely throttled, retry soon
  const MAX_NAME_SEARCHES = 120;       // names searched per page load (protects against rate limits)
  const SEARCH_GAP_MS = 350;           // pause between Steam searches
  const SEARCH_COOLDOWN_MS = 60000;    // pause after Steam refuses a search (HTTP 429)

  const SITES = {
    'www.humblebundle.com': {
      titles: ['.item-title', '.product-title', '.entity-title', '.human_name-view'],
      jsonScripts: 'script#webpack-bundle-page-data, script#webpack-json-data, ' +
        'script#storefront-webpack-json-data, script[type="application/json"]',
      jsonNameKey: 'human_name'
    },
    'www.fanatical.com': {
      titles: ['.bundle-product-card__title', '.card-product-name', '.product-name', '.hitCardStripe__seoName'],
      api: () => fanaticalApiUrls(),
      altTitles: true,   // cover images carry the game name in alt text
      cornerBadge: true  // titles only appear on hover, so always show the corner chip
    },
    'www.indiegala.com': {
      titles: ['.bundle-page-tier-item-title', '.bundle-page-tier-item-name', '.store-product-header-title']
    },
    'www.greenmangaming.com': {
      titles: ['.bundle-game-title', '.bundle-item .prod-name', '.prod-name', '.product-title']
    }
  };
  const SITE = SITES[location.hostname] || null;

  const STEAM_HOSTS = new Set(['store.steampowered.com', 'steamdb.info', 'steamcommunity.com']);
  const STATUSES = ['owned', 'wishlist', 'followed', 'ignored', 'missing', 'unknown'];

  const COLORS = {
    unknown: '#8b949e', owned: '#2ea043', wishlist: '#388bfd',
    followed: '#a371f7', ignored: '#f0883e', missing: '#da3633'
  };
  const LABELS = {
    unknown: 'Ownership unknown', owned: 'Owned', wishlist: 'Wishlisted',
    followed: 'Followed', ignored: 'Ignored', missing: 'Not owned'
  };
  const SYMBOLS = {
    unknown: '?', owned: '✓', wishlist: 'W', followed: 'F', ignored: 'I', missing: '✕'
  };

  const DEFAULTS = {
    enabled: true,
    panelMode: 'normal', // normal | icon | hidden
    dimMode: 'off',      // off | dim | hide
    wishlistOnly: false,
    hoverInfo: true,
    country: 'cy',
    itadKey: '',
    cacheMinutes: 60,
    nearAtlPct: 10
  };

  // Hide only a known list entry, never a generic article containing many posts.
  const ROW_SELECTOR = [
    '.giveaway__row-outer-wrap', '.table__row-outer-wrap',
    '.thing', 'shreddit-post', 'tr', 'li',
    '.tier-item-view' // Humble Bundle tiles
  ].join(',');
  const UI_SELECTOR = '#sg-panel,#sg-mini,#sg-tip,#sg-toast,#sg-pick';
  const LINK_SELECTOR = [
    'a[href*="store.steampowered.com/"]',
    'a[href*="steamdb.info/"]',
    'a[href*="steamcommunity.com/app/"]',
    'a[data-sg-key]'
  ].join(',');

  let settings = loadSettings();
  let data = emptyData();
  let panel = null;
  let mini = null;
  let tip = null;
  let updateTimer = null;
  let hoverTimer = null;
  let toastTimer = null;
  let currentHover = null;

  // Registry of marked links, so updates never re-query the whole document.
  const tracked = new Set();
  let markedRows = new Set();
  let markedLinks = new Set();

  const infoCache = new Map();
  const moneyFormats = new Map();
  let refreshPromise = null;
  let dataState = 'loading';
  let lastError = '';
  let hoverSequence = 0;
  let forcePanel = false;
  let retryDelay = RETRY_MIN_MS;
  let nextAutoAttempt = 0;
  let activeRequests = 0;
  const requestQueue = [];

  /* ---------------------------------------------------------------- *
   * Settings and cache
   * ---------------------------------------------------------------- */

  function normalizeSettings(value) {
    const result = { ...DEFAULTS, ...(value && typeof value === 'object' ? value : {}) };
    result.panelMode = ['normal', 'icon', 'hidden'].includes(result.panelMode) ? result.panelMode : 'normal';
    result.dimMode = ['off', 'dim', 'hide'].includes(result.dimMode) ? result.dimMode : 'off';
    result.country = /^[a-z]{2}$/i.test(String(result.country)) ? String(result.country).toLowerCase() : 'cy';
    result.cacheMinutes = Math.min(1440, Math.max(1, Number(result.cacheMinutes) || 60));
    result.nearAtlPct = Math.min(100, Math.max(0, Number(result.nearAtlPct) || 0));
    result.itadKey = String(result.itadKey || '').trim();
    for (const key of ['enabled', 'wishlistOnly', 'hoverInfo']) result[key] = !!result[key];
    return result;
  }

  function loadSettings() {
    return normalizeSettings(GM_getValue(SETTINGS_KEY, {}));
  }

  function saveSettings() {
    settings = normalizeSettings(settings);
    GM_setValue(SETTINGS_KEY, settings);
  }

  function emptyData() {
    return {
      apps: new Set(), subs: new Set(), wishlist: new Set(),
      followed: new Set(), ignored: new Set(), loadedAt: 0
    };
  }

  function validCache(cache) {
    return !!cache && Number.isFinite(cache.time) && cache.time > 0 &&
      ['apps', 'subs', 'wishlist', 'followed', 'ignored'].every(key => Array.isArray(cache[key]));
  }

  function readCache() {
    const cache = GM_getValue(CACHE_KEY, null);
    return validCache(cache) ? cache : null;
  }

  function acceptCache(cache) {
    if (cache.time === data.loadedAt) return; // already loaded; skip rebuilding large Sets
    data = {
      apps: new Set(toIds(cache.apps)), subs: new Set(toIds(cache.subs)),
      wishlist: new Set(toIds(cache.wishlist)), followed: new Set(toIds(cache.followed)),
      ignored: new Set(toIds(cache.ignored)), loadedAt: cache.time
    };
  }

  /* ---------------------------------------------------------------- *
   * Helpers
   * ---------------------------------------------------------------- */

  function textIfChanged(element, value) {
    if (element && element.textContent !== String(value)) element.textContent = String(value);
  }

  function toIds(value) {
    return (Array.isArray(value) ? value : Object.keys(value || {}))
      .map(Number)
      .filter(id => Number.isSafeInteger(id) && id > 0);
  }

  function normalizeType(type) {
    return /^(sub|package)$/i.test(String(type || '')) ? 'sub' : 'app';
  }

  function steamKey(type, id) {
    return `${normalizeType(type)}:${Number(id)}`;
  }

  function parseKey(key) {
    const m = /^(app|sub):(\d+)$/.exec(String(key || ''));
    return m ? { type: m[1], id: Number(m[2]) } : null;
  }

  function parseSteamUrl(url) {
    try {
      const parsed = new URL(String(url || ''));
      if (!['http:', 'https:'].includes(parsed.protocol) ||
          !STEAM_HOSTS.has(parsed.hostname) ||
          parsed.username || parsed.password) return null;
      const pattern = parsed.hostname === 'steamcommunity.com'
        ? /^\/(app)\/([1-9]\d*)(?:\/|$)/i
        : /^\/(?:agecheck\/)?(app|sub|package)\/([1-9]\d*)(?:\/|$)/i;
      const match = pattern.exec(parsed.pathname);
      const id = Number(match?.[2]);
      return match && Number.isSafeInteger(id) ? { type: normalizeType(match[1]), id } : null;
    } catch (_) { return null; }
  }

  function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  function money(amount, currency = 'EUR') {
    const n = Number(amount);
    if (!Number.isFinite(n)) return '';
    try {
      let format = moneyFormats.get(currency);
      if (!format) {
        format = new Intl.NumberFormat(undefined, { style: 'currency', currency });
        moneyFormats.set(currency, format);
      }
      return format.format(n);
    } catch (_) {
      return `${n.toFixed(2)} ${currency || ''}`.trim();
    }
  }

  /* ---------------------------------------------------------------- *
   * Network
   * ---------------------------------------------------------------- */

  // Hover requests share a bounded queue. It is LIFO so the link the user is
  // pointing at now is served before ones they swept past.
  function pumpRequests() {
    while (activeRequests < MAX_CONCURRENT && requestQueue.length) requestQueue.pop()();
  }

  function gm(opts, queued = false) {
    return new Promise((resolve, reject) => {
      const start = () => {
        if (queued) activeRequests++;
        let finished = false;
        const finish = (error, response) => {
          if (finished) return;
          finished = true;
          if (queued) { activeRequests--; pumpRequests(); }
          if (error) reject(error); else resolve(response);
        };
        try {
          GM_xmlhttpRequest({
            timeout: 20000, ...opts,
            onload: response => finish(response.status >= 200 && response.status < 300
              ? null : new Error(`HTTP ${response.status}`), response),
            onerror: () => finish(new Error('Network error')),
            ontimeout: () => finish(new Error('Timed out')),
            onabort: () => finish(new Error('Request cancelled'))
          });
        } catch (error) { finish(error); }
      };
      if (queued) { requestQueue.push(start); pumpRequests(); } else start();
    });
  }

  async function gmJson(opts, queued = false) {
    const response = await gm(opts, queued);
    try { return JSON.parse(response.responseText); }
    catch (_) { throw new Error('Invalid JSON response; the service may require login.'); }
  }

  async function fetchUserData() {
    const d = await gmJson({
      method: 'GET',
      url: `${USERDATA_URL}?t=${Date.now()}`,
      anonymous: false
    });

    if (!d || !Array.isArray(d.rgOwnedApps) || !Array.isArray(d.rgOwnedPackages)) {
      throw new Error('Unexpected Steam response. Check your Steam Store login.');
    }
    const apps = toIds(d.rgOwnedApps);
    const subs = toIds(d.rgOwnedPackages);

    if (!apps.length && !subs.length) {
      throw new Error(
        'Steam returned no owned apps or packages. Check your Steam Store login; an empty account cannot be verified by this endpoint.'
      );
    }

    return {
      apps,
      subs,
      wishlist: toIds(d.rgWishlist),
      followed: toIds(d.rgFollowedApps),
      ignored: toIds(d.rgIgnoredApps),
      time: Date.now()
    };
  }

  function errorToast(message, force) {
    if (!force) {
      const last = Number(GM_getValue(ERROR_TOAST_KEY, 0));
      if (Date.now() - last < ERROR_TOAST_MS) return;
    }
    GM_setValue(ERROR_TOAST_KEY, Date.now());
    toast(message, true, 6500);
  }

  async function loadData(force = false) {
    if (refreshPromise) return refreshPromise;
    refreshPromise = (async () => {
      const cache = readCache();
      if (cache) acceptCache(cache);
      const ttl = settings.cacheMinutes * 60000;

      if (!force && cache && Date.now() - cache.time < ttl) {
        dataState = 'ready'; lastError = ''; return true;
      }

      // Another tab is refreshing right now: keep the saved data and let the
      // value-change listener deliver the new copy.
      if (!force && cache && Date.now() - Number(GM_getValue(LOCK_KEY, 0)) < LOCK_MS) {
        dataState = 'ready'; return true;
      }

      GM_setValue(LOCK_KEY, Date.now());
      dataState = 'loading'; scheduleUpdate();
      try {
        const fresh = await fetchUserData();
        GM_setValue(CACHE_KEY, fresh);
        acceptCache(fresh);
        dataState = 'ready'; lastError = ''; return true;
      } catch (error) {
        lastError = error.message;
        dataState = data.loadedAt ? 'cached' : 'error';
        errorToast(`${data.loadedAt ? 'Using saved data. ' : ''}${lastError}`, force);
        return false;
      } finally {
        GM_setValue(LOCK_KEY, 0);
      }
    })();
    try { return await refreshPromise; }
    finally { refreshPromise = null; scheduleUpdate(); }
  }

  function noteRefreshResult(ok) {
    if (ok) {
      retryDelay = RETRY_MIN_MS;
      nextAutoAttempt = 0;
    } else {
      nextAutoAttempt = Date.now() + retryDelay;
      retryDelay = Math.min(retryDelay * 2, RETRY_MAX_MS);
    }
  }

  // Background refresh: retries even when the first load failed (e.g. logged
  // out), with exponential backoff, and stays quiet about repeated errors.
  async function autoRefresh() {
    if (document.hidden || !settings.enabled || refreshPromise) return;
    const stale = !data.loadedAt || Date.now() - data.loadedAt >= settings.cacheMinutes * 60000;
    if (!stale || Date.now() < nextAutoAttempt) return;
    noteRefreshResult(await loadData(false));
    updateAllStatuses();
  }

  function getStatus(type, id) {
    type = normalizeType(type);
    id = Number(id);

    if (!data.loadedAt) return 'unknown';
    if (type === 'sub') return data.subs.has(id) ? 'owned' : 'missing';
    if (data.apps.has(id)) return 'owned';
    if (data.wishlist.has(id)) return 'wishlist';
    if (data.followed.has(id)) return 'followed';
    if (data.ignored.has(id)) return 'ignored';
    return 'missing';
  }

  /* ---------------------------------------------------------------- *
   * Styles
   * ---------------------------------------------------------------- */

  let css = `
    body.sg-enabled a[data-sg-status] {
      background:linear-gradient(90deg, color-mix(in srgb, var(--sg-c) 10%, transparent) 0%, transparent 78%) !important;
      color:inherit !important;
      border-left:3px solid var(--sg-c) !important;
      border-radius:3px !important;
      padding-left:5px !important;
      text-decoration-color:var(--sg-c) !important;
    }
    body.sg-enabled a[data-sg-status]:hover {
      background:color-mix(in srgb, var(--sg-c) 13%, transparent) !important;
    }
    body.sg-enabled a[data-sg-status]::after {
      display:inline-block; margin-left:5px; min-width:15px; height:15px; padding:0 3px;
      border-radius:8px; background:var(--sg-c); color:#fff;
      font:700 10px/15px system-ui,sans-serif; text-align:center; vertical-align:1px;
      box-sizing:border-box; text-shadow:none;
    }
  `;
  for (const status of STATUSES) {
    css += `
      a[data-sg-status="${status}"] { --sg-c:${COLORS[status]}; }
      body.sg-enabled a[data-sg-status="${status}"]::after { content:"${SYMBOLS[status]}"; }
    `;
  }

  css += `
    body.sg-dim .sg-row-owned, body.sg-dim .sg-link-owned { opacity:.30 !important; transition:opacity .15s !important; }
    body.sg-dim .sg-row-owned:hover, body.sg-dim .sg-link-owned:hover { opacity:1 !important; }
    body.sg-hide .sg-row-owned { display:none !important; }
    body.sg-hide .sg-link-owned { opacity:.18 !important; }
    body.sg-wishlist-only a[data-sg-status]:not([data-sg-status="wishlist"]) { opacity:.15 !important; filter:grayscale(.75); }

    #sg-panel {
      position:fixed; right:12px; bottom:12px; z-index:2147483647;
      width:280px; max-width:calc(100vw - 24px); max-height:calc(100vh - 24px); overflow-y:auto;
      background:#161b22; color:#e6edf3; border:1px solid #30363d; border-radius:8px;
      box-shadow:0 5px 20px rgba(0,0,0,.48); font:12px/1.4 system-ui,sans-serif;
    }
    #sg-panel [hidden] { display:none !important; }
    #sg-head { display:flex; justify-content:space-between; align-items:center; padding:7px 8px; border-bottom:1px solid #30363d; }
    #sg-head b { font-size:12px; }
    #sg-version { opacity:.5; font-size:9px; margin-left:4px; }
    #sg-head button { margin-left:3px; }
    #sg-panel button, #sg-panel select, #sg-panel input {
      font:inherit; color:#e6edf3; background:#0d1117; border:1px solid #30363d; border-radius:4px; padding:3px 6px;
    }
    #sg-panel button { cursor:pointer; }
    #sg-panel button:hover { background:#21262d; }
    #sg-panel button:disabled { opacity:.55; cursor:wait; }
    #sg-panel button:focus-visible, #sg-mini:focus-visible { outline:2px solid #58a6ff; outline-offset:2px; }
    #sg-summary, #sg-actions, #sg-settings { padding:8px; }
    .sg-line { display:flex; justify-content:space-between; gap:8px; }
    #sg-health { padding:7px 8px; border-top:1px solid #30363d; font-size:11px; overflow-wrap:anywhere; }
    #sg-health[data-error="true"] { color:#f0b45e; }
    #sg-actions { border-top:1px solid #30363d; display:grid; grid-template-columns:1fr 1fr; gap:5px; }
    #sg-actions button { width:100%; }
    #sg-settings { border-top:1px solid #30363d; display:grid; gap:6px; }
    #sg-settings label { display:flex; justify-content:space-between; align-items:center; gap:8px; }
    #sg-settings input[type="text"], #sg-settings input[type="password"] { width:105px; }
    #sg-settings input[type="number"] { width:60px; }
    #sg-settings small { opacity:.65; }

    a.sg-humble-link {
      display:inline-block; margin-left:6px; vertical-align:middle; white-space:nowrap;
      font:600 11px/1.4 system-ui,sans-serif; color:inherit; text-decoration:none !important;
    }
    body:not(.sg-enabled) a.sg-humble-link { display:none !important; }
    .sg-humble-row {
      display:block; flex-basis:100%; width:100%; margin:2px 0 4px;
      font:600 12px/1.4 system-ui,sans-serif;
    }
    .sg-humble-row a.sg-humble-store { color:#66c0f4 !important; text-decoration:none !important; }
    .sg-humble-row a.sg-humble-store:hover { text-decoration:underline !important; }
    .sg-humble-note { opacity:.6; font-weight:400; }
    body:not(.sg-enabled) .sg-humble-row { display:none !important; }
    /* Corner chip: always-visible status on cards whose title is hover-only */
    body.sg-enabled a.sg-corner, a.sg-corner {
      position:absolute !important; top:6px !important; right:6px !important; left:auto !important;
      z-index:20 !important; margin:0 !important; padding:2px 6px !important;
      border-radius:4px !important; background:rgba(13,17,23,.88) !important;
      color:#e6edf3 !important; font:600 11px/16px system-ui,sans-serif !important;
      text-decoration:none !important; box-shadow:0 1px 4px rgba(0,0,0,.55) !important;
      white-space:nowrap !important;
    }
    a.sg-corner-miss { opacity:.85; }
    body:not(.sg-enabled) a.sg-corner { display:none !important; }
    #sg-pick {
      position:fixed; z-index:2147483646; pointer-events:none; box-sizing:border-box;
      border:2px solid #58a6ff; background:rgba(88,166,255,.12); border-radius:3px;
    }

    #sg-mini {
      position:fixed; right:12px; bottom:12px; z-index:2147483647; width:38px; height:38px;
      border-radius:50%; border:1px solid #30363d; background:#161b22; color:#e6edf3;
      box-shadow:0 4px 16px rgba(0,0,0,.45); cursor:pointer;
      font:700 18px/38px system-ui,sans-serif; padding:0; text-align:center;
    }

    #sg-tip {
      position:fixed; z-index:2147483647; min-width:220px; max-width:min(340px, calc(100vw - 16px));
      max-height:calc(100vh - 16px); overflow:hidden; padding:9px 10px; box-sizing:border-box;
      background:#161b22; color:#e6edf3; border:1px solid #30363d; border-radius:7px;
      box-shadow:0 5px 18px rgba(0,0,0,.55); font:12px/1.45 system-ui,sans-serif; pointer-events:none;
    }
    #sg-tip .title { font-weight:700; font-size:13px; margin-bottom:3px; }
    #sg-tip .dot { display:inline-block; width:9px; height:9px; border-radius:50%; margin-right:5px; }
    #sg-tip .good { color:#3fb950; font-weight:700; }
    #sg-tip .warn { color:#d29922; font-weight:700; }
    #sg-tip hr { border:0; border-top:1px solid #30363d; margin:6px 0; }

    #sg-toast {
      position:fixed; left:50%; top:22px; transform:translateX(-50%); z-index:2147483647; max-width:520px;
      background:#161b22; color:#e6edf3; border:1px solid #30363d; border-radius:7px; padding:9px 12px;
      box-shadow:0 4px 18px rgba(0,0,0,.5); font:600 12px/1.35 system-ui,sans-serif; text-align:center;
    }
  `;
  GM_addStyle(css);

  /* ---------------------------------------------------------------- *
   * Link marking
   * ---------------------------------------------------------------- */

  function unmarkLink(a) {
    if (currentHover === a) cancelHover();
    delete a.dataset.sgKey;
    delete a.dataset.sgStatus;
    a.classList.remove('sg-link-owned');
    tracked.delete(a);
  }

  function markLink(a) {
    if (!a || a.tagName !== 'A' || a.closest(UI_SELECTOR) || a.classList.contains('sg-humble-store')) return false;

    const parsed = a.hasAttribute('href') ? parseSteamUrl(a.href) : null;

    if (!parsed) {
      if (a.dataset.sgKey) { unmarkLink(a); return true; }
      return false;
    }

    const key = steamKey(parsed.type, parsed.id);
    const status = getStatus(parsed.type, parsed.id);
    tracked.add(a); // re-add even if unchanged: the node may have been moved back into the DOM

    if (a.dataset.sgKey === key && a.dataset.sgStatus === status) return false;
    if (currentHover === a && a.dataset.sgKey !== key) cancelHover();

    a.dataset.sgKey = key;
    a.dataset.sgStatus = status;
    return true;
  }

  function scan(root = document) {
    if (!settings.enabled) return;

    let changed = false;
    if (root.matches?.('a') && markLink(root)) changed = true;
    if (root.querySelectorAll) {
      for (const a of root.querySelectorAll(LINK_SELECTOR)) {
        if (markLink(a)) changed = true;
      }
    }
    if (changed) scheduleUpdate();
  }

  function liveTargets() {
    for (const a of tracked) {
      if (!a.isConnected || !a.dataset.sgKey) tracked.delete(a);
    }
    return tracked;
  }

  function hasTargets() {
    return liveTargets().size > 0;
  }

  function uniqueTargets() {
    const map = new Map();
    for (const a of liveTargets()) {
      const key = a.dataset.sgKey;
      if (!map.has(key)) map.set(key, a.dataset.sgStatus);
    }
    return map;
  }

  function updateAllStatuses() {
    for (const a of liveTargets()) {
      const parsed = parseKey(a.dataset.sgKey);
      if (!parsed) continue;
      const status = getStatus(parsed.type, parsed.id);
      if (a.dataset.sgStatus !== status) a.dataset.sgStatus = status;
    }
    scheduleUpdate();
  }

  function applyClasses() {
    if (!document.body) return;
    const on = settings.enabled;
    document.body.classList.toggle('sg-enabled', on);
    document.body.classList.toggle('sg-dim', on && settings.dimMode === 'dim');
    document.body.classList.toggle('sg-hide', on && settings.dimMode === 'hide');
    document.body.classList.toggle('sg-wishlist-only', on && settings.wishlistOnly);
  }

  function applyOwnedMode() {
    const ownedRows = new Set();
    const ownedLinks = new Set();

    if (settings.enabled && settings.dimMode !== 'off' && data.loadedAt) {
      const rowVerdict = new Map(); // evaluate each row once, not once per link
      for (const a of liveTargets()) {
        if (a.dataset.sgStatus !== 'owned') continue;
        const byName = a.classList.contains('sg-humble-link');
        const row = byName ? nameTile(a) : a.closest(ROW_SELECTOR);
        let hideRow = false;
        if (row) {
          if (!rowVerdict.has(row)) {
            const links = row.querySelectorAll('a[data-sg-status]');
            // Never hide a parent that contains a nested list entry or an unowned game.
            rowVerdict.set(row,
              (byName || !row.querySelector(ROW_SELECTOR)) && links.length > 0 &&
              [...links].every(link => link.dataset.sgStatus === 'owned'));
          }
          hideRow = rowVerdict.get(row);
        }
        if (hideRow) ownedRows.add(row); else ownedLinks.add(a);
      }
    }

    for (const row of markedRows) if (!ownedRows.has(row)) row.classList.remove('sg-row-owned');
    for (const link of markedLinks) if (!ownedLinks.has(link)) link.classList.remove('sg-link-owned');
    for (const row of ownedRows) row.classList.add('sg-row-owned');
    for (const link of ownedLinks) link.classList.add('sg-link-owned');
    markedRows = ownedRows;
    markedLinks = ownedLinks;
  }

  function scheduleUpdate() {
    if (updateTimer !== null) return;
    updateTimer = setTimeout(() => {
      updateTimer = null;
      applyClasses();
      applyOwnedMode();
      updateUi();
      renderSummary();
      renderHealth();
    }, 120);
  }

  /* ---------------------------------------------------------------- *
   * Panel
   * ---------------------------------------------------------------- */

  function ensureUi() {
    if (!panel) buildPanel();
    if (!mini) buildMini();
  }

  function updateUi() {
    if (!settings.enabled || (!hasTargets() && !forcePanel && dataState !== 'error')) {
      if (panel) panel.style.display = 'none';
      if (mini) mini.style.display = 'none';
      return;
    }

    ensureUi();
    panel.style.display = settings.panelMode === 'normal' ? '' : 'none';
    mini.style.display = settings.panelMode === 'icon' ? '' : 'none';
  }

  function buildMini() {
    mini = document.createElement('button');
    mini.id = 'sg-mini';
    mini.textContent = 'S';
    mini.title = 'Open Steam Highlighter';
    mini.type = 'button';
    mini.setAttribute('aria-label', mini.title);
    mini.addEventListener('click', () => {
      settings.panelMode = 'normal';
      saveSettings();
      updateUi();
      renderSummary();
      renderHealth();
    });
    document.body.appendChild(mini);
    mini.style.display = 'none';
  }

  function buildPanel() {
    panel = document.createElement('div');
    panel.id = 'sg-panel';
    panel.setAttribute('role', 'region');
    panel.setAttribute('aria-label', 'Steam Ownership Highlighter');

    panel.innerHTML = `
      <div id="sg-head">
        <b>Steam Highlighter <span id="sg-version">v${VERSION}</span></b>
        <span>
          <button id="sg-gear" title="Settings">⚙</button>
          <button id="sg-min" title="Minimize to icon">−</button>
          <button id="sg-close" title="Hide completely">×</button>
        </span>
      </div>

      <div id="sg-summary">
        <div class="sg-line"><span>Detected</span><b id="sg-total">0</b></div>
        <div class="sg-line"><span>Owned</span><b id="sg-owned">0</b></div>
        <div class="sg-line"><span>New / unowned</span><b id="sg-new">0</b></div>
        <div class="sg-line"><span>Unknown</span><b id="sg-unknown">0</b></div>
        <div class="sg-line"><span>Wishlisted</span><b id="sg-wishlist">0</b></div>
        <div class="sg-line" id="sg-humble-line" hidden><span>Titles with no Steam match</span><b id="sg-humble-miss">0</b></div>
      </div>

      <div id="sg-health" role="status"></div>

      <div id="sg-actions">
        <button id="sg-owned-btn">Hide Owned</button>
        <button id="sg-wish-btn">Wishlist Only</button>
        <button id="sg-refresh">Refresh Steam</button>
        <button id="sg-rescan">Rescan Page</button>
      </div>

      <div id="sg-settings" hidden>
        <label>Owned entries
          <select id="sg-dim">
            <option value="off">Normal</option>
            <option value="dim">Dim</option>
            <option value="hide">Hide</option>
          </select>
        </label>
        <label>Hover info <input id="sg-hover" type="checkbox"></label>
        <label>Steam country <input id="sg-country" type="text" maxlength="2"></label>
        <label>Refresh min <input id="sg-cache" type="number" min="1" max="1440"></label>
        <label>ITAD API key <input id="sg-itad" type="password" placeholder="optional"></label>
        <label>Near ATL ≤ % <input id="sg-near-atl" type="number" min="0" max="100"></label>
        <small>
          ✓ Owned &nbsp; W Wishlisted &nbsp; ✕ Not owned<br>
          F Followed &nbsp; I Ignored<br>
          Only verified Steam/SteamDB/Steam Community app or package links are checked.
          Packages use exact licence ownership. Prices: IsThereAnyDeal API.
          Ctrl+Shift+S toggles the highlighter.
        </small>
      </div>
    `;

    panel.querySelectorAll('button').forEach(button => {
      button.type = 'button';
      if (button.title) button.setAttribute('aria-label', button.title);
    });
    document.body.appendChild(panel);

    const $ = selector => panel.querySelector(selector);

    $('#sg-gear').onclick = () => { $('#sg-settings').hidden = !$('#sg-settings').hidden; };

    $('#sg-min').onclick = () => {
      settings.panelMode = 'icon';
      saveSettings();
      updateUi();
    };

    $('#sg-close').onclick = () => {
      settings.panelMode = 'hidden';
      saveSettings();
      updateUi();
      toast('Panel hidden. Restore it from Tampermonkey → Steam Ownership Highlighter - Stable → Show Panel.', false, 7000);
    };

    $('#sg-owned-btn').onclick = () => {
      settings.dimMode = settings.dimMode === 'hide' ? 'off' : 'hide';
      saveSettings();
      syncControls();
      scheduleUpdate();
    };

    $('#sg-wish-btn').onclick = () => {
      settings.wishlistOnly = !settings.wishlistOnly;
      saveSettings();
      syncControls();
      scheduleUpdate();
    };

    $('#sg-refresh').onclick = refreshSteam;

    $('#sg-rescan').onclick = () => {
      scan(document);
      scheduleUpdate();
      toast('Page rescanned.');
    };

    $('#sg-dim').onchange = e => {
      settings.dimMode = e.target.value;
      saveSettings();
      syncControls();
      scheduleUpdate();
    };

    $('#sg-hover').onchange = e => {
      settings.hoverInfo = e.target.checked;
      if (!settings.hoverInfo) cancelHover();
      saveSettings();
    };

    $('#sg-country').onchange = e => {
      const country = e.target.value.trim().toLowerCase();
      if (!/^[a-z]{2}$/.test(country)) {
        e.target.value = settings.country;
        toast('Enter a two-letter country code, such as cy.', true);
        return;
      }
      settings.country = country;
      saveSettings();
      cancelHover();
      infoCache.clear();
    };

    $('#sg-cache').onchange = e => {
      settings.cacheMinutes = Math.min(1440, Math.max(1, Number(e.target.value) || 60));
      e.target.value = settings.cacheMinutes;
      saveSettings();
      renderHealth();
    };

    $('#sg-itad').onchange = e => {
      settings.itadKey = e.target.value.trim();
      saveSettings();
      cancelHover();
      infoCache.clear();
    };

    $('#sg-near-atl').onchange = e => {
      settings.nearAtlPct = Math.max(0, Math.min(100, Number(e.target.value) || 0));
      e.target.value = settings.nearAtlPct;
      saveSettings();
    };

    syncControls();
    panel.style.display = 'none';
  }

  // Push current settings into the panel (also used when another tab changes them).
  function syncControls() {
    if (!panel) return;
    const $ = selector => panel.querySelector(selector);
    $('#sg-dim').value = settings.dimMode;
    $('#sg-hover').checked = settings.hoverInfo;
    if (document.activeElement !== $('#sg-country')) $('#sg-country').value = settings.country;
    if (document.activeElement !== $('#sg-cache')) $('#sg-cache').value = settings.cacheMinutes;
    if (document.activeElement !== $('#sg-itad')) $('#sg-itad').value = settings.itadKey;
    if (document.activeElement !== $('#sg-near-atl')) $('#sg-near-atl').value = settings.nearAtlPct;
    $('#sg-owned-btn').textContent = settings.dimMode === 'hide' ? 'Show Owned' : 'Hide Owned';
    $('#sg-wish-btn').textContent = settings.wishlistOnly ? 'Show All' : 'Wishlist Only';
  }

  function panelVisible() {
    return panel && panel.style.display !== 'none';
  }

  function renderSummary() {
    if (!panelVisible()) return;

    const items = uniqueTargets();
    let owned = 0;
    let wishlist = 0;
    let unknown = 0;

    for (const status of items.values()) {
      if (status === 'owned') owned++;
      else if (status === 'wishlist') wishlist++;
      else if (status === 'unknown') unknown++;
    }

    textIfChanged(panel.querySelector('#sg-total'), items.size);
    textIfChanged(panel.querySelector('#sg-owned'), `${owned} / ${items.size}`);
    textIfChanged(panel.querySelector('#sg-new'), Math.max(0, items.size - owned - unknown));
    textIfChanged(panel.querySelector('#sg-unknown'), unknown);
    textIfChanged(panel.querySelector('#sg-wishlist'), wishlist);

    if (nameScanEnabled()) {
      const line = panel.querySelector('#sg-humble-line');
      line.hidden = nameUnmatched.size === 0;
      textIfChanged(panel.querySelector('#sg-humble-miss'), nameUnmatched.size);
      line.title = [...nameUnmatched].sort().join('\n');
    }
  }

  function renderHealth() {
    if (!panelVisible()) return;
    const age = data.loadedAt ? Math.max(0, Math.floor((Date.now() - data.loadedAt) / 60000)) : 0;
    const old = data.loadedAt && age >= settings.cacheMinutes;
    const retryIn = nextAutoAttempt > Date.now() ? Math.ceil((nextAutoAttempt - Date.now()) / 60000) : 0;

    let label;
    if (dataState === 'loading') {
      label = 'Refreshing Steam…';
    } else if (dataState === 'error') {
      label = 'Ownership unavailable — check Steam Store login and refresh.' +
        (retryIn ? ` Auto-retry in ${retryIn} min.` : '');
    } else {
      label = `${dataState === 'cached' || old ? 'Saved' : 'Steam'} data • ${age} min old • ` +
        `${data.apps.size.toLocaleString()} apps`;
    }

    const health = panel.querySelector('#sg-health');
    textIfChanged(health, label);
    health.dataset.error = String(dataState === 'error' || dataState === 'cached' || !!old);
    health.title = lastError || (data.loadedAt ? new Date(data.loadedAt).toLocaleString() : '');
    panel.querySelector('#sg-refresh').disabled = dataState === 'loading';
  }

  /* ---------------------------------------------------------------- *
   * Hover info
   * ---------------------------------------------------------------- */

  async function fetchSteamInfo(type, id) {
    type = normalizeType(type);
    const cc = encodeURIComponent(settings.country || 'cy');
    const info = {};

    if (type === 'app') {
      const [details, reviews] = await Promise.allSettled([
        gmJson({
          method: 'GET', anonymous: true,
          url: `https://store.steampowered.com/api/appdetails?appids=${id}&cc=${cc}&l=english`
        }, true),
        gmJson({
          method: 'GET', anonymous: true,
          url: `https://store.steampowered.com/appreviews/${id}?json=1&language=all&purchase_type=all&num_per_page=0`
        }, true)
      ]);

      if (details.status === 'fulfilled' && details.value?.[id]?.success) {
        const d = details.value[id].data;
        info.name = d.name;
        info.isFree = !!d.is_free;
        info.release = d.release_date
          ? (d.release_date.coming_soon ? 'Coming soon' : d.release_date.date)
          : '';

        if (d.price_overview) {
          const p = d.price_overview;
          info.price = {
            final: p.final_formatted || money(p.final / 100, p.currency),
            initial: p.initial_formatted || money(p.initial / 100, p.currency),
            amount: Number(p.final) / 100,
            currency: p.currency,
            cut: Number(p.discount_percent || 0)
          };
        }
      }

      if (reviews.status === 'fulfilled' && reviews.value?.query_summary) {
        const q = reviews.value.query_summary;
        info.reviews = q.total_reviews > 0
          ? { desc: q.review_score_desc, pct: Math.round(100 * q.total_positive / q.total_reviews), total: q.total_reviews }
          : { desc: 'No reviews yet', pct: null, total: 0 };
      }
    } else {
      const result = await gmJson({
        method: 'GET', anonymous: true,
        url: `https://store.steampowered.com/api/packagedetails?packageids=${id}&cc=${cc}`
      }, true);

      if (result?.[id]?.success) {
        const d = result[id].data;
        info.name = d.name;
        if (d.price) {
          info.price = {
            final: money(d.price.final / 100, d.price.currency),
            initial: money(d.price.initial / 100, d.price.currency),
            amount: Number(d.price.final) / 100,
            currency: d.price.currency,
            cut: Number(d.price.discount_percent || 0)
          };
        }
      }
    }

    if (!Object.keys(info).length) throw new Error('Steam details unavailable.');
    return info;
  }

  async function fetchItadInfo(appid) {
    const key = String(settings.itadKey || '').trim();
    if (!key) return null;
    const encodedKey = encodeURIComponent(key);

    const lookup = await gmJson({
      method: 'GET', anonymous: true,
      url: `https://api.isthereanydeal.com/games/lookup/v1?key=${encodedKey}&appid=${encodeURIComponent(appid)}`
    }, true);
    if (!lookup?.found || !lookup.game) return null;

    const country = encodeURIComponent((settings.country || 'cy').toUpperCase());
    const prices = await gmJson({
      method: 'POST', anonymous: true,
      url: `https://api.isthereanydeal.com/games/prices/v3?key=${encodedKey}&country=${country}`,
      headers: { 'Content-Type': 'application/json' },
      data: JSON.stringify([lookup.game.id])
    }, true);

    const game = Array.isArray(prices) ? prices[0] : null;
    if (!game) return null;

    const now = Date.now();
    const deals = (game.deals || []).filter(d =>
      d?.price &&
      Number.isFinite(Number(d.price.amount)) && Number(d.price.amount) >= 0 &&
      (!d.expiry || !Number.isFinite(Date.parse(d.expiry)) || Date.parse(d.expiry) > now));

    // Do not rank prices denominated in different currencies.
    const currency = game.historyLow?.all?.currency || deals[0]?.price?.currency;
    let best = null;
    for (const deal of deals) {
      if (deal.price.currency !== currency) continue;
      if (!best || Number(deal.price.amount) < Number(best.price.amount)) best = deal;
    }

    return { best, low: game.historyLow?.all || null };
  }

  function getInfo(type, id) {
    const key = `${normalizeType(type)}:${id}:${settings.country}:${settings.itadKey ? 'itad' : 'steam'}`;
    const cached = infoCache.get(key);
    if (cached && cached.expires > Date.now()) return cached.promise;

    const entry = { expires: Date.now() + INFO_TTL_MS, promise: null };
    entry.promise = (async () => {
      const [steam, itad] = await Promise.allSettled([
        fetchSteamInfo(type, id),
        normalizeType(type) === 'app' ? fetchItadInfo(id) : Promise.resolve(null)
      ]);
      if (steam.status === 'rejected' || itad.status === 'rejected') entry.expires = Date.now() + INFO_ERROR_TTL_MS;
      return {
        steam: steam.status === 'fulfilled' ? steam.value : null,
        steamError: steam.status === 'rejected' ? 'Steam details unavailable; retry shortly.' : '',
        itad: itad.status === 'fulfilled' ? itad.value : null,
        itadError: itad.status === 'rejected' ? itad.reason?.message || 'ITAD request failed' : ''
      };
    })();

    infoCache.delete(key);
    infoCache.set(key, entry);
    while (infoCache.size > 200) infoCache.delete(infoCache.keys().next().value);
    return entry.promise;
  }

  function renderTip(target, info) {
    const parsed = parseKey(target.dataset.sgKey);
    const status = STATUSES.includes(target.dataset.sgStatus) ? target.dataset.sgStatus : 'unknown';
    const steam = info?.steam;

    let html =
      `<div class="title">${esc(steam?.name || target.dataset.sgKey)}</div>` +
      `<div><span class="dot" style="background:${COLORS[status]}"></span>` +
      `<b>${SYMBOLS[status]}</b> ${LABELS[status]}</div>`;

    if (dataState === 'cached') html += '<div class="warn">Ownership is from saved data.</div>';
    if (info?.steamError) html += `<div class="warn">${esc(info.steamError)}</div>`;

    if (steam) {
      if (steam.isFree) {
        html += '<div>Free to play</div>';
      } else if (steam.price) {
        html += `<div>Steam: ${esc(steam.price.final)}` +
          (steam.price.cut ? ` (-${steam.price.cut}%, was ${esc(steam.price.initial)})` : '') +
          '</div>';
      }
      if (steam.reviews) {
        html += steam.reviews.total
          ? `<div>Reviews: ${esc(steam.reviews.desc)} — ${steam.reviews.pct}% of ` +
            `${Number(steam.reviews.total).toLocaleString()}</div>`
          : '<div>Reviews: none yet</div>';
      }
      if (steam.release) html += `<div>Release: ${esc(steam.release)}</div>`;
    }

    if (info?.itad) {
      const { best, low } = info.itad;
      html += '<hr><div>Prices: IsThereAnyDeal</div>';

      if (best) {
        const cut = Math.round(Number(best.cut) || 0);
        html += `<div>Best now: ${esc(money(best.price.amount, best.price.currency))}` +
          (cut > 0 ? ` (-${cut}%)` : '') +
          (best.shop?.name ? ` at ${esc(best.shop.name)}` : '') +
          '</div>';
      }

      if (low) {
        html += `<div>All-time low: ${esc(money(low.amount, low.currency))}</div>`;

        if (best && best.price.currency === low.currency && Number(low.amount) > 0) {
          const pct = ((Number(best.price.amount) - Number(low.amount)) / Number(low.amount)) * 100;
          if (pct <= 0) html += '<div class="good">At the all-time low</div>';
          else if (pct <= Number(settings.nearAtlPct || 0)) html += `<div class="good">Near ATL: ${Math.round(pct)}% above low</div>`;
          else html += `<div>${Math.round(pct)}% above all-time low</div>`;
        }
      }
    } else if (settings.itadKey && info?.itadError) {
      html += `<hr><div class="warn">ITAD unavailable: ${esc(info.itadError)}</div>`;
    }

    if (parsed?.type === 'sub' && status === 'missing') {
      html += '<div>Exact package licence not found; individual games may still be owned.</div>';
    }
    if (parsed) {
      html += `<hr><div>Steam ${parsed.type === 'app' ? 'App' : 'Package'} ID: ${parsed.id}</div>`;
    }

    tip.innerHTML = html;
  }

  function positionTip(target) {
    const r = target.getBoundingClientRect();
    const width = tip.offsetWidth;
    const height = tip.offsetHeight;

    let top = r.bottom + 8;
    if (top + height > innerHeight - 8) top = Math.max(8, r.top - height - 8);

    tip.style.top = `${top}px`;
    tip.style.left = `${Math.max(8, Math.min(r.left, innerWidth - width - 8))}px`;
  }

  async function showTip(target) {
    if (!settings.enabled || !settings.hoverInfo || !target.isConnected || currentHover !== target) return;
    const sequence = ++hoverSequence;
    const key = target.dataset.sgKey;
    const parsed = parseKey(key);
    if (!parsed) return;

    if (!tip) {
      tip = document.createElement('div');
      tip.id = 'sg-tip';
      tip.setAttribute('role', 'tooltip');
      document.body.appendChild(tip);
    }

    target.setAttribute('aria-describedby',
      [target.getAttribute('aria-describedby'), 'sg-tip'].filter(Boolean).join(' '));
    tip.style.display = 'block';
    tip.innerHTML = '<div>Loading…</div>';
    positionTip(target);

    let info = null;
    try { info = await getInfo(parsed.type, parsed.id); } catch (_) {}

    if (sequence !== hoverSequence || currentHover !== target || !target.isConnected ||
        target.dataset.sgKey !== key || !settings.enabled || !settings.hoverInfo) return;

    renderTip(target, info);
    positionTip(target);
  }

  function hideTip() {
    if (tip) tip.style.display = 'none';
  }

  function cancelHover() {
    hoverSequence++;
    if (currentHover) {
      const describedBy = (currentHover.getAttribute('aria-describedby') || '')
        .split(/\s+/).filter(id => id && id !== 'sg-tip').join(' ');
      if (describedBy) currentHover.setAttribute('aria-describedby', describedBy);
      else currentHover.removeAttribute('aria-describedby');
    }
    currentHover = null;
    clearTimeout(hoverTimer);
    hideTip();
  }

  function beginHover(event) {
    if (!settings.enabled || !settings.hoverInfo) return;
    const target = event.target.closest?.('a[data-sg-key]');
    if (!target || target === currentHover) return;
    cancelHover();
    currentHover = target;
    hoverTimer = setTimeout(() => showTip(target), 280);
  }

  function endHover(event) {
    const target = event.target.closest?.('a[data-sg-key]');
    if (target && !target.contains(event.relatedTarget)) cancelHover();
  }

  document.addEventListener('mouseover', beginHover);
  document.addEventListener('focusin', beginHover);
  document.addEventListener('mouseout', endHover);
  document.addEventListener('focusout', endHover);
  document.addEventListener('keydown', event => { if (event.key === 'Escape') cancelHover(); });
  addEventListener('scroll', () => { if (currentHover) cancelHover(); }, { passive: true, capture: true });
  addEventListener('resize', () => { if (currentHover) cancelHover(); }, { passive: true });

  /* ---------------------------------------------------------------- *
   * Toast, refresh, toggle
   * ---------------------------------------------------------------- */

  function toast(message, error = false, duration = 2600) {
    let el = document.getElementById('sg-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'sg-toast';
      el.setAttribute('role', 'status');
      document.documentElement.appendChild(el);
    }
    el.textContent = message;
    el.style.borderColor = error ? '#f85149' : '#30363d';
    el.style.display = 'block';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.style.display = 'none'; }, duration);
  }

  async function refreshSteam() {
    toast('Refreshing Steam ownership…', false, 1800);
    const fresh = await loadData(true);
    noteRefreshResult(fresh);
    scan(document);
    updateAllStatuses();
    if (fresh) {
      toast(`Steam refreshed: ${data.apps.size.toLocaleString()} apps, ${data.wishlist.size} wishlisted.`, false, 4000);
    }
  }

  function toggleEnabled() {
    settings.enabled = !settings.enabled;
    saveSettings();
    applyClasses();
    scheduleUpdate();

    if (settings.enabled) {
      scan(document);
      if (nameScanEnabled()) scheduleNameScan();
      toast('Steam Highlighter: ENABLED');
    } else {
      cancelHover();
      updateUi();
      toast('Steam Highlighter: DISABLED');
    }
  }

  document.addEventListener('keydown', e => {
    if (!e.ctrlKey || !e.shiftKey || e.altKey || String(e.key).toLowerCase() !== 's') return;
    const tag = String(e.target?.tagName || '').toLowerCase();
    if (['input', 'textarea', 'select'].includes(tag) || e.target?.isContentEditable) return;
    e.preventDefault();
    toggleEnabled();
  });

  /* ---------------------------------------------------------------- *
   * Observers and cross-tab sync
   * ---------------------------------------------------------------- */

  function installObserver() {
    const pendingRoots = new Set();
    let timer = null;

    const observer = new MutationObserver(mutations => {
      if (!settings.enabled) return;
      let relevant = false;

      for (const mutation of mutations) {
        // Ignore the complete record, including removed text in our own UI.
        const parent = mutation.target.nodeType === 1 ? mutation.target : mutation.target.parentElement;
        if (parent?.closest(UI_SELECTOR)) continue;

        if (mutation.type === 'attributes') {
          if (mutation.target.tagName === 'A' && markLink(mutation.target)) relevant = true;
          continue;
        }
        for (const node of mutation.addedNodes) {
          if (node.nodeType !== 1 || node.matches(UI_SELECTOR)) continue;
          pendingRoots.add(node);
          relevant = true;
        }
        if (!relevant) {
          for (const node of mutation.removedNodes) {
            if (node.nodeType === 1 && !node.matches(UI_SELECTOR)) { relevant = true; break; }
          }
        }
      }

      if (!relevant || timer !== null) return;
      timer = setTimeout(() => {
        timer = null;
        // Skip descendants if their ancestor is already queued.
        const roots = [...pendingRoots].filter(node => node.isConnected);
        pendingRoots.clear();
        for (const node of roots) {
          if (!roots.some(other => other !== node && other.contains(node))) scan(node);
        }
        if (currentHover && !currentHover.isConnected) cancelHover();
        if (nameScanEnabled()) scheduleNameScan();
        scheduleUpdate();
      }, 100);
    });

    observer.observe(document.body, {
      childList: true, subtree: true, attributes: true, attributeFilter: ['href']
    });
  }

  // Patching history.pushState from the userscript sandbox usually doesn't see
  // the page's own calls; the MutationObserver already covers SPA navigation.
  // These two events do cross the sandbox boundary, so they stay.
  function installNavigationListeners() {
    const trigger = () => setTimeout(() => { scan(document); scheduleUpdate(); }, 250);
    addEventListener('popstate', trigger);
    addEventListener('hashchange', trigger);
  }

  // When one tab refreshes ownership or changes settings, every other open tab
  // picks it up immediately instead of fetching again.
  function installSync() {
    if (typeof GM_addValueChangeListener !== 'function') return;

    GM_addValueChangeListener(CACHE_KEY, (_name, _old, value, remote) => {
      if (!remote || !validCache(value) || value.time <= data.loadedAt) return;
      acceptCache(value);
      dataState = 'ready';
      lastError = '';
      noteRefreshResult(true);
      updateAllStatuses();
    });

    GM_addValueChangeListener(SETTINGS_KEY, (_name, _old, value, remote) => {
      if (!remote) return;
      const wasEnabled = settings.enabled;
      const old = settings;
      settings = normalizeSettings(value);
      if (old.country !== settings.country || old.itadKey !== settings.itadKey) infoCache.clear();
      syncControls();
      if (!settings.enabled || !settings.hoverInfo) cancelHover();
      if (settings.enabled && !wasEnabled) scan(document);
      scheduleUpdate();
    });
  }

  /* ---------------------------------------------------------------- *
   * Game-name matching for bundle sites (Humble, Fanatical, IndieGala, GMG)
   * ---------------------------------------------------------------- */

  const nameIndex = new Map();      // normalized name -> { name, appid }
  const namePending = new Map();    // normalized name -> Promise<appid|null|undefined>
  const nameUnmatched = new Set();
  const apiRequested = new Set();
  let nameMatches = null;
  let nameSaveTimer = null;
  let nameScanTimer = null;
  let nameSearches = 0;
  let learnedTitles = null;
  let pickerActive = false;

  const EDITION_RE = new RegExp(
    '\\s+(?:(?:digital|deluxe|definitive|complete|gold|goty|game of the year|ultimate|enhanced|' +
    'remastered|standard|special|collector s|anniversary|director s cut)\\s+)+edition$|\\s+goty$');

  function normName(value) {
    return String(value || '')
      .replace(/[™®©]/g, '') // strip before NFKD, which would turn ™ into "TM"
      .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/&/g, ' and ')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  }

  function baseName(normalized) {
    return normalized.replace(EDITION_RE, '').trim();
  }

  function looksLikeTitle(text) {
    return !!text && text.length <= 150 && /[a-z]{2}/i.test(text);
  }

  function nameCache() {
    if (!nameMatches) {
      const raw = GM_getValue(NAME_CACHE_KEY, {});
      nameMatches = raw && typeof raw === 'object' ? raw : {};
    }
    return nameMatches;
  }

  function saveNameCache() {
    clearTimeout(nameSaveTimer);
    nameSaveTimer = setTimeout(() => {
      const now = Date.now();
      for (const [key, value] of Object.entries(nameCache())) {
        if (!value || now - value.t > cacheTtl(value)) delete nameMatches[key];
      }
      GM_setValue(NAME_CACHE_KEY, nameMatches);
    }, 1000);
  }

  function learned() {
    if (!learnedTitles) {
      const raw = GM_getValue(LEARNED_KEY, {});
      learnedTitles = raw && typeof raw === 'object' ? raw : {};
    }
    return learnedTitles;
  }

  function titleSelectors() {
    return [...(SITE?.titles || []), ...(learned()[location.hostname] || [])];
  }

  function nameScanEnabled() {
    return !!SITE || (learned()[location.hostname] || []).length > 0;
  }

  // Look for a Steam app ID inside one product object, if the site provides one.
  function steamIdIn(node, depth = 0) {
    if (!node || typeof node !== 'object' || Array.isArray(node) || depth > 2) return null;
    for (const [key, value] of Object.entries(node)) {
      if (/steam.?app.?id|^steam_?id$/i.test(key)) {
        const id = Number(value);
        if (Number.isSafeInteger(id) && id > 0) return id;
      }
      // Shapes like { steam: { type: 'app', id: 123 } }
      if (/^steam$/i.test(key) && value && typeof value === 'object' && !Array.isArray(value) &&
          (!value.type || /app|game/i.test(String(value.type)))) {
        const id = Number(value.id ?? value.appid ?? value.app_id);
        if (Number.isSafeInteger(id) && id > 0) return id;
      }
      if (typeof value === 'string') {
        const match = /store\.steampowered\.com\/app\/([1-9]\d*)/i.exec(value);
        if (match) return Number(match[1]);
      }
      if (value && typeof value === 'object') {
        const id = steamIdIn(value, depth + 1);
        if (id) return id;
      }
    }
    return null;
  }

  function addName(name, appid) {
    if (!looksLikeTitle(String(name).trim())) return false;
    const key = normName(name);
    if (!key) return false;
    const existing = nameIndex.get(key);
    if (!existing) { nameIndex.set(key, { name: String(name).trim(), appid: appid || null }); return true; }
    if (appid && !existing.appid) { existing.appid = appid; return true; }
    return false;
  }

  // Walk embedded or API JSON for product names. With requireId, only names
  // that come with a Steam ID are taken, so publisher or tier names are ignored.
  function walkNames(json, nameKey, requireId) {
    let added = 0;
    const stack = [[json, 0]];
    let visited = 0;
    while (stack.length && visited++ < 50000) {
      const [node, depth] = stack.pop();
      if (!node || typeof node !== 'object' || depth > 15) continue;
      if (Array.isArray(node)) {
        for (const child of node) stack.push([child, depth + 1]);
        continue;
      }
      if (typeof node[nameKey] === 'string') {
        const id = steamIdIn(node);
        if ((id || !requireId) && addName(node[nameKey], id)) added++;
      }
      for (const value of Object.values(node)) {
        if (value && typeof value === 'object') stack.push([value, depth + 1]);
      }
    }
    return added;
  }

  function readPageJson() {
    if (!SITE?.jsonScripts) return;
    for (const script of document.querySelectorAll(SITE.jsonScripts)) {
      if (script.dataset.sgRead) continue;
      script.dataset.sgRead = '1';
      try { walkNames(JSON.parse(script.textContent), SITE.jsonNameKey, false); } catch (_) {}
    }
  }

  // Fanatical is a single-page app; its public product API includes the
  // bundle's games, often with their Steam IDs. Failures are silent: the
  // title selectors still work without it.
  function fanaticalApiUrls() {
    const m = /^\/[a-z]{2}(?:-[a-z]{2})?\/(bundle|pick-and-mix|game|dlc)\/([^/?#]+)/i.exec(location.pathname);
    if (!m) return [];
    const kind = m[1].toLowerCase();
    const slug = encodeURIComponent(m[2]);
    if (kind === 'pick-and-mix') {
      return [`https://www.fanatical.com/api/pick-and-mix/${slug}/en`,
        `https://www.fanatical.com/api/products-group/${slug}/en`];
    }
    if (kind === 'bundle') return [`https://www.fanatical.com/api/products-group/${slug}/en`];
    return [`https://www.fanatical.com/api/products/${slug}/en`];
  }

  function loadSiteApi() {
    if (!SITE?.api) return;
    for (const url of SITE.api()) {
      if (apiRequested.has(url)) continue;
      apiRequested.add(url);
      gmJson({ method: 'GET', anonymous: true, url }, true)
        .then(json => { if (walkNames(json, 'name', true)) scheduleNameScan(); })
        .catch(() => {});
    }
  }

  // Steam's store search often returns nothing for titles with " - " or ":",
  // so try a few spellings. These only change what is searched for; a result
  // must still match the site's name exactly (ignoring edition suffixes).
  function nameQueries(name) {
    const clean = String(name).replace(/[™®©]/g, '').replace(/\s+/g, ' ').trim();
    const variants = [
      clean,
      clean.replace(/\s*[:\-–—]+\s*/g, ' ').trim(),
      clean.replace(/\s*[-–—:]?\s*(?:(?:digital|deluxe|definitive|complete|gold|goty|game of the year|ultimate|enhanced|remastered|standard|special|collector'?s|anniversary|director'?s cut)\s+)*edition\s*$/i, '').trim(),
      clean.split(/\s+[-–—]\s+|:\s+/)[0].trim()
    ];
    return [...new Set(variants)].filter(term => term.length >= 2);
  }

  function cacheTtl(entry) {
    if (entry.id) return NAME_HIT_TTL;
    return entry.soft ? NAME_SOFT_MISS_TTL : NAME_MISS_TTL;
  }

  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  let searchChain = Promise.resolve();
  let searchPausedUntil = 0;

  // Steam searches run one at a time with a short gap, so a page of 30 games
  // doesn't trip Steam's rate limit. After an HTTP 429 they pause for a minute.
  function steamStoreSearch(term) {
    const run = searchChain.then(async () => {
      const wait = searchPausedUntil - Date.now();
      if (wait > 0) await sleep(wait);
      try {
        const cc = encodeURIComponent(settings.country || 'cy');
        const result = await gmJson({
          method: 'GET', anonymous: true,
          url: `https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(term)}&l=english&cc=${cc}`
        }, true);
        return Array.isArray(result?.items) ? result.items : [];
      } catch (error) {
        if (/HTTP 429/.test(error.message)) searchPausedUntil = Date.now() + SEARCH_COOLDOWN_MS;
        throw error;
      } finally {
        await sleep(SEARCH_GAP_MS);
      }
    });
    searchChain = run.catch(() => {});
    return run;
  }

  // Returns { id, conclusive }. A "no match" is only conclusive when Steam
  // returned results that didn't match; all-empty answers are what throttling
  // looks like, so those are retried soon instead of trusted for a day.
  async function searchSteamByName(name) {
    const want = normName(name);
    const wantBase = baseName(want);
    let sawResults = false;
    for (const term of nameQueries(name)) {
      const items = await steamStoreSearch(term);
      if (items.length) sawResults = true;
      const apps = items.filter(item => (!item?.type || item.type === 'app') && Number(item?.id) > 0);
      const match = apps.find(item => normName(item.name) === want) ||
        apps.find(item => baseName(normName(item.name)) === wantBase);
      if (match) return { id: Number(match.id), conclusive: true };
    }
    return { id: null, conclusive: sawResults };
  }

  // Resolves to an app ID, null (no exact match), or undefined (not checked:
  // network error or the per-page search budget is used up).
  function resolveName(key) {
    const entry = nameIndex.get(key);
    if (entry?.appid) return Promise.resolve(entry.appid);

    const cached = nameCache()[key];
    if (cached && Date.now() - cached.t < cacheTtl(cached)) {
      return Promise.resolve(cached.id || null);
    }
    if (namePending.has(key)) return namePending.get(key);
    if (nameSearches >= MAX_NAME_SEARCHES) return Promise.resolve(undefined);
    nameSearches++;

    const promise = searchSteamByName(entry?.name || key)
      .then(({ id, conclusive }) => {
        nameCache()[key] = conclusive || id
          ? { id: id || 0, t: Date.now() }
          : { id: 0, t: Date.now(), soft: true };
        saveNameCache();
        return id;
      })
      .catch(() => undefined) // network errors are not cached
      .finally(() => namePending.delete(key));
    namePending.set(key, promise);
    return promise;
  }

  function ownText(el) {
    return [...el.childNodes]
      .filter(node => !(node.nodeType === 1 &&
        (node.classList.contains('sg-humble-link') || node.classList.contains('sg-humble-row'))))
      .map(node => node.textContent)
      .join('')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // Skip titles whose tile already has a real Steam link (e.g. some IndieGala
  // pages), so a game never gets two badges.
  function nearNativeLink(el) {
    let node = el;
    for (let i = 0; node && i < 4 && node !== document.body; i++, node = node.parentElement) {
      if (node.querySelector('a[data-sg-key]:not(.sg-humble-link)')) return true;
    }
    return false;
  }

  function injectNameLink(el, appid) {
    const href = `https://store.steampowered.com/app/${appid}/`;
    let link = el.querySelector(':scope > a.sg-humble-link');
    if (!link) {
      link = document.createElement('a');
      link.className = 'sg-humble-link';
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = 'Steam';
      // Tiles often open a popup or product page on click; keep our link separate.
      link.addEventListener('click', event => event.stopPropagation());
      el.appendChild(link);
    }
    if (link.getAttribute('href') !== href) link.href = href;
    if (markLink(link)) scheduleUpdate();
  }

  // A line under the title: Steam store + SteamDB when matched, or a Steam
  // search link when no exact match was found.
  function injectNameRow(el, key, appid) {
    const next = el.nextElementSibling;
    let row = next?.classList.contains('sg-humble-row') ? next : null;
    if (!row) {
      row = document.createElement('div');
      row.className = 'sg-humble-row';
      row.addEventListener('click', event => event.stopPropagation());
      el.insertAdjacentElement('afterend', row);
    }

    const state = appid ? `app:${appid}` : `search:${key}`;
    if (row.dataset.sgFor === state) return;
    row.dataset.sgFor = state;

    const open = 'target="_blank" rel="noopener noreferrer" class="sg-humble-store"';
    if (appid) {
      row.innerHTML =
        `<a ${open} href="https://store.steampowered.com/app/${appid}/">Steam store ↗</a> · ` +
        `<a ${open} href="https://steamdb.info/app/${appid}/">SteamDB ↗</a>`;
    } else {
      const name = nameIndex.get(key)?.name || ownText(el);
      row.innerHTML =
        `<a ${open} href="https://store.steampowered.com/search/?term=${encodeURIComponent(name)}">Search on Steam ↗</a> ` +
        '<span class="sg-humble-note">(no exact match)</span>';
    }
  }

  // The tile around a matched title: the largest ancestor that holds no other
  // game title. Returns null when titles have no separate tiles, or the page
  // shows a single game, so Hide Owned never hides a whole page.
  const linkTitle = new WeakMap();  // corner chip -> its title element
  const titleCorner = new WeakMap(); // title element -> its corner chip

  function nameTile(link) {
    return nameTileOf(linkTitle.get(link) || link.closest('[data-sg-humble]'));
  }

  function nameTileOf(title) {
    if (!title) return null;
    let tile = null;
    for (let p = title.parentElement; p && p !== document.body; p = p.parentElement) {
      const keys = new Set([...p.querySelectorAll('[data-sg-humble]')].map(el => el.dataset.sgHumble));
      if (keys.size > 1) return tile;
      tile = p;
    }
    return null;
  }

  function isShown(el) {
    if (typeof el.checkVisibility === 'function') {
      return el.checkVisibility({ opacityProperty: true, visibilityProperty: true });
    }
    for (let node = el; node && node !== document.body; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
    }
    return true;
  }

  // A small always-visible chip in the card's top-right corner, for cards
  // whose title only appears on hover (Fanatical) or that only expose the
  // name through the cover image.
  function injectCorner(el, key, appid) {
    const tile = nameTileOf(el);
    if (!tile) return;
    let chip = tile.querySelector(':scope > a.sg-corner');
    if (!chip) {
      chip = document.createElement('a');
      chip.className = 'sg-corner';
      chip.target = '_blank';
      chip.rel = 'noopener noreferrer';
      chip.addEventListener('click', event => event.stopPropagation());
      if (getComputedStyle(tile).position === 'static') tile.style.position = 'relative';
      tile.appendChild(chip);
    }
    linkTitle.set(chip, el);
    titleCorner.set(el, chip);
    el.dataset.sgHumbleCorner = '1';

    if (appid) {
      chip.classList.add('sg-humble-link');
      chip.classList.remove('sg-corner-miss');
      chip.removeAttribute('title');
      chip.textContent = 'Steam';
      const href = `https://store.steampowered.com/app/${appid}/`;
      if (chip.getAttribute('href') !== href) chip.href = href;
      if (markLink(chip)) scheduleUpdate();
    } else {
      if (chip.dataset.sgKey) unmarkLink(chip);
      chip.classList.remove('sg-humble-link');
      chip.classList.add('sg-corner-miss');
      chip.textContent = 'Steam ?';
      chip.title = 'No exact Steam match. Click to search Steam.';
      const name = nameIndex.get(key)?.name || key;
      chip.href = `https://store.steampowered.com/search/?term=${encodeURIComponent(name)}`;
    }
  }

  // True when this title was fully handled and nothing we added has been
  // removed by the page since.
  function nameHandled(el, key) {
    if (el.dataset.sgHumble !== key || !el.dataset.sgHumbleDone) return false;
    const miss = !!el.dataset.sgHumbleMiss;
    // A "no match" is redone if a Steam ID arrived later (e.g. from Fanatical's API).
    if (miss && nameIndex.get(key)?.appid) return false;
    if (el.tagName !== 'IMG') {
      if (!el.nextElementSibling?.classList.contains('sg-humble-row')) return false;
      if (!miss && !el.querySelector(':scope > a.sg-humble-link')) return false;
    }
    if (el.dataset.sgHumbleCorner && !titleCorner.get(el)?.isConnected) return false;
    return true;
  }

  function applyNameResult(el, key, appid) {
    const name = nameIndex.get(key)?.name || key;
    const isImage = el.tagName === 'IMG';
    if (appid) {
      nameUnmatched.delete(name);
      delete el.dataset.sgHumbleMiss;
      if (!isImage) { injectNameLink(el, appid); injectNameRow(el, key, appid); }
    } else {
      el.dataset.sgHumbleMiss = '1';
      nameUnmatched.add(name);
      if (!isImage) injectNameRow(el, key, null);
    }
    if (isImage || SITE?.cornerBadge || !isShown(el)) injectCorner(el, key, appid);
    el.dataset.sgHumbleDone = '1';
    scheduleUpdate();
  }

  function nameScan() {
    if (!settings.enabled || !document.body || pickerActive || !nameScanEnabled()) return;
    readPageJson();
    loadSiteApi();

    const targets = new Map(); // element -> normalized name
    const skip = `${UI_SELECTOR},script,style,noscript,textarea,title,a.sg-humble-link,a.sg-corner,.sg-humble-row`;

    for (const selector of titleSelectors()) {
      let found;
      try { found = document.querySelectorAll(selector); } catch (_) { continue; } // bad learned selector
      for (const el of found) {
        if (targets.has(el) || el.closest(skip)) continue;
        const text = ownText(el);
        if (!looksLikeTitle(text)) continue;
        addName(text, null);
        targets.set(el, normName(text));
      }
    }

    if (nameIndex.size) {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const text = node.nodeValue;
        if (!text || text.length > 150) continue;
        const key = normName(text);
        if (!key || !nameIndex.has(key)) continue;
        const el = node.parentElement;
        if (!el || targets.has(el) || el.closest(skip)) continue;
        targets.set(el, key);
      }
    }

    // Cover images whose alt text is a known game name (only names that came
    // from the site's own product data, so logos and banners are ignored).
    if (SITE?.altTitles && nameIndex.size) {
      for (const img of document.querySelectorAll('img[alt]')) {
        if (targets.has(img) || img.closest(skip)) continue;
        const key = normName(img.alt);
        if (key && nameIndex.has(key)) targets.set(img, key);
      }
    }

    for (const [el, key] of targets) {
      if (nameHandled(el, key)) continue;
      if (el.dataset.sgHumble !== key && nearNativeLink(el)) continue;
      el.dataset.sgHumble = key;
      delete el.dataset.sgHumbleDone;

      resolveName(key).then(appid => {
        if (!el.isConnected || el.dataset.sgHumble !== key) return;
        if (appid === undefined) { delete el.dataset.sgHumble; scheduleRetryScan(); return; }
        applyNameResult(el, key, appid);
      });
    }
  }

  // After a network error or Steam throttling, look again once things calm down,
  // even if the page itself doesn't change.
  let retryScanTimer = null;
  function scheduleRetryScan() {
    if (retryScanTimer !== null) return;
    retryScanTimer = setTimeout(() => {
      retryScanTimer = null;
      scheduleNameScan();
    }, Math.max(30000, searchPausedUntil - Date.now() + 1000));
  }

  function scheduleNameScan() {
    if (nameScanTimer !== null) return;
    nameScanTimer = setTimeout(() => {
      nameScanTimer = null;
      nameScan();
    }, 300);
  }

  /* ---------------------------------------------------------------- *
   * Title picker: teaches the script where a site keeps game titles
   * ---------------------------------------------------------------- */

  function stableClasses(el) {
    return [...el.classList].filter(c =>
      /^[a-z][\w-]{1,50}$/i.test(c) && !c.startsWith('sg-') &&
      // skip generated class names (css-1x2y3z, Title_ab12c) and state classes
      !/^(?:css|sc|jsx|svelte|emotion)-|[_-](?=[a-z0-9]*\d)(?=[a-z0-9]*[a-z])[a-z0-9]{5,}$|\d{3,}|active|hover|focus|selected|open/i.test(c));
  }

  function simpleSelector(el) {
    const classes = stableClasses(el).slice(0, 2);
    return classes.length ? el.tagName.toLowerCase() + classes.map(c => `.${CSS.escape(c)}`).join('') : '';
  }

  // Prefer a selector, scoped by an ancestor where possible, that finds this
  // title plus its siblings in other tiles, and nothing long like a description.
  function selectorFor(el) {
    const own = simpleSelector(el) || el.tagName.toLowerCase();
    const candidates = simpleSelector(el) ? [own] : [];
    let p = el.parentElement;
    for (let i = 0; p && i < 4 && p !== document.body; i++, p = p.parentElement) {
      const scope = simpleSelector(p);
      if (scope) candidates.push(`${scope} ${own}`);
    }

    let best = '';
    let fallback = '';
    for (const selector of candidates) {
      let list;
      try { list = [...document.querySelectorAll(selector)]; } catch (_) { continue; }
      if (!list.includes(el)) continue;
      if (!fallback) fallback = selector;
      if (list.length >= 2 && list.length <= 300 &&
          list.every(node => node.textContent.trim().length <= 150)) best = selector;
    }
    return best || fallback;
  }

  function learnTitle(el) {
    const text = el.textContent.replace(/\s+/g, ' ').trim();
    if (!looksLikeTitle(text)) {
      toast('That doesn’t look like a game title. Click directly on the title text.', true, 5000);
      return;
    }
    const selector = selectorFor(el);
    if (!selector) {
      toast('Couldn’t find a reliable way to recognize that title. Try clicking a different part of it.', true, 6000);
      return;
    }

    const all = learned();
    const list = (all[location.hostname] || []).filter(s => s !== selector);
    list.push(selector);
    all[location.hostname] = list.slice(-10);
    GM_setValue(LEARNED_KEY, all);

    const count = document.querySelectorAll(selector).length;
    toast(`Learned: ${count} title${count === 1 ? '' : 's'} found on ${location.hostname}.`, false, 5000);
    nameScan();
  }

  function startPicker() {
    if (pickerActive) return;
    pickerActive = true;
    cancelHover();

    const box = document.createElement('div');
    box.id = 'sg-pick';
    document.documentElement.appendChild(box);

    const ours = event => !!event.target?.closest?.(UI_SELECTOR);
    const over = event => {
      const el = event.target;
      if (!el || el.nodeType !== 1 || ours(event)) return;
      const r = el.getBoundingClientRect();
      Object.assign(box.style, {
        left: `${r.left - 2}px`, top: `${r.top - 2}px`,
        width: `${r.width + 4}px`, height: `${r.height + 4}px`
      });
    };
    // Swallow presses so the page doesn't navigate or open a popup while picking.
    const block = event => {
      if (ours(event)) return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
    };
    const click = event => {
      if (ours(event)) return;
      block(event);
      const el = event.target;
      finish();
      if (el?.nodeType === 1) learnTitle(el);
    };
    const key = event => {
      if (event.key !== 'Escape') return;
      block(event);
      finish();
      toast('Picking cancelled.');
    };
    const events = [
      ['mouseover', over], ['pointerdown', block], ['mousedown', block],
      ['pointerup', block], ['mouseup', block], ['click', click], ['keydown', key]
    ];
    function finish() {
      for (const [type, handler] of events) removeEventListener(type, handler, true);
      box.remove();
      pickerActive = false;
    }
    for (const [type, handler] of events) addEventListener(type, handler, true);
    toast('Click one game title on this page. Esc cancels.', false, 8000);
  }

  /* ---------------------------------------------------------------- *
   * Menu commands
   * ---------------------------------------------------------------- */

  GM_registerMenuCommand('Show Panel', () => {
    settings.enabled = true;
    settings.panelMode = 'normal';
    forcePanel = true;
    saveSettings();
    applyClasses();
    scan(document);
    updateUi();
    renderSummary();
    renderHealth();
    toast(hasTargets()
      ? 'Steam Highlighter panel restored.'
      : 'Panel restored. No supported Steam/SteamDB links found on this page.');
  });

  GM_registerMenuCommand('Minimize Panel to Icon', () => {
    settings.panelMode = 'icon';
    saveSettings();
    updateUi();
  });

  GM_registerMenuCommand('Hide Panel Completely', () => {
    settings.panelMode = 'hidden';
    saveSettings();
    updateUi();
    toast('Panel hidden. Restore it from Tampermonkey → Steam Ownership Highlighter - Stable → Show Panel.', false, 7000);
  });

  GM_registerMenuCommand('Refresh Steam Data Now', refreshSteam);

  GM_registerMenuCommand('Rescan Page Now', () => {
    scan(document);
    scheduleUpdate();
    toast('Page rescanned.');
  });

  GM_registerMenuCommand('Enable / Disable Steam Highlighter', toggleEnabled);

  GM_registerMenuCommand('Pick Game Titles on This Page', startPicker);

  GM_registerMenuCommand('Forget Learned Titles for This Site', () => {
    const all = learned();
    delete all[location.hostname];
    GM_setValue(LEARNED_KEY, all);
    toast('Learned titles for this site forgotten. Reload the page to clear existing badges.', false, 5000);
  });

  GM_registerMenuCommand('Clear Game Name Matches', () => {
    nameMatches = {};
    GM_setValue(NAME_CACHE_KEY, {});
    nameSearches = 0;
    document.querySelectorAll('a.sg-humble-link').forEach(link => { unmarkLink(link); link.remove(); });
    document.querySelectorAll('.sg-humble-row, a.sg-corner').forEach(node => {
      if (node.dataset.sgKey) unmarkLink(node);
      node.remove();
    });
    document.querySelectorAll('[data-sg-humble]').forEach(el => {
      for (const flag of ['sgHumble', 'sgHumbleMiss', 'sgHumbleDone', 'sgHumbleCorner']) delete el.dataset[flag];
    });
    nameUnmatched.clear();
    nameScan();
    scheduleUpdate();
    toast('Game name matches cleared.');
  });

  /* ---------------------------------------------------------------- *
   * Init
   * ---------------------------------------------------------------- */

  async function init() {
    if (!document.body) return;

    applyClasses();

    // Install scanning before network access so login failures are recoverable.
    scan(document);
    if (nameScanEnabled()) nameScan(); // badges appear right away, as "?" until ownership loads
    installObserver();
    installNavigationListeners();
    installSync();
    scheduleUpdate();

    noteRefreshResult(await loadData(false));
    updateAllStatuses();

    setInterval(() => {
      if (document.hidden || !settings.enabled) return;
      renderHealth();
      autoRefresh();
    }, 60000);

    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) { renderHealth(); autoRefresh(); }
    });

    console.info(`[Steam Highlighter] Stable v${VERSION} active on ${location.hostname}`);
  }

  init().catch(error => {
    console.error('[Steam Highlighter]', error);
    toast(error.message, true, 6500);
  });
})();