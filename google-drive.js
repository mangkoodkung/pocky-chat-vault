const GOOGLE_IDENTITY_SCRIPT_URL = "https://accounts.google.com/gsi/client";
const GOOGLE_DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
const GOOGLE_DRIVE_API_URL = "https://www.googleapis.com/drive/v3";
const GOOGLE_DRIVE_UPLOAD_URL = "https://www.googleapis.com/upload/drive/v3";
const STALE_BACKUP_CLOCK_SKEW_MS = 5 * 60 * 1000;
const DRIVE_ORGANIZATION_CACHE_MS = 10 * 60 * 1000;
export const DEFAULT_GOOGLE_DRIVE_FOLDER_NAME = "Chat Vault";

let googleIdentityPromise = null;
let accessToken = null;
let accessTokenExpiresAt = 0;
let activeFolderName = DEFAULT_GOOGLE_DRIVE_FOLDER_NAME;
const cachedFolderIds = new Map();
const cachedBackupFileIds = new Map();
let lastOrganizationResult = null;
let lastOrganizationAt = 0;

export class GoogleDriveError extends Error {
    constructor(code, message, cause = null) {
        super(message);
        this.name = "GoogleDriveError";
        this.code = code;

        if (cause) {
            this.cause = cause;
        }
    }
}

function hasGoogleIdentityServices() {
    return Boolean(globalThis.google?.accounts?.oauth2?.initTokenClient);
}

export function prepareGoogleDrive() {
    if (hasGoogleIdentityServices()) {
        return Promise.resolve();
    }

    if (googleIdentityPromise) {
        return googleIdentityPromise;
    }

    googleIdentityPromise = new Promise((resolve, reject) => {
        const existingScript = document.querySelector(
            `script[src="${GOOGLE_IDENTITY_SCRIPT_URL}"]`,
        );
        const script = existingScript || document.createElement("script");

        const handleLoad = () => {
            if (hasGoogleIdentityServices()) {
                resolve();
            } else {
                googleIdentityPromise = null;
                reject(new GoogleDriveError(
                    "identity_unavailable",
                    "Google Identity Services loaded without OAuth support",
                ));
            }
        };

        const handleError = (error) => {
            googleIdentityPromise = null;
            reject(new GoogleDriveError(
                "identity_load_failed",
                "Unable to load Google Identity Services",
                error,
            ));
        };

        script.addEventListener("load", handleLoad, { once: true });
        script.addEventListener("error", handleError, { once: true });

        if (!existingScript) {
            script.src = GOOGLE_IDENTITY_SCRIPT_URL;
            script.async = true;
            script.defer = true;
            script.referrerPolicy = "no-referrer-when-downgrade";
            document.head.append(script);
        }
    });

    return googleIdentityPromise;
}

function normalizeClientId(clientId) {
    const value = String(clientId || "").trim();

    if (!value) {
        throw new GoogleDriveError(
            "client_id_missing",
            "Google OAuth Client ID is not configured",
        );
    }

    if (!value.endsWith(".apps.googleusercontent.com")) {
        throw new GoogleDriveError(
            "client_id_invalid",
            "Google OAuth Client ID has an invalid format",
        );
    }

    return value;
}

async function requestGoogleDriveAccessToken(clientId, {
    prompt = "",
    loginHint = "",
} = {}) {
    const normalizedClientId = normalizeClientId(clientId);
    const normalizedLoginHint = String(loginHint || "").trim();

    await prepareGoogleDrive();

    return await new Promise((resolve, reject) => {
        let settled = false;
        const authorizationTimeout = globalThis.setTimeout(() => {
            finishWithError(
                "authorization_timeout",
                "Google authorization did not return to Chat Vault",
            );
        }, 300_000);

        const finishWithError = (code, message, cause = null) => {
            if (settled) {
                return;
            }

            settled = true;
            globalThis.clearTimeout(authorizationTimeout);
            reject(new GoogleDriveError(code, message, cause));
        };

        try {
            const tokenClient = globalThis.google.accounts.oauth2.initTokenClient({
                client_id: normalizedClientId,
                scope: GOOGLE_DRIVE_SCOPE,
                callback: (response) => {
                    if (response?.error) {
                        finishWithError(
                            response.error,
                            response.error_description || "Google authorization failed",
                        );
                        return;
                    }

                    if (!response?.access_token) {
                        finishWithError(
                            "access_token_missing",
                            "Google did not return an access token",
                        );
                        return;
                    }

                    const expiresInSeconds = Math.max(
                        0,
                        Number.parseInt(response.expires_in, 10) || 3600,
                    );

                    accessToken = response.access_token;
                    accessTokenExpiresAt = Date.now() + (expiresInSeconds * 1000);
                    cachedFolderIds.clear();
                    cachedBackupFileIds.clear();
                    settled = true;
                    globalThis.clearTimeout(authorizationTimeout);
                    resolve({ expiresAt: accessTokenExpiresAt });
                },
                error_callback: (error) => {
                    finishWithError(
                        error?.type || "popup_failed",
                        error?.message || "Google sign-in window was closed or blocked",
                        error,
                    );
                },
            });

            tokenClient.requestAccessToken({
                prompt,
                ...(normalizedLoginHint ? { login_hint: normalizedLoginHint } : {}),
            });
        } catch (error) {
            finishWithError(
                "authorization_start_failed",
                "Unable to start Google authorization",
                error,
            );
        }
    });
}

