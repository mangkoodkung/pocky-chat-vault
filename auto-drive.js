export const DEFAULT_DRIVE_AUTO_UPLOAD_EVERY_MESSAGES = 1;

function normalizeMessageInterval(value) {
    const parsed = Number.parseInt(value, 10);

    if (!Number.isFinite(parsed)) {
        return DEFAULT_DRIVE_AUTO_UPLOAD_EVERY_MESSAGES;
    }

    return Math.min(Math.max(parsed, 1), 100);
}

function readBackupMessageCount(backup) {
    const count = Number(backup?.messageCount);

    return Number.isFinite(count) ? count : null;
}

function readBackupVersion(backup) {
    return String(backup?.snapshotId || backup?.savedAt || "");
}

export class DriveAutoUploadQueue {
    constructor(upload, options = {}) {
        if (typeof upload !== "function") {
            throw new TypeError("DriveAutoUploadQueue requires an upload function");
        }

        this.upload = upload;
        this.now = options.now || (() => Date.now());
        this.retryDelayMs = Math.max(0, Number(options.retryDelayMs) || 60_000);
        this.maxRetryDelayMs = Math.max(
            this.retryDelayMs,
            Number(options.maxRetryDelayMs) || 15 * 60_000,
        );
        this.lastUploadedMessageCounts = new Map();
        this.lastUploadedVersions = new Map();
        this.retryNotBefore = new Map();
        this.consecutiveFailures = new Map();
        this.pending = [];
        this.worker = null;
    }

    shouldQueue(backup, messageInterval) {
        const backupId = String(backup?.id || "");
        const messageCount = readBackupMessageCount(backup);

        if (!backupId || messageCount === null) {
            return false;
        }

        if ((this.retryNotBefore.get(backupId) || 0) > this.now()) {
            return false;
        }

        const lastUploadedCount = this.lastUploadedMessageCounts.get(backupId);
        const normalizedInterval = normalizeMessageInterval(messageInterval);

        if (!Number.isFinite(lastUploadedCount)) {
            return true;
        }

        if (normalizedInterval === 1) {
            return messageCount !== lastUploadedCount
                || readBackupVersion(backup) !== this.lastUploadedVersions.get(backupId);
        }

        const messageDelta = messageCount - lastUploadedCount;

        return messageDelta < 0
            || messageDelta >= normalizedInterval;
    }

    markUploaded(backup) {
        const backupId = String(backup?.id || "");
        const messageCount = readBackupMessageCount(backup);

        if (!backupId || messageCount === null) {
            return;
        }

        this.lastUploadedMessageCounts.set(backupId, messageCount);
        this.lastUploadedVersions.set(backupId, readBackupVersion(backup));
        this.retryNotBefore.delete(backupId);
        this.consecutiveFailures.delete(backupId);
    }

    reset() {
        this.lastUploadedMessageCounts.clear();
        this.lastUploadedVersions.clear();
        this.retryNotBefore.clear();
        this.consecutiveFailures.clear();
        this.pending.length = 0;
    }

    enqueue(backup, messageInterval = DEFAULT_DRIVE_AUTO_UPLOAD_EVERY_MESSAGES) {
        const normalizedInterval = normalizeMessageInterval(messageInterval);

        if (!this.shouldQueue(backup, normalizedInterval)) {
            return Promise.resolve({ queued: false, uploaded: false });
        }

        // Drive stores only the latest file for each chat. While one snapshot is
        // uploading, replace an older waiting snapshot of the same chat with the
        // newest one. This bounds memory use without allowing stale writes.
        const pendingIndex = this.pending.findIndex(
            (job) => String(job.backup?.id || "") === String(backup?.id || ""),
        );
        const job = { backup, messageInterval: normalizedInterval };

        if (pendingIndex >= 0) {
            this.pending[pendingIndex] = job;
        } else {
            this.pending.push(job);
        }

        if (!this.worker) {
            const worker = this.drain();

            this.worker = worker;
            worker.then(
                () => {
                    if (this.worker === worker) {
                        this.worker = null;
                    }
                },
                () => {
                    if (this.worker === worker) {
                        this.worker = null;
                    }
                },
            );
        }

        return this.worker;
    }

    async drain() {
        let outcome = { queued: true, uploaded: false };

        while (this.pending.length > 0) {
            const job = this.pending.shift();

            if (!this.shouldQueue(job.backup, job.messageInterval)) {
                continue;
            }

            try {
                const file = await this.upload(job.backup);

                this.markUploaded(job.backup);
                outcome = {
                    queued: true,
                    uploaded: true,
                    backup: job.backup,
                    file,
                };
            } catch (error) {
                const backupId = String(job.backup?.id || "");

                if (backupId) {
                    const failures = (this.consecutiveFailures.get(backupId) || 0) + 1;
                    const retryDelay = Math.min(
                        this.retryDelayMs * (2 ** Math.max(0, failures - 1)),
                        this.maxRetryDelayMs,
                    );

                    this.consecutiveFailures.set(backupId, failures);
                    this.retryNotBefore.set(backupId, this.now() + retryDelay);
                }

                this.pending.length = 0;
                throw error;
            }
        }

        return outcome;
    }
}
