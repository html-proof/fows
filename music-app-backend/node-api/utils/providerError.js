/**
 * Classifies an Axios error from a provider API call into a structured object
 * so callers can react correctly instead of returning a generic 500.
 */
function classifyProviderError(error) {
    if (!error.response) {
        // Network-level failure: DNS, TCP, TLS, or hard timeout.
        const isTimeout = error.code === 'ECONNABORTED' || error.message?.includes('timeout');
        return {
            type: isTimeout ? 'PROVIDER_TIMEOUT' : 'PROVIDER_UNREACHABLE',
            retryable: true,
            httpStatus: 503,
            message: isTimeout ? 'Provider timed out' : 'Provider unreachable',
        };
    }

    const status = error.response.status;

    if (status === 429) {
        return {
            type: 'PROVIDER_RATE_LIMITED',
            retryable: true,
            httpStatus: 429,
            message: 'Provider rate limit hit',
        };
    }

    if (status === 401 || status === 403) {
        return {
            type: 'PROVIDER_AUTH_FAILED',
            retryable: false,
            httpStatus: 502,
            message: 'Provider authentication failed',
        };
    }

    if (status === 404) {
        return {
            type: 'TRACK_NOT_FOUND',
            retryable: false,
            httpStatus: 404,
            message: 'Track not found at provider',
        };
    }

    if (status >= 500) {
        return {
            type: 'PROVIDER_SERVER_ERROR',
            retryable: true,
            httpStatus: 502,
            message: `Provider returned ${status}`,
        };
    }

    return {
        type: 'PROVIDER_UNEXPECTED',
        retryable: false,
        httpStatus: 502,
        message: `Unexpected provider response: ${status}`,
    };
}

module.exports = { classifyProviderError };
