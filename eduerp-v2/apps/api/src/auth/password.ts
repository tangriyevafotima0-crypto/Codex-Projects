import * as crypto from 'node:crypto';
import { SYNTHETIC_DIRECTOR_SCRYPT_HASH } from '../database/seed-contract';

/**
 * EduERP v2.0 — OWASP-Compliant Asynchronous `crypto.scrypt` Password Hashing (05.01).
 *
 * Security invariants:
 * - Uses Node's built-in asynchronous `crypto.scrypt` with server-controlled parameters.
 * - Default cost: N = 131072 (2^17), r = 8, p = 1, keylen = 64, maxmem = 256 MiB, 16-byte random salt.
 * - Versioned envelope: `$scrypt$v=1$n=<N>,r=<r>,p=<p>$<salt_b64url>$<derived_b64url>`.
 * - Strict parameter verification prevents attacker-supplied hash strings from exhausting memory or CPU.
 * - Bounded concurrency queue (`MAX_CONCURRENT_HASHES = 8`) protects the event loop under login floods.
 * - Constant-time comparison via `crypto.timingSafeEqual` and `DUMMY_SCRYPT_HASH` fallback against enumeration.
 */

export const DEFAULT_SCRYPT_N = 131072; // 2^17
export const MIN_ALLOWED_SCRYPT_N = 16384; // 2^14 (allowed for test fixtures)
export const MAX_ALLOWED_SCRYPT_N = 131072; // 2^17
export const DEFAULT_SCRYPT_R = 8;
export const DEFAULT_SCRYPT_P = 1;
export const SCRYPT_KEYLEN = 64;
export const SCRYPT_SALT_BYTES = 16;
export const SCRYPT_MAXMEM = 256 * 1024 * 1024; // 256 MiB

const MAX_CONCURRENT_HASHES = 8;
const MAX_QUEUE_DEPTH = 64;

const SCRYPT_ENVELOPE_REGEX =
  /^\$scrypt\$v=1\$n=([0-9]{4,7}),r=([0-9]{1,2}),p=([0-9]{1,2})\$([A-Za-z0-9_-]{22,88})\$([A-Za-z0-9_-]{86})$/;

export const DUMMY_SCRYPT_HASH = SYNTHETIC_DIRECTOR_SCRYPT_HASH;

export interface ScryptCostOptions {
  readonly N?: number;
  readonly r?: number;
  readonly p?: number;
}

let activeOperations = 0;
const waitQueue: Array<{ resolve: () => void; reject: (err: Error) => void }> = [];

async function acquireHashSlot(): Promise<void> {
  if (activeOperations < MAX_CONCURRENT_HASHES) {
    activeOperations += 1;
    return;
  }
  if (waitQueue.length >= MAX_QUEUE_DEPTH) {
    throw new Error('Password hashing concurrency queue limit exceeded');
  }
  await new Promise<void>((resolve, reject) => {
    waitQueue.push({ resolve, reject });
  });
  activeOperations += 1;
}

function releaseHashSlot(): void {
  activeOperations = Math.max(0, activeOperations - 1);
  const next = waitQueue.shift();
  if (next) {
    next.resolve();
  }
}

export function isValidScryptParams(N: number, r: number, p: number): boolean {
  if (!Number.isInteger(N) || N < MIN_ALLOWED_SCRYPT_N || N > MAX_ALLOWED_SCRYPT_N) {
    return false;
  }
  // N must be a power of two
  if ((N & (N - 1)) !== 0) {
    return false;
  }
  if (!Number.isInteger(r) || r < 1 || r > 16) {
    return false;
  }
  if (!Number.isInteger(p) || p < 1 || p > 4) {
    return false;
  }
  const estimatedMem = 128 * N * r * p;
  if (estimatedMem > SCRYPT_MAXMEM) {
    return false;
  }
  return true;
}

function scryptAsync(
  password: string,
  salt: Buffer,
  keylen: number,
  options: crypto.ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, keylen, options, (err, derivedKey) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(derivedKey);
    });
  });
}

export async function hashPassword(
  plainPassword: string,
  cost: ScryptCostOptions = {},
): Promise<string> {
  if (typeof plainPassword !== 'string' || plainPassword.length < 8 || plainPassword.length > 128) {
    throw new Error('Password must be between 8 and 128 characters');
  }
  if (Buffer.byteLength(plainPassword, 'utf8') > 512) {
    throw new Error('Password UTF-8 byte length exceeds maximum allowed bound');
  }

  const N = cost.N ?? DEFAULT_SCRYPT_N;
  const r = cost.r ?? DEFAULT_SCRYPT_R;
  const p = cost.p ?? DEFAULT_SCRYPT_P;
  if (!isValidScryptParams(N, r, p)) {
    throw new Error('Invalid or out-of-bounds scrypt cost parameters');
  }

  const salt = crypto.randomBytes(SCRYPT_SALT_BYTES);
  await acquireHashSlot();
  try {
    const derived = await scryptAsync(plainPassword, salt, SCRYPT_KEYLEN, {
      N,
      r,
      p,
      maxmem: SCRYPT_MAXMEM,
    });
    return `$scrypt$v=1$n=${N},r=${r},p=${p}$${salt.toString('base64url')}$${derived.toString('base64url')}`;
  } finally {
    releaseHashSlot();
  }
}

export async function verifyPassword(
  plainPassword: string,
  storedHash: string,
): Promise<boolean> {
  if (
    typeof plainPassword !== 'string' ||
    plainPassword.length < 1 ||
    plainPassword.length > 256 ||
    Buffer.byteLength(plainPassword, 'utf8') > 512 ||
    typeof storedHash !== 'string'
  ) {
    return false;
  }

  const match = SCRYPT_ENVELOPE_REGEX.exec(storedHash);
  if (!match) {
    return false;
  }

  const N = Number(match[1]);
  const r = Number(match[2]);
  const p = Number(match[3]);
  if (!isValidScryptParams(N, r, p)) {
    return false;
  }

  let salt: Buffer;
  let expectedKey: Buffer;
  try {
    salt = Buffer.from(match[4], 'base64url');
    expectedKey = Buffer.from(match[5], 'base64url');
  } catch {
    return false;
  }

  if (salt.length < 16 || salt.length > 64 || expectedKey.length !== SCRYPT_KEYLEN) {
    return false;
  }

  await acquireHashSlot();
  try {
    const actualKey = await scryptAsync(plainPassword, salt, SCRYPT_KEYLEN, {
      N,
      r,
      p,
      maxmem: SCRYPT_MAXMEM,
    });
    if (actualKey.length !== expectedKey.length) {
      return false;
    }
    return crypto.timingSafeEqual(actualKey, expectedKey);
  } catch {
    return false;
  } finally {
    releaseHashSlot();
  }
}

export async function verifyPasswordConstantTime(
  plainPassword: string,
  storedHash: string | null | undefined,
): Promise<boolean> {
  const safeCandidate =
    typeof storedHash === 'string' && SCRYPT_ENVELOPE_REGEX.test(storedHash)
      ? storedHash
      : DUMMY_SCRYPT_HASH;
  const matched = await verifyPassword(plainPassword, safeCandidate);
  if (!storedHash || safeCandidate !== storedHash) {
    return false;
  }
  return matched;
}