export function connectGoogleDrive(clientId, {
    loginHint = "",
    selectAccount = false,
} = {}) {
    return requestGoogleDriveAccessToken(clientId, {
        prompt: selectAccount ? "select_account" : "",
        loginHint: selectAccount ? "" : loginHint,
    });
}

export function restoreGoogleDriveConnection(clientId, loginHint = "") {
    return requestGoogleDriveAccessToken(clientId, {
        prompt: "none",
        loginHint,
    });
}

/* ---------------------------------------------------------------------------
 * Redirect authorization (mobile)
 *
 * The popup flow above cannot complete on iOS: WebKit drops window.opener from
 * the authorization window, so Google has nowhere to hand the token back and the
 * window just closes. Every browser on iOS is WebKit, so there is no "use a
 * different browser" answer, and Google's token client is popup-only — it has no
 * redirect mode. The way out is to leave the page entirely, let Google return
 * the token in the URL fragment, and pick it up on the way back.
 *
 * That is the OAuth implicit flow, which Google keeps working but no longer
 * recommends, because a token in a URL is easier to steal or to swap for someone
 * else's. Both risks are handled below and neither is optional:
 *   - a random `state` is stored before leaving and must come back unchanged,
 *     so a link someone else crafted cannot inject a token;
 *   - the returned token is checked against Google to confirm it was issued to
 *     THIS client id and carries only our scope, which is what stops a token
 *     minted for another app from being accepted here;
 *   - the fragment is wiped from the address bar and from history immediately.
 * ------------------------------------------------------------------------- */

const GOOGLE_OAUTH_AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_INFO_ENDPOINT = "https://oauth2.googleapis.com/tokeninfo";
const REDIRECT_STATE_STORAGE_KEY = "chatVaultGoogleRedirectState";

// Where Google sends the browser back to. Deliberately the page itself with no
// query string: this exact value has to be registered as an Authorized redirect
// URI, and anything that varies per visit could never be registered.
export function getGoogleDriveRedirectUri() {
    const { origin, pathname } = globalThis.location;

    return `${origin}${pathname}`;
}

// iOS, including iPadOS which reports itself as a Mac but has a touch screen.
export function shouldUseGoogleDriveRedirect() {
    const nav = globalThis.navigator;
    const ua = String(nav?.userAgent || "");

    if (/iPad|iPhone|iPod/.test(ua)) {
        return true;
    }

    return ua.includes("Macintosh") && Number(nav?.maxTouchPoints || 0) > 1;
}

