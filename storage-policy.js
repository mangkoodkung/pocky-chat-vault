export const DRIVE_USAGE_MODE_UNLIMITED = "unlimited";
export const DRIVE_USAGE_MODE_WARNING = "warning";
export const DEFAULT_DRIVE_USAGE_WARNING_GB = 10;

const DRIVE_USAGE_MODES = new Set([
    DRIVE_USAGE_MODE_UNLIMITED,
    DRIVE_USAGE_MODE_WARNING,
]);

export function normalizeDriveUsageMode(value) {
    return DRIVE_USAGE_MODES.has(value) ? value : DRIVE_USAGE_MODE_UNLIMITED;
}

export function normalizeDriveUsageWarningGb(value) {
    const parsed = Number.parseFloat(value);

    if (!Number.isFinite(parsed)) {
        return DEFAULT_DRIVE_USAGE_WARNING_GB;
    }

    return Math.min(1_000, Math.max(0.1, Math.round(parsed * 10) / 10));
}

export function calculateDriveBackupUsageBytes(files) {
    if (!Array.isArray(files)) {
        return 0;
    }

    return files.reduce((total, file) => {
        const size = Number(file?.size);
        return total + (Number.isFinite(size) && size > 0 ? size : 0);
    }, 0);
}

export function getDriveUsageWarningState({
    usedBytes = 0,
    mode = DRIVE_USAGE_MODE_UNLIMITED,
    warningGb = DEFAULT_DRIVE_USAGE_WARNING_GB,
} = {}) {
    const normalizedMode = normalizeDriveUsageMode(mode);
    const normalizedWarningGb = normalizeDriveUsageWarningGb(warningGb);
    const warningBytes = normalizedWarningGb * 1024 ** 3;
    const normalizedUsedBytes = Number.isFinite(Number(usedBytes))
        ? Math.max(0, Number(usedBytes))
        : 0;

    return {
        mode: normalizedMode,
        usedBytes: normalizedUsedBytes,
        warningGb: normalizedWarningGb,
        warningBytes,
        shouldWarn: normalizedMode === DRIVE_USAGE_MODE_WARNING
            && normalizedUsedBytes >= warningBytes,
    };
}
