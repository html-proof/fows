import { AUDIO_STREAM_HEADERS, GAANA_HEADERS, JIOSAAVN_HEADERS } from '../config/headers.js';

const VALIDATION_TIMEOUT_MS = 2000;

/**
 * Resolve spoofed outbound headers based on target URL domain.
 */
export function getHeadersForStreamUrl(url) {
    if (!url || typeof url !== 'string') return { ...AUDIO_STREAM_HEADERS };
    const lower = url.toLowerCase();
    if (lower.includes('gaana') || lower.includes('akamaized.net')) {
        return {
            ...GAANA_HEADERS,
            ...AUDIO_STREAM_HEADERS,
            'Referer': 'https://gaana.com/',
            'Origin': 'https://gaana.com',
        };
    }
    if (lower.includes('jiosaavn') || lower.includes('saavncdn') || lower.includes('saavn')) {
        return {
            ...JIOSAAVN_HEADERS,
            ...AUDIO_STREAM_HEADERS,
            'Referer': 'https://www.jiosaavn.com/',
            'Origin': 'https://www.jiosaavn.com',
        };
    }
    return { ...AUDIO_STREAM_HEADERS };
}

/**
 * Check whether a content-type header indicates a valid playable audio/media stream.
 */
export function isValidAudioContentType(contentType = '', url = '') {
    const ct = String(contentType).toLowerCase().trim();
    const u = String(url).toLowerCase();

    // Reject HTML/JSON/Plain text error payloads
    if (ct.includes('text/html') || ct.includes('application/json') || ct.includes('text/plain')) {
        return false;
    }

    if (
        ct.startsWith('audio/') ||
        ct.startsWith('video/mp4') ||
        ct.includes('mp4') ||
        ct.includes('mpeg') ||
        ct.includes('aac') ||
        ct.includes('ogg') ||
        ct.includes('wav') ||
        ct.includes('x-mpegurl') ||
        ct.includes('vnd.apple.mpegurl') ||
        ct.includes('application/x-mpegurl') ||
        ct.includes('octet-stream')
    ) {
        return true;
    }

    // Fallback URL pattern check if content-type was generic
    if (u.includes('.mp4') || u.includes('.mp3') || u.includes('.m4a') || u.includes('.aac') || u.includes('.m3u8')) {
        return true;
    }

    return false;
}

/**
 * Probe a stream URL via HEAD or Range GET to check HTTP status and media Content-Type.
 * Uses Node built-in fetch() so it respects the global IPv4 dispatcher and follows redirects.
 *
 * @param {string} rawUrl - Upstream media stream URL
 * @param {object} [options]
 * @returns {Promise<{ isValid: boolean, contentType: string, contentLength: number|null, statusCode: number|null, isHls: boolean, durationMs: number }>}
 */
export async function probeStreamUrl(rawUrl, options = {}) {
    const startTime = Date.now();
    if (!rawUrl || typeof rawUrl !== 'string' || !rawUrl.startsWith('http')) {
        return {
            isValid: false,
            contentType: '',
            contentLength: null,
            statusCode: null,
            isHls: false,
            durationMs: 0,
            error: 'Invalid URL',
        };
    }

    const timeoutMs = options.timeoutMs || VALIDATION_TIMEOUT_MS;
    const outboundHeaders = options.headers || getHeadersForStreamUrl(rawUrl);

    // Step 1: Fast HEAD probe using fetch()
    try {
        const res = await fetch(rawUrl, {
            method: 'HEAD',
            headers: outboundHeaders,
            redirect: 'follow',
            signal: AbortSignal.timeout(timeoutMs),
        });

        const statusCode = res.status;
        const contentType = String(res.headers.get('content-type') || '').toLowerCase();
        const contentLength = res.headers.get('content-length') ? parseInt(res.headers.get('content-length'), 10) : null;
        const isHls = contentType.includes('mpegurl') || rawUrl.includes('.m3u8') || res.url.includes('.m3u8');
        const isValidStatus = statusCode === 200 || statusCode === 206;
        const isValidType = isValidAudioContentType(contentType, rawUrl);

        if (isValidStatus && isValidType) {
            return {
                isValid: true,
                contentType: res.headers.get('content-type') || 'audio/mp4',
                contentLength,
                statusCode,
                isHls,
                durationMs: Date.now() - startTime,
            };
        }
    } catch (_) {
        // Fallback to partial Range GET probe
    }

    // Step 2: Partial Range GET probe (bytes=0-1023) using fetch()
    try {
        const res = await fetch(rawUrl, {
            method: 'GET',
            headers: {
                ...outboundHeaders,
                'Range': 'bytes=0-1023',
            },
            redirect: 'follow',
            signal: AbortSignal.timeout(timeoutMs),
        });

        const statusCode = res.status;
        const contentType = String(res.headers.get('content-type') || '').toLowerCase();
        const contentLength = res.headers.get('content-length') ? parseInt(res.headers.get('content-length'), 10) : null;
        const isHls = contentType.includes('mpegurl') || rawUrl.includes('.m3u8') || res.url.includes('.m3u8');
        const isValidStatus = statusCode === 200 || statusCode === 206;
        const isValidType = isValidAudioContentType(contentType, rawUrl);

        if (isValidStatus && isValidType) {
            return {
                isValid: true,
                contentType: res.headers.get('content-type') || 'audio/mp4',
                contentLength,
                statusCode,
                isHls,
                durationMs: Date.now() - startTime,
            };
        }
    } catch (_) {}

    return {
        isValid: false,
        contentType: '',
        contentLength: null,
        statusCode: null,
        isHls: false,
        durationMs: Date.now() - startTime,
        error: 'Validation failed or timed out',
    };
}

/**
 * Validates whether a media stream URL is playable (boolean wrapper for compatibility).
 *
 * @param {string} url - Candidate stream URL
 * @param {object} [options]
 * @returns {Promise<boolean>}
 */
export async function validatePlayableStream(url, options = {}) {
    const probe = await probeStreamUrl(url, options);
    return probe.isValid;
}
