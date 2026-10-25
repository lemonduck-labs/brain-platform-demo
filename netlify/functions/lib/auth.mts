// Sign-in for the platform: passphrase, a guess limit, and an optional passkey
// (WebAuthn) second factor. See System/Security review.md in the vault for the
// decisions this implements (5 wrong guesses locks for 15 minutes; the second
// factor is a passkey, not a TOTP code).
//
// Recovery if the operator loses their passkey device: set BRAIN_PASSKEY_RESET to any
// value in the site's environment variables. While it is set, signing in with
// the passphrase alone is enough again, so they can register a fresh passkey.
// Remove the variable once the new passkey is registered.

import { blobStore } from "./store.mts";
import { isDemo, DEMO_VISIT_MS, endVisit } from "./demo.mts";
import { createHash, timingSafeEqual } from "node:crypto";
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from "@simplewebauthn/server";

declare const Netlify: any;

const PASS = () => Netlify.env.get("BRAIN_PASSPHRASE") || "";
const RESET_ACTIVE = () => Boolean(Netlify.env.get("BRAIN_PASSKEY_RESET"));

// The origin and rpID for a WebAuthn ceremony come from the request itself
// (the Host header Netlify passes through), not a fixed env var, so a custom
// domain works without redeploying. Netlify.env.get("URL") is a fallback only,
// for the unlikely case a request reaches this function with no host at all.
const RP_NAME = "The Brain";
function reqOrigin(req: Request): string {
  const h = req.headers;
  const proto = h.get("x-forwarded-proto") || "https";
  const host = h.get("host") || h.get("x-forwarded-host") || "";
  if (host) return `${proto}://${host}`;
  return (Netlify.env.get("URL") || "http://localhost:8888").replace(/\/$/, "");
}
function reqRpID(req: Request): string {
  try { return new URL(reqOrigin(req)).hostname; } catch { return "localhost"; }
}

// A deploy preview or branch deploy gets its own address, so a passkey
// registered there is a passkey for that address only, not for the live
// site. Netlify sets CONTEXT to "production" for the main branch build and
// "deploy-preview" or "branch-deploy" for anything else; "dev" (netlify dev,
// run only on the operator's own machine) is treated as production-equivalent so
// local testing is not blocked. Found 23 Sep: a passkey registered on
// deploy-preview-1 could not be used on the live address, and the shared
// Blobs store made the live site think a passkey already existed, so the
// passphrase-only fallback never showed either.
function isLiveContext(): boolean {
  const context = Netlify.env.get("CONTEXT") || "";
  return context !== "deploy-preview" && context !== "branch-deploy";
}
export function liveOnlyRefusal(): { error: string } | null {
  if (isDemo() || isLiveContext()) return null;
  const live = (Netlify.env.get("URL") || "the live site").replace(/\/$/, "");
  return { error: `Sign-in and passkeys only work on the live site. Open ${live}.` };
}

const MAX_FAILURES = 5;
const LOCKOUT_MS = 15 * 60 * 1000;
const SESSION_MS = 60 * 24 * 60 * 60 * 1000; // 60 days
const SESSION_EXTEND_GAP_MS = 60 * 60 * 1000; // extend on use, at most once an hour
const CHALLENGE_MS = 5 * 60 * 1000; // 5 minutes to complete a WebAuthn ceremony

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const store = () => blobStore("brain-auth");

type Lockout = { failures: number; lockedUntil: number };
type Credential = {
  id: string; // base64url credential id, also the blob key suffix
  publicKey: string; // base64url
  counter: number;
  transports?: string[];
  label: string;
  createdAt: number;
  rpID: string; // the address this credential was registered for; only a match signs in
};
type Session = { createdAt: number; expiresAt: number; lastExtended: number };

// ---------- guess limit ----------

async function getLockout(): Promise<Lockout> {
  return (await store().get("lockout", { type: "json" })) || { failures: 0, lockedUntil: 0 };
}

export async function lockedUntil(): Promise<number | null> {
  const l = await getLockout();
  return l.lockedUntil && Date.now() < l.lockedUntil ? l.lockedUntil : null;
}

