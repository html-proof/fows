import { request } from 'undici';
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
 * Follows HTTP redirects if returned.
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
    let currentUrl = rawUrl;
    let redirectCount = 0;
    const maxRedirects = 3;

    while (redirectCount <= maxRedirects) {
        const outboundHeaders = options.headers || getHeadersForStreamUrl(currentUrl);

        // Step 1: Fast HEAD probe
        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), timeoutMs);

            const res = await request(currentUrl, {
                method: 'HEAD',
                signal: controller.signal,
                headersTimeout: timeoutMs,
                bodyTimeout: timeoutMs,
                headers: outboundHeaders,
            });

            clearTimeout(timeout);

            const statusCode = res.statusCode;
            const headers = res.headers;
            await res.body.dump();

            // Handle HTTP redirects
            if ([301, 302, 307, 308].includes(statusCode) && headers.location) {
                currentUrl = new URL(headers.location, currentUrl).toString();
                redirectCount++;
                continue;
            }

            const contentType = String(headers['content-type'] || '').toLowerCase();
            const contentLength = headers['content-length'] ? parseInt(headers['content-length'], 10) : null;

            const isHls = contentType.includes('mpegurl') || currentUrl.includes('.m3u8');
            const isValidStatus = statusCode === 200 || statusCode === 206;
            const isValidType = isValidAudioContentType(contentType, currentUrl);

            if (isValidStatus && isValidType) {
                return {
                    isValid: true,
                    contentType: headers['content-type'] || 'audio/mp4',
                    contentLength,
                    statusCode,
                    isHls,
                    durationMs: Date.now() - startTime,
                };
            }
        } catch (_) {
            // Fallback to partial Range GET probe
        }

        // Step 2: Partial Range GET probe (bytes=0-1023)
        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), timeoutMs);

            const res = await request(currentUrl, {
                method: 'GET',
                signal: controller.signal,
                headersTimeout: timeoutMs,
                bodyTimeout: timeoutMs,
                headers: {
                    ...outboundHeaders,
                    'Range': 'bytes=0-1023',
                },
            });

            clearTimeout(timeout);

            const statusCode = res.statusCode;
            const headers = res.headers;

            // Handle HTTP redirects on GET
            if ([301, 302, 307, 308].includes(statusCode) && headers.location) {
                await res.body.dump();
                currentUrl = new URL(headers.location, currentUrl).toString();
                redirectCount++;
                continue;
            }

            const contentType = String(headers['content-type'] || '').toLowerCase();
            const contentLength = headers['content-length'] ? parseInt(headers['content-length'], 10) : null;

            const isHls = contentType.includes('mpegurl') || currentUrl.includes('.m3u8');
            const isValidStatus = statusCode === 200 || statusCode === 206;
            const isValidType = isValidAudioContentType(contentType, currentUrl);

            if (isValidStatus && isValidType) {
                let hasBytes = false;
                for await (const chunk of res.body) {
                    if (chunk && chunk.length > 0) {
                        hasBytes = true;
                        break;
                    }
                }
                if (hasBytes) {
                    return {
                        isValid: true,
                        contentType: headers['content-type'] || 'audio/mp4',
                        contentLength,
                        statusCode,
                        isHls,
                        durationMs: Date.now() - startTime,
                    };
                }
            } else {
                await res.body.dump();
            }

            return {
                isValid: false,
                contentType,
                contentLength,
                statusCode,
                isHls,
                durationMs: Date.now() - startTime,
            };
        } catch (err) {
            return {
                isValid: false,
                contentType: '',
                contentLength: null,
                statusCode: null,
                isHls: false,
                durationMs: Date.now() - startTime,
                error: err.message,
            };
        }
    }

    return {
        isValid: false,
        contentType: '',
        contentLength: null,
        statusCode: null,
        isHls: false,
        durationMs: Date.now() - startTime,
        error: 'Too many redirects',
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
