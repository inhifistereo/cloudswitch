import { NextResponse } from "next/server";

/**
 * Same-origin enforcement for the API routes.
 *
 * Next.js applies no CSRF protection to Route Handlers — the Origin/Host check it
 * documents covers Server Actions only. Without this guard, any page the user visits
 * can POST to the start/stop endpoints: a bare `fetch(url, { method: "POST" })` sends
 * no custom headers, so it is a CORS "simple request" and is delivered cross-origin
 * without a preflight. The attacker never reads the response; the side effect is the
 * whole attack.
 *
 * Binding to 127.0.0.1 does not help here — the browser is already on loopback. Nor
 * does platform authentication (e.g. App Service Easy Auth), which is cookie-based
 * and therefore rides along on a forged cross-site request.
 */

const LOOPBACK_HOSTS = ["127.0.0.1", "localhost", "::1"];

/**
 * Hosts this app expects to be reached on. Defaults to loopback; a hosted deployment
 * must set ALLOWED_HOSTS to its public hostname(s). Failing closed is deliberate — an
 * unset value on a public host returns 403 rather than silently accepting any Host.
 */
function parseAllowedHosts(): string[] {
  const raw = process.env.ALLOWED_HOSTS?.trim();
  if (!raw) return LOOPBACK_HOSTS;
  return raw
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter((h) => h.length > 0);
}

/** Normalizes a full URL, an "host:port" authority, or a bare host down to its hostname. */
function hostnameOf(value: string): string | null {
  try {
    const url = value.includes("://") ? new URL(value) : new URL(`http://${value}`);
    // URL keeps IPv6 literals bracketed; the allowlist stores them bare.
    return url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  } catch {
    return null;
  }
}

function deny(message: string): NextResponse {
  return NextResponse.json({ ok: false, message }, { status: 403 });
}

/**
 * Returns a 403 response if the request is not same-origin, or null if it may proceed.
 * Call this first in every route handler that reads or mutates machine state.
 */
export function rejectCrossOrigin(request: Request): NextResponse | null {
  // DNS-rebinding guard. The Host header is the attacker-controlled value in a
  // rebinding attack (their domain resolves to 127.0.0.1, and the browser then sends
  // Host: attacker.example.com with a self-consistent Origin and Sec-Fetch-Site:
  // same-origin). It must therefore be what we validate — `request.url` reflects the
  // address the server is bound to, not the name the client asked for, so checking it
  // instead would let a rebound request through.
  const hostHeader = request.headers.get("host");
  const targetHostname = hostnameOf(hostHeader ?? request.url);

  if (!targetHostname || !parseAllowedHosts().includes(targetHostname)) {
    return deny("Request host is not allowed.");
  }

  // Sec-Fetch-Site is a forbidden header name, so page JavaScript cannot spoof it.
  const site = request.headers.get("sec-fetch-site");
  if (site) {
    return site === "same-origin" ? null : deny("Cross-origin request rejected.");
  }

  // Fallback for clients that omit Sec-Fetch-Site.
  const origin = request.headers.get("origin");
  if (origin) {
    return hostnameOf(origin) === targetHostname ? null : deny("Cross-origin request rejected.");
  }

  return deny("Request is missing origin information.");
}
