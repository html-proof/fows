/**
 * Region Resolver
 *
 * Separates the AWS deployment region (ap-southeast-1) from the user's music
 * storefront.  The server's physical location must never dictate the catalog
 * country presented to users.
 *
 * Resolution priority (first non-empty valid code wins):
 *   1. X-User-Country   — client sends the device locale's country code
 *   2. CF-IPCountry     — Cloudflare injects the visitor's IP country
 *   3. X-Country-Code   — generic CDN / proxy header
 *   4. DEFAULT_STOREFRONT env var   (default: 'in')
 *
 * Returns a lowercase ISO 3166-1 alpha-2 code, e.g. 'in', 'sg', 'us', 'gb'.
 * Callers convert to uppercase when the downstream API requires it.
 */

// ─── Configurable default ─────────────────────────────────────────────────────
//
// Set DEFAULT_STOREFRONT=in (or sg, us, gb …) in your environment.
// This is the application-level fallback, NOT the AWS region.
//
const SERVER_DEFAULT = (process.env.DEFAULT_STOREFRONT ?? 'in')
    .trim()
    .toLowerCase()
    .slice(0, 2);

// ─── Valid iTunes / Apple Music storefronts ───────────────────────────────────
// Apple supports a specific set of storefronts. Reject anything outside this
// list so a malformed header cannot poison downstream cache keys.
//
const VALID_STOREFRONTS = new Set([
    'ae','ag','ai','al','am','ao','ar','at','au','az',
    'ba','bb','bd','be','bf','bg','bh','bj','bm','bn',
    'bo','br','bs','bt','bw','by','bz','ca','cd','cg',
    'ch','ci','cl','cm','co','cr','cv','cy','cz',
    'de','dj','dk','dm','do','dz','ec','ee','eg','er',
    'es','et','fi','fj','fm','fr','gb','gd','gh','gm',
    'gn','gq','gr','gt','gw','gy','hk','hn','hr','ht',
    'hu','id','ie','il','in','iq','is','it','jm','jo',
    'jp','ke','kg','kh','km','kn','kr','kw','ky',
    'kz','la','lb','lc','lk','lr','ls','lt','lu','lv',
    'ly','ma','md','me','mg','mk','ml','mn','mo','mr',
    'ms','mt','mu','mv','mw','mx','my','mz','na','ne',
    'ng','ni','nl','no','np','nr','nz','om','pa','pe',
    'pg','ph','pk','pl','pt','pw','py','qa','ro','rs',
    'ru','sa','sb','sc','se','sg','si','sk','sl','sn',
    'sr','st','sv','sz','td','tg','th','tj','tm','tn',
    'to','tr','tt','tv','tw','tz','ua','ug','us','uy',
    'uz','vc','ve','vg','vn','vu','ws','ye','za','zm','zw',
]);

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Resolve the iTunes storefront for this request.
 *
 * @param {import('express').Request} req
 * @returns {string}  lowercase 2-letter country code, e.g. 'in'
 */
export function resolveStorefront(req) {
    const candidates = [
        req.headers['x-user-country'],
        req.headers['cf-ipcountry'],
        req.headers['x-country-code'],
    ];

    for (const raw of candidates) {
        if (!raw) continue;
        const code = String(raw).trim().toLowerCase().slice(0, 2);
        if (/^[a-z]{2}$/.test(code) && VALID_STOREFRONTS.has(code)) {
            return code;
        }
    }

    return SERVER_DEFAULT;
}

/**
 * Resolve storefront and return it in the uppercase form that Apple's
 * iTunes Search API `country` parameter expects (e.g. 'IN', 'SG', 'US').
 *
 * @param {import('express').Request} req
 * @returns {string}
 */
export function resolveItunesCountry(req) {
    return resolveStorefront(req).toUpperCase();
}
