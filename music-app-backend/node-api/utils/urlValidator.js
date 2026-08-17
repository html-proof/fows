const dns = require('dns').promises;

// Allowlist of provider CDN hostnames whose URLs we permit.
// Extend this list as adapters are added; never allow arbitrary hostnames.
const ALLOWED_HOSTNAMES = new Set([
    'jiosaavn.com',
    'saavn.com',
    'akamaized.net',      // JioSaavn CDN
    'gaana.com',
    'cdngaana.com',       // Gaana CDN
    'c.saavncdn.com',
    'ui.saavncdn.com',
    'saavncdn.com',
]);

// Private/loopback CIDR blocks that must never be reached.
const PRIVATE_PREFIXES = [
    '10.',
    '172.16.', '172.17.', '172.18.', '172.19.',
    '172.20.', '172.21.', '172.22.', '172.23.',
    '172.24.', '172.25.', '172.26.', '172.27.',
    '172.28.', '172.29.', '172.30.', '172.31.',
    '192.168.',
    '127.',
    '169.254.',   // link-local / AWS metadata
    '::1',
    'fc', 'fd',   // IPv6 ULA
];

/**
 * Returns the registered domain (eTLD+1) of a hostname.
 * e.g. "c.saavncdn.com" → "saavncdn.com"
 */
function registeredDomain(hostname) {
    const parts = hostname.toLowerCase().split('.');
    if (parts.length < 2) return hostname.toLowerCase();
    return parts.slice(-2).join('.');
}

function isPrivateIp(address) {
    return PRIVATE_PREFIXES.some(prefix => address.startsWith(prefix));
}

/**
 * Validates a provider-supplied playback URL against the allowlist and SSRF
 * checks. Throws a descriptive Error on failure; resolves true on success.
 *
 * @param {string} rawUrl
 * @returns {Promise<true>}
 */
async function validateProviderUrl(rawUrl) {
    let parsed;
    try {
        parsed = new URL(rawUrl);
    } catch {
        throw new Error(`Invalid URL: ${rawUrl}`);
    }

    if (parsed.protocol !== 'https:') {
        throw new Error(`Only HTTPS URLs are permitted. Got: ${parsed.protocol}`);
    }

    const hostname = parsed.hostname.toLowerCase();

    // Non-standard ports are not expected from any provider CDN.
    const port = parsed.port ? parseInt(parsed.port, 10) : 443;
    if (port !== 443) {
        throw new Error(`Non-standard port rejected: ${port}`);
    }

    if (!ALLOWED_HOSTNAMES.has(registeredDomain(hostname))) {
        throw new Error(`Hostname not in allowlist: ${hostname}`);
    }

    // DNS resolution check to catch SSRF via DNS rebinding.
    try {
        const addresses = await dns.resolve4(hostname).catch(() => []);
        const v6 = await dns.resolve6(hostname).catch(() => []);
        const all = [...addresses, ...v6];
        for (const addr of all) {
            if (isPrivateIp(addr)) {
                throw new Error(`Resolved to private IP (SSRF): ${addr}`);
            }
        }
    } catch (e) {
        if (e.message.includes('SSRF')) throw e;
        // DNS failure for a CDN is a provider issue, not SSRF — let the
        // downstream fetch surface the actual error.
    }

    return true;
}

module.exports = { validateProviderUrl, ALLOWED_HOSTNAMES };