function createRedirectState() {
    const bytes = new Uint8Array(16);

    globalThis.crypto.getRandomValues(bytes);

    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function startGoogleDriveRedirectAuthorization(clientId, {
    loginHint = "",
    selectAccount = false,
} = {}) {
    const normalizedClientId = normalizeClientId(clientId);
    const state = createRedirectState();
    const redirectUri = getGoogleDriveRedirectUri();

    // sessionStorage, not localStorage: the value is meaningless after this tab
    // finishes the round trip, and it must not leak into other tabs.
    globalThis.sessionStorage.setItem(REDIRECT_STATE_STORAGE_KEY, JSON.stringify({
        state,
        clientId: normalizedClientId,
        redirectUri,
    }));

    const params = new URLSearchParams({
        client_id: normalizedClientId,
        redirect_uri: redirectUri,
        response_type: "token",
        scope: GOOGLE_DRIVE_SCOPE,
        state,
        include_granted_scopes: "true",
    });

    if (selectAccount) {
        params.set("prompt", "select_account");
    } else if (loginHint) {
        params.set("login_hint", String(loginHint).trim());
    }

    globalThis.location.assign(`${GOOGLE_OAUTH_AUTH_ENDPOINT}?${params.toString()}`);
}

// Remove the fragment without adding a history entry, so the token is not left
// sitting in the address bar or reachable with the back button.
function stripAuthorizationFragment() {
    const { origin, pathname, search } = globalThis.location;

    globalThis.history.replaceState(null, "", `${origin}${pathname}${search}`);
}

// A token arriving in a URL proves nothing on its own. Ask Google who it was
// issued to and refuse anything that is not ours.
async function assertTokenBelongsToClient(token, expectedClientId) {
    const response = await fetch(
        `${GOOGLE_TOKEN_INFO_ENDPOINT}?access_token=${encodeURIComponent(token)}`,
    );

    if (!response.ok) {
        throw new GoogleDriveError(
            "redirect_token_unverified",
            "Google could not confirm the returned token",
        );
    }

    const info = await response.json();

    if (info.aud !== expectedClientId) {
        throw new GoogleDriveError(
            "redirect_token_foreign",
            "The returned token was issued to a different application",
        );
    }

    if (!String(info.scope || "").split(/\s+/).includes(GOOGLE_DRIVE_SCOPE)) {
        throw new GoogleDriveError(
            "redirect_token_scope",
            "The returned token does not carry the Drive scope",
        );
    }

    return Math.max(0, Number.parseInt(info.expires_in, 10) || 0);
}

export async function consumeGoogleDriveRedirectAuthorization() {
    const stored = globalThis.sessionStorage.getItem(REDIRECT_STATE_STORAGE_KEY);
    const rawHash = String(globalThis.location.hash || "").replace(/^#/, "");

    if (!rawHash || !stored) {
        return { status: "none" };
    }

    const fragment = new URLSearchParams(rawHash);
    const returnedState = fragment.get("state");

    // Not our round trip — leave the fragment alone, SillyTavern may use it.
    if (!returnedState) {
        return { status: "none" };
    }

    globalThis.sessionStorage.removeItem(REDIRECT_STATE_STORAGE_KEY);
    stripAuthorizationFragment();

    let expected;

    try {
        expected = JSON.parse(stored);
    } catch (error) {
        return { status: "error", code: "redirect_state_invalid" };
    }

    if (returnedState !== expected.state) {
        return { status: "error", code: "redirect_state_mismatch" };
    }

    const returnedError = fragment.get("error");

    if (returnedError) {
        return { status: "error", code: returnedError };
    }

    const token = fragment.get("access_token");

    if (!token) {
        return { status: "error", code: "access_token_missing" };
    }

    try {
        const verifiedExpiresIn = await assertTokenBelongsToClient(token, expected.clientId);
        const expiresInSeconds = verifiedExpiresIn
            || Math.max(0, Number.parseInt(fragment.get("expires_in"), 10) || 3600);

        accessToken = token;
        accessTokenExpiresAt = Date.now() + (expiresInSeconds * 1000);
        cachedFolderIds.clear();
        cachedBackupFileIds.clear();

        return { status: "connected", expiresAt: accessTokenExpiresAt };
    } catch (error) {
        return {
            status: "error",
            code: error instanceof GoogleDriveError ? error.code : "redirect_token_unverified",
        };
    }
}

export function clearGoogleDriveSession() {
    accessToken = null;
    accessTokenExpiresAt = 0;
    cachedFolderIds.clear();
    cachedBackupFileIds.clear();
    lastOrganizationResult = null;
    lastOrganizationAt = 0;
}

export function isGoogleDriveConnected() {
    return Boolean(accessToken) && accessTokenExpiresAt > Date.now() + 60_000;
}

function requireAccessToken() {
    if (!isGoogleDriveConnected()) {
        clearGoogleDriveSession();
        throw new GoogleDriveError(
            "authorization_required",
            "Google Drive authorization is required",
        );
    }

    return accessToken;
}

async function readGoogleError(response) {
    try {
        const body = await response.json();
        return body?.error?.message || body?.error_description || response.statusText;
    } catch {
        return response.statusText || `Google Drive request failed (${response.status})`;
    }
}

async function driveRequest(url, options = {}) {
    const token = requireAccessToken();
    const headers = new Headers(options.headers || {});

    headers.set("Authorization", `Bearer ${token}`);

    let response;

    try {
        response = await fetch(url, { ...options, headers });
    } catch (error) {
        throw new GoogleDriveError(
            "network_error",
            "Unable to reach Google Drive",
            error,
        );
    }

    if (response.status === 401) {
        clearGoogleDriveSession();
        throw new GoogleDriveError(
            "authorization_required",
            "Google Drive authorization expired",
        );
    }

    if (response.status === 404) {
        throw new GoogleDriveError(
            "drive_file_not_found",
            "The Google Drive file no longer exists",
        );
    }

    if (response.status === 429 || response.status >= 500) {
        throw new GoogleDriveError(
            "drive_temporarily_unavailable",
            await readGoogleError(response),
        );
    }

    if (!response.ok) {
        throw new GoogleDriveError(
            "drive_request_failed",
            await readGoogleError(response),
        );
    }

    return response;
}

export function normalizeGoogleDriveFolderName(folderName) {
    const value = String(folderName || "")
        .replace(/[\u0000-\u001F\u007F]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 80);

    if (!value) {
        throw new GoogleDriveError(
            "folder_name_missing",
            "Google Drive folder name is empty",
        );
    }

    return value;
}

export function setGoogleDriveFolderName(folderName) {
    const normalizedFolderName = normalizeGoogleDriveFolderName(folderName);

    if (normalizedFolderName !== activeFolderName) {
        lastOrganizationResult = null;
        lastOrganizationAt = 0;
    }

    activeFolderName = normalizedFolderName;
    return activeFolderName;
}

export async function getGoogleDriveAccount() {
    const url = new URL(`${GOOGLE_DRIVE_API_URL}/about`);

    url.searchParams.set("fields", "user(displayName,emailAddress,photoLink)");

    const response = await driveRequest(url.href);
    const result = await response.json();

    return {
        displayName: String(result?.user?.displayName || "").trim(),
        emailAddress: String(result?.user?.emailAddress || "").trim(),
        photoLink: String(result?.user?.photoLink || "").trim(),
    };
}

async function findFolderByQuery(query) {
    const url = new URL(`${GOOGLE_DRIVE_API_URL}/files`);

    url.searchParams.set("q", query);
    url.searchParams.set("spaces", "drive");
    url.searchParams.set("pageSize", "1");
    url.searchParams.set("fields", "files(id,name,webViewLink)");

    const response = await driveRequest(url.href);
    const result = await response.json();

    return result.files?.[0] || null;
}

async function findChatVaultFolder(folderName, folderKey) {
    const folderQuery = [
        "appProperties has { key='chatVaultRoot' and value='true' }",
        `appProperties has { key='chatVaultFolderKey' and value='${escapeDriveQueryValue(folderKey)}' }`,
        "mimeType='application/vnd.google-apps.folder'",
        "trashed=false",
    ].join(" and ");
    const folder = await findFolderByQuery(folderQuery);

    if (folder || folderName !== DEFAULT_GOOGLE_DRIVE_FOLDER_NAME) {
        return folder;
    }

    const legacyQuery = [
        "appProperties has { key='chatVaultRoot' and value='true' }",
        `name='${escapeDriveQueryValue(DEFAULT_GOOGLE_DRIVE_FOLDER_NAME)}'`,
        "mimeType='application/vnd.google-apps.folder'",
        "trashed=false",
    ].join(" and ");

    return await findFolderByQuery(legacyQuery);
}

async function createChatVaultFolder(folderName, folderKey) {
    const response = await driveRequest(
        `${GOOGLE_DRIVE_API_URL}/files?fields=id,name,webViewLink`,
        {
            method: "POST",
            headers: {
                "Content-Type": "application/json; charset=UTF-8",
            },
            body: JSON.stringify({
                name: folderName,
                mimeType: "application/vnd.google-apps.folder",
                appProperties: {
                    chatVaultRoot: "true",
                    chatVaultFolderKey: folderKey,
                },
            }),
        },
    );
    const folder = await response.json();

    if (!folder.id) {
        throw new GoogleDriveError(
            "folder_create_failed",
            "Google Drive did not return the Chat Vault folder ID",
        );
    }

    return folder;
}

export async function ensureGoogleDriveFolder() {
    const folderName = activeFolderName;
    const folderKey = await createOpaqueKey(folderName);
    const cachedFolder = cachedFolderIds.get(folderKey);

    if (cachedFolder) {
        return cachedFolder;
    }

    const folder = await findChatVaultFolder(folderName, folderKey)
        || await createChatVaultFolder(folderName, folderKey);
    const normalizedFolder = {
        id: folder.id,
        name: folder.name || folderName,
        webViewLink: folder.webViewLink
            || `https://drive.google.com/drive/folders/${encodeURIComponent(folder.id)}`,
    };

    cachedFolderIds.set(folderKey, normalizedFolder);
    return normalizedFolder;
}

async function getChatVaultFolderId() {
    const folder = await ensureGoogleDriveFolder();
    return folder.id;
}

function createLatestFileName(backup) {
    const requestedName = String(backup.fileName || "chat-vault_backup.jsonl");
    const extension = requestedName.toLocaleLowerCase().endsWith(".cvault")
        ? ".cvault"
        : ".jsonl";
    const baseName = requestedName
        .replace(/\.(?:jsonl|cvault)$/i, "")
        .slice(0, 120);

    if (backup?.isCheckpoint) {
        const checkpointName = String(backup.checkpointName || "checkpoint")
            .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 48) || "checkpoint";
        const timestamp = String(backup.savedAt || new Date().toISOString())
            .replace(/[^0-9]/g, "")
            .slice(0, 14) || String(Date.now());

        return `${baseName.slice(0, 72)}_checkpoint_${checkpointName}_${timestamp}${extension}`;
    }

    return `${baseName}${extension}`;
}

function fallbackBackupKey(value) {
    let hash = 0x811c9dc5;

    for (let index = 0; index < value.length; index += 1) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193);
    }

    return `fnv1a-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

async function createOpaqueKey(identity) {
    if (!globalThis.crypto?.subtle || typeof globalThis.TextEncoder !== "function") {
        return fallbackBackupKey(identity);
    }

    const bytes = new TextEncoder().encode(identity);
    const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);

    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0"))
        .join("");
}

async function createContentHash(content) {
    const digest = await createOpaqueKey(String(content || ""));

    return digest.startsWith("fnv1a-") ? digest : `sha256-${digest}`;
}

function readTimestamp(value) {
    const timestamp = Date.parse(String(value || ""));

    return Number.isFinite(timestamp) ? timestamp : null;
}

export function isIncomingBackupStale(existingFile, backup) {
    const remoteSavedAt = readTimestamp(
        existingFile?.appProperties?.chatVaultSavedAt,
    );
    const incomingSavedAt = readTimestamp(backup?.savedAt);

    return remoteSavedAt !== null
        && incomingSavedAt !== null
        && remoteSavedAt > incomingSavedAt + STALE_BACKUP_CLOCK_SKEW_MS;
}

function createConflictFileName(fileName, savedAt) {
    const timestamp = String(savedAt || new Date().toISOString())
        .replace(/[^0-9]/g, "")
        .slice(0, 14) || String(Date.now());

    const requestedName = String(fileName || "chat-vault_backup.jsonl");
    const extension = requestedName.toLocaleLowerCase().endsWith(".cvault")
        ? ".cvault"
        : ".jsonl";

    return requestedName
        .replace(/\.(?:jsonl|cvault)$/i, "")
        .slice(0, 96) + `_conflict_${timestamp}${extension}`;
}

async function createBackupKey(backup) {
    const identity = String(backup?.id || "").trim();

    if (!identity) {
        throw new GoogleDriveError(
            "backup_identity_missing",
            "Backup identity is empty",
        );
    }

    if (backup?.isCheckpoint) {
        const snapshotId = String(backup.snapshotId || backup.savedAt || "").trim();

        if (!snapshotId) {
            throw new GoogleDriveError(
                "backup_identity_missing",
                "Checkpoint identity is empty",
            );
        }

        return await createOpaqueKey(`${identity}:checkpoint:${snapshotId}`);
    }

    return await createOpaqueKey(identity);
}

async function createEntityKey(backup) {
    const entityType = String(backup?.entityType || "").trim();
    const entityId = String(backup?.entityId || "").trim();

    if (!entityType || !entityId) {
        return null;
    }

    return await createOpaqueKey(`${entityType}:${entityId}`);
}

function escapeDriveQueryValue(value) {
    return String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

async function findBackupFile(folderId, backupKey) {
    const cacheKey = `${folderId}:${backupKey}`;
    const cachedFileId = cachedBackupFileIds.get(cacheKey);

    if (cachedFileId) {
        try {
            return await getFileLocation(cachedFileId);
        } catch (error) {
            if (
                error instanceof GoogleDriveError
                && ["drive_file_not_found", "drive_file_trashed"].includes(error.code)
            ) {
                cachedBackupFileIds.delete(cacheKey);
            } else {
                throw error;
            }
        }
    }

    const backupQuery = `appProperties has { key='chatVaultBackupKey' and value='${escapeDriveQueryValue(backupKey)}' }`;
    const folderQuery = [
        backupQuery,
        `'${escapeDriveQueryValue(folderId)}' in parents`,
        "trashed=false",
    ].join(" and ");
    const globalQuery = [
        backupQuery,
        "trashed=false",
    ].join(" and ");

    const findFile = async (query) => {
        const url = new URL(`${GOOGLE_DRIVE_API_URL}/files`);

        url.searchParams.set("q", query);
        url.searchParams.set("spaces", "drive");
        url.searchParams.set("orderBy", "modifiedTime desc");
        url.searchParams.set("pageSize", "1");
        url.searchParams.set(
            "fields",
            "files(id,name,parents,modifiedTime,version,appProperties)",
        );

        const response = await driveRequest(url.href);
        const result = await response.json();

        return result.files?.[0] || null;
    };
    const file = await findFile(folderQuery) || await findFile(globalQuery);

    if (file?.id) {
        cachedBackupFileIds.set(cacheKey, file.id);
    }

    return file;
}

async function getFileLocation(fileId) {
    const url = new URL(`${GOOGLE_DRIVE_API_URL}/files/${encodeURIComponent(fileId)}`);

    url.searchParams.set(
        "fields",
        "id,name,parents,webViewLink,modifiedTime,trashed,version,size,md5Checksum,sha256Checksum,appProperties",
    );

    const response = await driveRequest(url.href);
    const file = await response.json();

    if (!file.id) {
        throw new GoogleDriveError(
            "backup_location_unavailable",
            "Google Drive did not return the backup location",
        );
    }

    if (file.trashed) {
        throw new GoogleDriveError(
            "drive_file_trashed",
            "The Google Drive file is in the trash",
        );
    }

    return {
        ...file,
        parents: Array.isArray(file.parents) ? file.parents : [],
    };
}

async function ensureFileInFolder(file, folderId) {
    let verifiedFile = await getFileLocation(file.id);
    const currentParents = verifiedFile.parents;

    if (currentParents.includes(folderId)) {
        return { ...file, ...verifiedFile, locationVerified: true };
    }

    const url = new URL(
        `${GOOGLE_DRIVE_API_URL}/files/${encodeURIComponent(file.id)}`,
    );

    url.searchParams.set("addParents", folderId);

    if (currentParents.length > 0) {
        url.searchParams.set("removeParents", currentParents.join(","));
    }

    url.searchParams.set(
        "fields",
        "id,name,webViewLink,createdTime,modifiedTime,parents",
    );

    const response = await driveRequest(url.href, {
        method: "PATCH",
        headers: {
            "Content-Type": "application/json; charset=UTF-8",
        },
        body: "{}",
    });
    await response.json();
    verifiedFile = await getFileLocation(file.id);

    if (!verifiedFile.parents.includes(folderId)) {
        throw new GoogleDriveError(
            "backup_folder_mismatch",
            "Google Drive did not place the backup in the selected folder",
        );
    }

    return { ...file, ...verifiedFile, locationVerified: true };
}

async function listAllGoogleDriveBackupFiles() {
    const files = [];
    let pageToken = "";

    do {
        const query = [
            "appProperties has { key='chatVaultBackup' and value='true' }",
            "trashed=false",
        ].join(" and ");
        const url = new URL(`${GOOGLE_DRIVE_API_URL}/files`);

        url.searchParams.set("q", query);
        url.searchParams.set("spaces", "drive");
        url.searchParams.set("orderBy", "modifiedTime desc");
        url.searchParams.set("pageSize", "100");
        url.searchParams.set(
            "fields",
            "nextPageToken,files(id,name,parents,appProperties)",
        );

        if (pageToken) {
            url.searchParams.set("pageToken", pageToken);
        }

        const response = await driveRequest(url.href);
        const result = await response.json();

        if (Array.isArray(result.files)) {
            files.push(...result.files);
        }

        pageToken = String(result.nextPageToken || "");
    } while (pageToken);

    return files;
}

export async function organizeGoogleDriveBackups() {
    const folder = await ensureGoogleDriveFolder();
    const files = await listAllGoogleDriveBackupFiles();
    let movedCount = 0;

    for (const file of files) {
        const parents = Array.isArray(file.parents) ? file.parents : [];

        if (!parents.includes(folder.id)) {
            await ensureFileInFolder(file, folder.id);
            movedCount += 1;
        }

        const backupKey = String(file.appProperties?.chatVaultBackupKey || "");
        const cacheKey = `${folder.id}:${backupKey}`;

        if (backupKey && !cachedBackupFileIds.has(cacheKey)) {
            cachedBackupFileIds.set(cacheKey, file.id);
        }
    }

    const result = {
        folder,
        movedCount,
        totalCount: files.length,
    };

    lastOrganizationResult = result;
    lastOrganizationAt = Date.now();
    return result;
}

async function getRecentGoogleDriveOrganization(folderId) {
    if (
        lastOrganizationResult?.folder?.id === folderId
        && Date.now() - lastOrganizationAt < DRIVE_ORGANIZATION_CACHE_MS
    ) {
        return lastOrganizationResult;
    }

    return await organizeGoogleDriveBackups();
}

function createMultipartBody(metadata, content, boundary) {
    return new Blob([
        `--${boundary}\r\n`,
        "Content-Type: application/json; charset=UTF-8\r\n\r\n",
        JSON.stringify(metadata),
        `\r\n--${boundary}\r\n`,
        `Content-Type: ${metadata.mimeType || "application/x-ndjson"}; charset=UTF-8\r\n\r\n`,
        content,
        `\r\n--${boundary}--`,
    ], {
        type: `multipart/related; boundary=${boundary}`,
    });
}

export async function uploadBackupToGoogleDrive(backup, allowRecreate = true) {
    const drivePayload = backup?.drivePayload || backup;

    if (!drivePayload?.content) {
        throw new GoogleDriveError(
            "backup_missing",
            "Backup content is empty",
        );
    }

    const folderId = await getChatVaultFolderId();
    const backupKey = await createBackupKey(backup);
    const contentHash = await createContentHash(drivePayload.content);
    const entityKey = await createEntityKey(backup);
    let uploadBackupKey = backupKey;
    let cacheKey = `${folderId}:${uploadBackupKey}`;
    let existingFile = await findBackupFile(folderId, uploadBackupKey);
    let existingFileId = existingFile?.id || null;
    let fileName = createLatestFileName({ ...backup, ...drivePayload });
    let conflictPreserved = false;
    const existingSavedAt = readTimestamp(
        existingFile?.appProperties?.chatVaultSavedAt,
    );
    const incomingSavedAt = readTimestamp(backup.savedAt);

    if (
        existingFileId
        && existingFile.appProperties?.chatVaultContentHash === contentHash
        && existingSavedAt !== null
        && incomingSavedAt !== null
        && existingSavedAt >= incomingSavedAt
    ) {
        const file = await ensureFileInFolder(existingFile, folderId);
        const organization = await getRecentGoogleDriveOrganization(folderId);

        return {
            ...file,
            wasUpdated: false,
            duplicateSkipped: true,
            contentVerified: true,
            folderId,
            folderWebViewLink: `https://drive.google.com/drive/folders/${encodeURIComponent(folderId)}`,
            organizedMovedCount: organization.movedCount,
            folderBackupCount: Math.max(organization.totalCount, 1),
        };
    }

    if (existingFileId && isIncomingBackupStale(existingFile, backup)) {
        uploadBackupKey = await createOpaqueKey(
            `${backup.id}:conflict:${backup.snapshotId || backup.savedAt || contentHash}`,
        );
        cacheKey = `${folderId}:${uploadBackupKey}`;
        existingFile = await findBackupFile(folderId, uploadBackupKey);
        existingFileId = existingFile?.id || null;
        fileName = createConflictFileName(fileName, backup.savedAt);
        conflictPreserved = true;
    }

    const boundary = `chat_vault_${globalThis.crypto?.randomUUID?.()
        || `${Date.now()}_${Math.random().toString(36).slice(2)}`}`;
    const metadata = {
        name: fileName,
        mimeType: drivePayload.mimeType || "application/x-ndjson",
        appProperties: {
            chatVaultBackup: "true",
            chatVaultBackupKey: uploadBackupKey,
            chatVaultContentHash: contentHash,
            chatVaultSchemaVersion: "2",
        },
    };

    if (backup.savedAt) {
        metadata.appProperties.chatVaultSavedAt = String(backup.savedAt).slice(0, 64);
    }

    if (backup.snapshotId) {
        metadata.appProperties.chatVaultSnapshotId = String(backup.snapshotId).slice(0, 100);
    }

    if (Number.isFinite(Number(backup.messageCount))) {
        metadata.appProperties.chatVaultMessageCount = String(backup.messageCount);
    }

    if (backup.isCheckpoint) {
        metadata.appProperties.chatVaultCheckpoint = "true";
        metadata.appProperties.chatVaultCheckpointName = String(
            backup.checkpointName || "จุดคืนค่า",
        ).slice(0, 100);
    }

    if (backup.triggerReason) {
        metadata.appProperties.chatVaultTriggerReason = String(backup.triggerReason)
            .slice(0, 64);
    }

    if (backup.entityType) {
        metadata.appProperties.chatVaultEntityType = String(backup.entityType).slice(0, 24);
    }

    if (backup.characterName) {
        metadata.appProperties.chatVaultCharacterName = String(backup.characterName)
            .slice(0, 100);
    }

    if (drivePayload.encrypted) {
        metadata.appProperties.chatVaultEncrypted = "true";
    }

    if (Number.isFinite(Number(drivePayload.attachmentCount))) {
        metadata.appProperties.chatVaultAttachmentCount = String(
            drivePayload.attachmentCount,
        );
    }

    if (conflictPreserved) {
        metadata.appProperties.chatVaultConflict = "true";
        metadata.appProperties.chatVaultPrimaryBackupKey = backupKey;
    }

    if (entityKey) {
        metadata.appProperties.chatVaultEntityKey = entityKey;
    }

    if (!existingFileId) {
        metadata.parents = [folderId];
    }

    const body = createMultipartBody(metadata, drivePayload.content, boundary);
    const uploadPath = existingFileId
        ? `/files/${encodeURIComponent(existingFileId)}`
        : "/files";
    const uploadUrl = new URL(`${GOOGLE_DRIVE_UPLOAD_URL}${uploadPath}`);

    uploadUrl.searchParams.set("uploadType", "multipart");
    uploadUrl.searchParams.set(
        "fields",
        "id,name,webViewLink,createdTime,modifiedTime,parents,version,size,md5Checksum,sha256Checksum,appProperties",
    );

    try {
        const response = await driveRequest(uploadUrl.href, {
            method: existingFileId ? "PATCH" : "POST",
            headers: {
                "Content-Type": `multipart/related; boundary=${boundary}`,
            },
            body,
        });
        const uploadedFile = await response.json();

        if (!uploadedFile.id) {
            throw new GoogleDriveError(
                "backup_upload_failed",
                "Google Drive did not return the uploaded backup file ID",
            );
        }

        const file = await ensureFileInFolder(uploadedFile, folderId);

        if (file.appProperties?.chatVaultContentHash !== contentHash) {
            throw new GoogleDriveError(
                "backup_checksum_mismatch",
                "Google Drive backup checksum metadata does not match the upload",
            );
        }

        if (file.id) {
            cachedBackupFileIds.set(cacheKey, file.id);
        }

        const organization = await getRecentGoogleDriveOrganization(folderId);
        const createdFileCount = existingFileId ? 0 : 1;

        return {
            ...file,
            wasUpdated: Boolean(existingFileId),
            conflictPreserved,
            contentVerified: true,
            folderId,
            folderWebViewLink: `https://drive.google.com/drive/folders/${encodeURIComponent(folderId)}`,
            organizedMovedCount: organization.movedCount,
            folderBackupCount: Math.max(
                organization.totalCount + createdFileCount,
                1,
            ),
        };
    } catch (error) {
        cachedBackupFileIds.delete(cacheKey);

        if (
            allowRecreate
            && existingFileId
            && error instanceof GoogleDriveError
            && ["drive_file_not_found", "drive_file_trashed"].includes(error.code)
        ) {
            return await uploadBackupToGoogleDrive(backup, false);
        }

        throw error;
    }
}

