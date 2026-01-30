/**
 * Cryptographic utilities for SimpleSim Edge Functions
 * Implements AES-256-GCM encryption and Shamir's Secret Sharing
 */

// Shamir's Secret Sharing implementation (lightweight, no external deps)
// Based on GF(256) finite field arithmetic

const PRIME = 257; // Smallest prime > 256

/**
 * Modular arithmetic in GF(prime)
 */
function mod(n: number, p: number = PRIME): number {
  return ((n % p) + p) % p;
}

function modInverse(a: number, p: number = PRIME): number {
  let [old_r, r] = [a, p];
  let [old_s, s] = [1, 0];

  while (r !== 0) {
    const quotient = Math.floor(old_r / r);
    [old_r, r] = [r, old_r - quotient * r];
    [old_s, s] = [s, old_s - quotient * s];
  }

  return mod(old_s, p);
}

/**
 * Evaluate polynomial at x using Horner's method
 */
function evaluatePolynomial(coefficients: number[], x: number): number {
  let result = 0;
  for (let i = coefficients.length - 1; i >= 0; i--) {
    result = mod(result * x + coefficients[i]);
  }
  return result;
}

/**
 * Lagrange interpolation to recover secret at x=0
 */
function lagrangeInterpolate(shares: Array<{ x: number; y: number }>): number {
  let secret = 0;

  for (let i = 0; i < shares.length; i++) {
    let numerator = 1;
    let denominator = 1;

    for (let j = 0; j < shares.length; j++) {
      if (i !== j) {
        numerator = mod(numerator * (0 - shares[j].x));
        denominator = mod(denominator * (shares[i].x - shares[j].x));
      }
    }

    const lagrange = mod(numerator * modInverse(denominator));
    secret = mod(secret + shares[i].y * lagrange);
  }

  return secret;
}

/**
 * Split a secret into n shares, requiring k shares to reconstruct
 */
export function splitSecret(
  secret: Uint8Array,
  numShares: number,
  threshold: number
): Uint8Array[] {
  if (threshold > numShares) {
    throw new Error('Threshold cannot exceed number of shares');
  }

  const shares: Uint8Array[] = Array(numShares).fill(null).map(() =>
    new Uint8Array(secret.length + 1) // +1 for x coordinate
  );

  // Process each byte of the secret
  for (let byteIdx = 0; byteIdx < secret.length; byteIdx++) {
    // Generate random polynomial coefficients (secret is constant term)
    const coefficients = [secret[byteIdx]];
    for (let i = 1; i < threshold; i++) {
      coefficients.push(Math.floor(Math.random() * PRIME));
    }

    // Evaluate polynomial at x = 1, 2, 3, ... n
    for (let shareIdx = 0; shareIdx < numShares; shareIdx++) {
      const x = shareIdx + 1;
      shares[shareIdx][0] = x; // Store x coordinate in first byte
      shares[shareIdx][byteIdx + 1] = evaluatePolynomial(coefficients, x);
    }
  }

  return shares;
}

/**
 * Combine shares to reconstruct the secret
 */
export function combineShares(shares: Uint8Array[]): Uint8Array {
  if (shares.length < 2) {
    throw new Error('Need at least 2 shares to reconstruct');
  }

  const secretLength = shares[0].length - 1; // -1 for x coordinate
  const secret = new Uint8Array(secretLength);

  // Reconstruct each byte
  for (let byteIdx = 0; byteIdx < secretLength; byteIdx++) {
    const points = shares.map(share => ({
      x: share[0],
      y: share[byteIdx + 1]
    }));

    secret[byteIdx] = lagrangeInterpolate(points);
  }

  return secret;
}

/**
 * AES-256-GCM encryption
 */
export async function encryptAES(
  data: Uint8Array,
  key: Uint8Array
): Promise<{ ciphertext: Uint8Array; iv: Uint8Array; tag: Uint8Array }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));

  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    key,
    { name: 'AES-GCM' },
    false,
    ['encrypt']
  );

  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    cryptoKey,
    data
  );

  // AES-GCM appends the tag to the ciphertext
  const encryptedArray = new Uint8Array(encrypted);
  const ciphertext = encryptedArray.slice(0, -16);
  const tag = encryptedArray.slice(-16);

  return { ciphertext, iv, tag };
}

/**
 * AES-256-GCM decryption
 */
export async function decryptAES(
  ciphertext: Uint8Array,
  iv: Uint8Array,
  tag: Uint8Array,
  key: Uint8Array
): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    key,
    { name: 'AES-GCM' },
    false,
    ['decrypt']
  );

  // Combine ciphertext and tag for decryption
  const combined = new Uint8Array(ciphertext.length + tag.length);
  combined.set(ciphertext);
  combined.set(tag, ciphertext.length);

  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    cryptoKey,
    combined
  );

  return new Uint8Array(decrypted);
}

/**
 * Derive a key from a password/PIN using PBKDF2
 */
export async function deriveKey(
  password: string,
  salt: Uint8Array,
  iterations: number = 100000
): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const passwordKey = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );

  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt,
      iterations,
      hash: 'SHA-256'
    },
    passwordKey,
    256 // 256 bits = 32 bytes for AES-256
  );

  return new Uint8Array(derivedBits);
}

/**
 * Generate a cryptographically secure random key
 */
export function generateKey(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32));
}

/**
 * Generate a random salt
 */
export function generateSalt(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(16));
}

/**
 * Hash data using SHA-256
 */
export async function sha256(data: Uint8Array | string): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const dataBytes = typeof data === 'string' ? encoder.encode(data) : data;
  const hash = await crypto.subtle.digest('SHA-256', dataBytes);
  return new Uint8Array(hash);
}

/**
 * Encode bytes to base64
 */
export function toBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

/**
 * Decode base64 to bytes
 */
export function fromBase64(base64: string): Uint8Array {
  return Uint8Array.from(atob(base64), c => c.charCodeAt(0));
}

/**
 * Encode bytes to hex
 */
export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Decode hex to bytes
 */
export function fromHex(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return bytes;
}

/**
 * Secure comparison to prevent timing attacks
 */
export function secureCompare(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a[i] ^ b[i];
  }
  return result === 0;
}
