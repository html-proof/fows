/**
 * Middleware / helper providing spoofed browser headers for outbound API and stream requests.
 */

import {
    BROWSER_USER_AGENT,
    JIOSAAVN_HEADERS,
    GAANA_HEADERS,
    AUDIO_STREAM_HEADERS,
} from '../config/headers.js';

export function getSpoofedHeaders(provider = 'jiosaavn', customHeaders = {}) {
    let base = {};
    if (provider === 'gaana') {
        base = { ...GAANA_HEADERS };
    } else if (provider === 'stream') {
        base = { ...AUDIO_STREAM_HEADERS };
    } else {
        base = { ...JIOSAAVN_HEADERS };
    }
    return {
        ...base,
        ...customHeaders,
    };
}

export {
    BROWSER_USER_AGENT,
    JIOSAAVN_HEADERS,
    GAANA_HEADERS,
    AUDIO_STREAM_HEADERS,
};
