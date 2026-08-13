import { request } from 'undici';

const VALIDATION_TIMEOUT_MS = 1500;
const AUDIO_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
    'Referer': 'https://gaana.com/',
    'Accept': '*/*',
};

/**
 * Validates whether a media stream URL is truly playable.
 * 1. Executes a HEAD request (checks status code and ensures Content-Type is not HTML/JSON error page).
 * 2. Executes a Range GET request (bytes=0-1023) to verify 200/206 status and non-empty byte stream delivery.
 *
 * @param {string} url - Candidate stream URL
 * @returns {Promise<boolean>}
 */
export async function validatePlayableStream(url) {
    if (!url || typeof url !== 'string' || !url.startsWith('http')) return false;

    // Step 1: Fast HEAD probe
    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), VALIDATION_TIMEOUT_MS);

        const { statusCode, headers } = await request(url, {
            method: 'HEAD',
            signal: controller.signal,
            headersTimeout: VALIDATION_TIMEOUT_MS,
            bodyTimeout: VALIDATION_TIMEOUT_MS,
            headers: AUDIO_HEADERS,
        });

        clearTimeout(timeout);

        const contentType = String(headers['content-type'] || '').toLowerCase();
        if (contentType.includes('text/html') || contentType.includes('application/json')) {
            return false;
        }

        if (statusCode >= 200 && statusCode < 400) {
            return true;
        }
    } catch (_) {
        // Continue to Range GET probe on HEAD failure or Method Not Allowed
    }

    // Step 2: Range GET byte-read probe (verify partial content delivery)
    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), VALIDATION_TIMEOUT_MS);

        const response = await request(url, {
            method: 'GET',
            signal: controller.signal,
            headersTimeout: VALIDATION_TIMEOUT_MS,
            bodyTimeout: VALIDATION_TIMEOUT_MS,
            headers: {
                ...AUDIO_HEADERS,
                'Range': 'bytes=0-1023',
            },
        });

        clearTimeout(timeout);

        const { statusCode, headers, body } = response;
        const contentType = String(headers['content-type'] || '').toLowerCase();
        if (contentType.includes('text/html') || contentType.includes('application/json')) {
            return false;
        }

        if (statusCode === 200 || statusCode === 206) {
            for await (const chunk of body) {
                if (chunk && chunk.length > 0) {
                    return true;
                }
            }
        }
        return false;
    } catch (_) {
        return false;
    }
}