// Returns the lockout time if this failure was the one that tripped it, so the
// guess that caused the lock is itself reported as locked, not as a wrong guess.
async function recordFailure(): Promise<number | null> {
  const l = await getLockout();
  const failures = l.failures + 1;
  if (failures >= MAX_FAILURES) {
    const lockedUntil = Date.now() + LOCKOUT_MS;
    await store().setJSON("lockout", { failures: 0, lockedUntil });
    return lockedUntil;
  }
  await store().setJSON("lockout", { failures, lockedUntil: 0 });
  return null;
}

async function recordSuccess(): Promise<void> {
  await store().setJSON("lockout", { failures: 0, lockedUntil: 0 });
}

// ---------- sessions ----------
// The session token itself is never stored, only its hash, so reading the
// store back cannot hand out a working credential.

function newToken(): string {
  return sha256(`${Date.now()}:${Math.random()}:${Math.random()}`);
}

async function issueSession(): Promise<string> {
  const token = newToken();
  const now = Date.now();
  // A demo session lasts as long as the visit it opens (lib/demo.mts), and is never extended.
  const life = isDemo() ? DEMO_VISIT_MS : SESSION_MS;
  await store().setJSON(`session:${sha256(token)}`, { createdAt: now, expiresAt: now + life, lastExtended: now } as Session);
  return token;
}

// ---------- demo: no passphrase, no passkeys ----------
// In demo mode the gate offers one button, and this hands back a session for a fresh visit.
export async function enterDemo(): Promise<{ ok: true; token: string; demo: true }> {
  if (!isDemo()) throw Object.assign(new Error("not in demo mode"), { status: 404 });
  return { ok: true, token: await issueSession(), demo: true };
}

// A device stays signed in while it is being used: every authorised request
// pushes expiresAt forward by another SESSION_MS, capped to once an hour so
// Blobs is not written on every call. A device left unused for 60 days still
// signs out, and the lock icon still revokes at once regardless of this.
export async function sessionValid(token: string): Promise<boolean> {
  if (!token) return false;
  const key = `session:${sha256(token)}`;
  const s: Session | null = await store().get(key, { type: "json" });
  if (!s) return false;
  const now = Date.now();
  if (now > s.expiresAt) {
    await store().delete(key);
    return false;
  }
  if (!isDemo() && now - (s.lastExtended ?? s.createdAt) >= SESSION_EXTEND_GAP_MS) {
    await store().setJSON(key, { ...s, expiresAt: now + SESSION_MS, lastExtended: now } as Session);
  }
  return true;
}

export async function revokeSession(token: string): Promise<void> {
  if (token) await store().delete(`session:${sha256(token)}`);
  if (token && isDemo()) endVisit(token);
}

// ---------- passphrase ----------

function passphraseMatches(givenHash: string): boolean {
  const pass = PASS();
  if (!pass || !givenHash) return false;
  const want = sha256(pass);
  if (givenHash.length !== want.length) return false;
  return timingSafeEqual(Buffer.from(givenHash, "utf8"), Buffer.from(want, "utf8"));
}

// ---------- passkey credentials ----------

async function getCredentials(): Promise<Credential[]> {
  return (await store().get("credentials", { type: "json" })) || [];
}

async function saveCredentials(cs: Credential[]): Promise<void> {
  await store().setJSON("credentials", cs);
}

// Credentials from an older build (before rpID was tracked), or registered
// under a different address, do not count towards "a passkey exists" here:
// a stray preview credential must not lock the live site into asking for a
// passkey it can never receive.
async function liveCredentials(req: Request): Promise<Credential[]> {
  const rpID = reqRpID(req);
  return (await getCredentials()).filter((c) => c.rpID === rpID);
}

// ---------- step 1: passphrase ----------

export type PassphraseResult =
  | { ok: false; locked: true; lockedUntil: number }
  | { ok: false; locked: false }
  | { ok: true; token: string; needsPasskeySetup: boolean }
  | { ok: true; requireWebauthn: true; options: any };

