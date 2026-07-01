let shuttingDown = false;

export function markShuttingDown() {
    shuttingDown = true;
}

export function isShuttingDown() {
    return shuttingDown;
}
