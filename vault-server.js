/*
 * Talking to the Pocky Vault server plugin.
 *
 * The extension can authorize Google in two different ways, and which one is
 * available is not something the user configures — it is a property of the
 * SillyTavern instance the page happens to be served from.
 *
 * Browser-only (always available):
 *   The token client asks Google directly. Google will not issue a refresh token
 *   to a page, so every reload starts with nothing, and re-authorizing needs a
 *   user gesture because the token client can only open a dialog.
 *
 * Server-backed (available when the plugin is installed):
 *   The SillyTavern server holds the refresh token and mints access tokens on
 *   request. No dialog, no gesture, no expiry at the tab's lifetime — the page
 *   simply asks for a token and gets one.
 *
 * This module is the client for the second path and the probe that decides
 * whether it exists. Everything here is deliberately failure-tolerant: an
 * instance without the plugin answers 404 to all of it, and that is a normal,
 * expected answer meaning "use the other path", not an error worth surfacing.
 */

import { getRequestHeaders } from "../../../../script.js";

const PLUGIN_BASE_PATH = "/api/plugins/pocky-vault";

// The probe runs during load, where a hung request would stall the connection UI
// behind a plugin that is probably not there. A local endpoint answers in
// milliseconds or not at all.
const PROBE_TIMEOUT_MS = 4_000;
const TOKEN_TIMEOUT_MS = 15_000;

export class VaultServerError extends Error {
    constructor(code, message) {
        super(message);
        this.name = "VaultServerError";
        this.code = code;
    }
}

/*
 * SillyTavern rejects POSTs without its CSRF token, so writes must carry the
 * headers it builds. GET is unaffected, which is why the probe below can use a
 * bare fetch and the token call cannot.
 */
function postHeaders() {
    try {
        return getRequestHeaders();
    } catch {
        return { "Content-Type": "application/json" };
    }
}

async function fetchWithTimeout(url, options = {}, timeoutMs = TOKEN_TIMEOUT_MS) {
    // AbortController is Safari 12.1, comfortably inside the ADR-0005 baseline.
    const controller = new AbortController();
    const timer = globalThis.setTimeout(() => controller.abort(), timeoutMs);

    try {
        return await fetch(url, { ...options, signal: controller.signal });
    } finally {
        globalThis.clearTimeout(timer);
    }
}

/*
 * Is the plugin there, and does it already hold a grant?
 *
 * Returns null for every kind of "no", including a plugin that is installed but
 * has never been configured. The caller only needs to know whether this path can
 * produce a token right now; distinguishing "absent" from "present but idle"
 * would give it a decision it has nothing to do with.
 */
export async function detectVaultServer() {
    try {
        const response = await fetchWithTimeout(
            `${PLUGIN_BASE_PATH}/status`,
            { method: "GET" },
            PROBE_TIMEOUT_MS,
        );

        if (!response.ok) {
            return null;
        }

        const status = await response.json();

        if (status?.plugin !== "pocky-vault") {
            return null;
        }

        return {
            configured: Boolean(status.configured),
            connected: Boolean(status.connected),
            email: String(status.email || ""),
            redirectUri: String(status.redirectUri || ""),
        };
    } catch {
        // 404, offline, a proxy in the way, a timeout — all mean the same thing
        // to the caller.
        return null;
    }
}

/*
 * Ask the server for a usable access token.
 *
 * 409 is the one response that is not a malfunction: it means the user has to
 * authorize again — either they never did, or the grant is gone. A grant
 * expiring after seven days is the ordinary case for an OAuth consent screen
 * still in Testing, so this has to read as "reconnect", not "something broke".
 */
export async function requestVaultServerToken() {
    let response;

    try {
        response = await fetchWithTimeout(`${PLUGIN_BASE_PATH}/token`, {
            method: "POST",
            headers: postHeaders(),
        });
    } catch (error) {
        throw new VaultServerError("server_unreachable", "Could not reach the Pocky Vault plugin");
    }

    if (response.status === 404) {
        throw new VaultServerError("server_absent", "The Pocky Vault plugin is not installed");
    }

    let payload = {};

    try {
        payload = await response.json();
    } catch {
        payload = {};
    }

    if (response.status === 409) {
        throw new VaultServerError(
            payload.error === "invalid_grant" ? "server_grant_expired" : "server_not_connected",
            payload.message || "The plugin is not connected to Google",
        );
    }

    if (!response.ok || !payload.accessToken) {
        throw new VaultServerError(
            String(payload.error || "server_token_failed"),
            payload.message || "The plugin could not provide a Google token",
        );
    }

    return {
        accessToken: String(payload.accessToken),
        // Trusted from the server, which computed it from Google's own answer,
        // but floored at now so a bad clock cannot mint an eternally valid token.
        expiresAt: Math.max(Date.now(), Number(payload.expiresAt) || 0),
        email: String(payload.email || ""),
    };
}

/*
 * Hand the plugin its Google credentials.
 *
 * This is the step that used to require pasting a fetch() call into the browser
 * console, which was fine for the author and a wall for everyone else. The
 * settings panel calls this instead. The secret only passes through the page on
 * its way to the user's own server — it is never kept in extension settings,
 * which sync into the page and are readable by anything running in it.
 */
export async function configureVaultServer(clientId, clientSecret) {
    let response;

    try {
        response = await fetchWithTimeout(`${PLUGIN_BASE_PATH}/config`, {
            method: "POST",
            headers: postHeaders(),
            body: JSON.stringify({
                clientId: String(clientId || "").trim(),
                clientSecret: String(clientSecret || "").trim(),
            }),
        });
    } catch (error) {
        throw new VaultServerError("server_unreachable", "Could not reach the Pocky Vault plugin");
    }

    if (response.status === 404) {
        throw new VaultServerError("server_absent", "The Pocky Vault plugin is not installed");
    }

    let payload = {};

    try {
        payload = await response.json();
    } catch {
        payload = {};
    }

    if (!response.ok) {
        throw new VaultServerError(
            String(payload.error || "config_failed"),
            payload.message || "The plugin rejected the configuration",
        );
    }

    return { redirectUri: String(payload.redirectUri || "") };
}

// A full-page navigation, because the authorization-code flow returns to the
// server rather than to script. returnTo brings the user back where they were.
export function getVaultServerAuthUrl(returnTo = "/") {
    const target = String(returnTo || "/");

    return `${PLUGIN_BASE_PATH}/auth/start?returnTo=${encodeURIComponent(target)}`;
}

/*
 * Disconnect asks the server to forget the grant and to tell Google to drop it.
 * Backups already on Drive are untouched — Disconnect has always meant "stop
 * using this account here", never "delete what is stored".
 */
export async function disconnectVaultServer() {
    try {
        const response = await fetchWithTimeout(`${PLUGIN_BASE_PATH}/disconnect`, {
            method: "POST",
            headers: postHeaders(),
        });

        return response.ok;
    } catch {
        return false;
    }
}