export async function checkPassphrase(req: Request, givenHash: string): Promise<PassphraseResult> {
  const until = await lockedUntil();
  if (until) return { ok: false, locked: true, lockedUntil: until };

  if (!passphraseMatches(givenHash)) {
    const justLocked = await recordFailure();
    return justLocked ? { ok: false, locked: true, lockedUntil: justLocked } : { ok: false, locked: false };
  }
  await recordSuccess();

  const creds = await liveCredentials(req);
  if (creds.length === 0 || RESET_ACTIVE()) {
    const token = await issueSession();
    return { ok: true, token, needsPasskeySetup: creds.length === 0 };
  }

  const options = await generateAuthenticationOptions({
    rpID: reqRpID(req),
    userVerification: "preferred",
    allowCredentials: creds.map((c) => ({ id: c.id, transports: c.transports as any })),
  });
  await store().setJSON("login-challenge", { challenge: options.challenge, at: Date.now() });
  return { ok: true, requireWebauthn: true, options };
}

// ---------- step 2: passkey login ----------

export async function verifyLogin(req: Request, response: any): Promise<{ ok: true; token: string } | { ok: false; error: string }> {
  const until = await lockedUntil();
  if (until) return { ok: false, error: "locked" };

  const pending: { challenge: string; at: number } | null = await store().get("login-challenge", { type: "json" });
  if (!pending || Date.now() - pending.at > CHALLENGE_MS) return { ok: false, error: "The passkey prompt expired. Try again." };

  const creds = await liveCredentials(req);
  const cred = creds.find((c) => c.id === response?.id);
  if (!cred) return { ok: false, error: "Unknown passkey." };

  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: pending.challenge,
      expectedOrigin: reqOrigin(req),
      expectedRPID: reqRpID(req),
      credential: { id: cred.id, publicKey: Buffer.from(cred.publicKey, "base64url"), counter: cred.counter, transports: cred.transports as any },
    });
  } catch (e: any) {
    const justLocked = await recordFailure();
    return { ok: false, error: justLocked ? "locked" : e.message || "Passkey check failed." };
  }
  if (!verification.verified) {
    const justLocked = await recordFailure();
    return { ok: false, error: justLocked ? "locked" : "Passkey check failed." };
  }

  await store().delete("login-challenge");
  await recordSuccess();
  cred.counter = verification.authenticationInfo.newCounter;
  const all = await getCredentials();
  await saveCredentials(all.map((c) => (c.id === cred.id ? cred : c)));
  const token = await issueSession();
  return { ok: true, token };
}

// ---------- passkey enrolment (must already hold a valid session) ----------

export async function registrationOptions(req: Request): Promise<any> {
  const creds = await getCredentials();
  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: reqRpID(req),
    userName: "operator",
    userDisplayName: "Operator",
    attestationType: "none",
    authenticatorSelection: { residentKey: "preferred", userVerification: "preferred" },
    excludeCredentials: creds.map((c) => ({ id: c.id, transports: c.transports as any })),
  });
  await store().setJSON("reg-challenge", { challenge: options.challenge, at: Date.now() });
  return options;
}

export async function verifyRegistration(req: Request, response: any, label: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const pending: { challenge: string; at: number } | null = await store().get("reg-challenge", { type: "json" });
  if (!pending || Date.now() - pending.at > CHALLENGE_MS) return { ok: false, error: "The passkey prompt expired. Try again." };

  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response,
      expectedChallenge: pending.challenge,
      expectedOrigin: reqOrigin(req),
      expectedRPID: reqRpID(req),
    });
  } catch (e: any) {
    return { ok: false, error: e.message || "Could not register that passkey." };
  }
  if (!verification.verified || !verification.registrationInfo) return { ok: false, error: "Could not register that passkey." };

  await store().delete("reg-challenge");
  const { credential } = verification.registrationInfo;
  const creds = await getCredentials();
  creds.push({
    id: credential.id,
    publicKey: Buffer.from(credential.publicKey).toString("base64url"),
    counter: credential.counter,
    transports: response?.response?.transports || [],
    label: label || "Passkey",
    createdAt: Date.now(),
    rpID: reqRpID(req),
  });
  await saveCredentials(creds);
  return { ok: true };
}

export async function listPasskeys(): Promise<{ label: string; createdAt: number }[]> {
  return (await getCredentials()).map((c) => ({ label: c.label, createdAt: c.createdAt }));
}

export async function removePasskey(label: string): Promise<void> {
  const creds = await getCredentials();
  await saveCredentials(creds.filter((c) => c.label !== label));
}