export async function listGoogleDriveBackups() {
    const folderId = await getChatVaultFolderId();
    const query = [
        `appProperties has { key='chatVaultBackup' and value='true' }`,
        `'${escapeDriveQueryValue(folderId)}' in parents`,
        "trashed=false",
    ].join(" and ");
    const files = [];
    let pageToken = "";

    do {
        const url = new URL(`${GOOGLE_DRIVE_API_URL}/files`);

        url.searchParams.set("q", query);
        url.searchParams.set("spaces", "drive");
        url.searchParams.set("orderBy", "modifiedTime desc");
        url.searchParams.set("pageSize", "100");
        url.searchParams.set(
            "fields",
            "nextPageToken,files(id,name,modifiedTime,createdTime,size,appProperties)",
        );

        if (pageToken) {
            url.searchParams.set("pageToken", pageToken);
        }

        const response = await driveRequest(url.href);
        const result = await response.json();

        if (Array.isArray(result.files)) {
            files.push(...result.files);
        }

        pageToken = String(result.nextPageToken || "");
    } while (pageToken);

    return files;
}

export async function downloadGoogleDriveBackup(fileId) {
    const normalizedFileId = String(fileId || "").trim();

    if (!normalizedFileId) {
        throw new GoogleDriveError(
            "backup_file_missing",
            "Google Drive backup file ID is missing",
        );
    }

    const file = await getFileLocation(normalizedFileId);
    const expectedContentHash = String(
        file.appProperties?.chatVaultContentHash || "",
    );

    const url = new URL(
        `${GOOGLE_DRIVE_API_URL}/files/${encodeURIComponent(normalizedFileId)}`,
    );

    url.searchParams.set("alt", "media");

    const response = await driveRequest(url.href);
    const content = await response.text();

    if (
        expectedContentHash
        && await createContentHash(content) !== expectedContentHash
    ) {
        throw new GoogleDriveError(
            "backup_checksum_mismatch",
            "Google Drive backup content does not match its checksum",
        );
    }

    return content;
}
