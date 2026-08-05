export const DRIVE_UPLOAD_PENDING = "pending";
export const DRIVE_UPLOAD_FAILED = "failed";
export const DRIVE_UPLOAD_UPLOADED = "uploaded";

function normalizeAccountHint(value) {
    return String(value || "").trim().toLowerCase();
}

export function queueBackupForDrive(backup, {
    accountHint = "",
    folderName = "Chat Vault",
    queuedAt = new Date().toISOString(),
} = {}) {
    const previous = backup?.driveUpload;
    const sameSnapshot = previous?.snapshotId === backup?.snapshotId;

    return {
        ...backup,
        driveUpload: {
            status: DRIVE_UPLOAD_PENDING,
            snapshotId: String(backup?.snapshotId || ""),
            accountHint: normalizeAccountHint(accountHint),
            folderName: String(folderName || "Chat Vault").trim() || "Chat Vault",
            queuedAt,
            uploadedAt: "",
            lastAttemptAt: sameSnapshot ? String(previous.lastAttemptAt || "") : "",
            lastErrorCode: "",
            attempts: sameSnapshot ? Math.max(0, Number(previous.attempts) || 0) : 0,
        },
    };
}

export function markBackupDriveUploaded(backup, snapshotId, {
    uploadedAt = new Date().toISOString(),
} = {}) {
    if (!backup || backup.driveUpload?.snapshotId !== String(snapshotId || "")) {
        return backup;
    }

    return {
        ...backup,
        driveUpload: {
            ...backup.driveUpload,
            status: DRIVE_UPLOAD_UPLOADED,
            uploadedAt,
            lastAttemptAt: uploadedAt,
            lastErrorCode: "",
        },
    };
}

export function markBackupDriveFailed(backup, snapshotId, errorCode, {
    attemptedAt = new Date().toISOString(),
} = {}) {
    if (!backup || backup.driveUpload?.snapshotId !== String(snapshotId || "")) {
        return backup;
    }

    return {
        ...backup,
        driveUpload: {
            ...backup.driveUpload,
            status: DRIVE_UPLOAD_FAILED,
            lastAttemptAt: attemptedAt,
            lastErrorCode: String(errorCode || "unknown_error"),
            attempts: Math.max(0, Number(backup.driveUpload.attempts) || 0) + 1,
        },
    };
}

export function isPendingDriveBackupForAccount(backup, accountHint) {
    const status = backup?.driveUpload?.status;

    if (![DRIVE_UPLOAD_PENDING, DRIVE_UPLOAD_FAILED].includes(status)) {
        return false;
    }

    const targetAccount = normalizeAccountHint(backup.driveUpload.accountHint);
    const activeAccount = normalizeAccountHint(accountHint);

    return !targetAccount || (Boolean(activeAccount) && targetAccount === activeAccount);
}
