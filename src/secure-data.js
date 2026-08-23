const COOKIE_NAME = "remember_student_59ba36addc2b2f9401580f014c7f58ea4e30989d";

function bytesToBase64(bytes) {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function base64ToBytes(value) {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function credentialKey(env) {
  if (!env.CREDENTIAL_KEY) throw new Error("Credential encryption is not configured");
  const raw = base64ToBytes(env.CREDENTIAL_KEY);
  if (raw.byteLength !== 32) throw new Error("Credential key must contain 32 bytes");
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

function secretAad(accountId, kind) {
  return new TextEncoder().encode(`autocheck-bjmf:v1:${accountId}:${kind}`);
}

export async function encryptSecret(env, accountId, kind, plaintext) {
  const key = await credentialKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: secretAad(accountId, kind) },
    key,
    new TextEncoder().encode(plaintext),
  );
  return { ciphertext: bytesToBase64(new Uint8Array(ciphertext)), iv: bytesToBase64(iv) };
}

export async function decryptSecret(env, accountId, kind, encrypted) {
  const key = await credentialKey(env);
  const plaintext = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: base64ToBytes(encrypted.iv),
      additionalData: secretAad(accountId, kind),
    },
    key,
    base64ToBytes(encrypted.ciphertext),
  );
  return new TextDecoder().decode(plaintext);
}

export async function saveSecret(env, accountId, kind, plaintext) {
  const encrypted = await encryptSecret(env, accountId, kind, plaintext);
  await env.DB.prepare(
    `INSERT INTO credential_secrets
       (account_id, secret_kind, ciphertext, iv, key_version, updated_at)
     VALUES (?, ?, ?, ?, 1, CURRENT_TIMESTAMP)
     ON CONFLICT(account_id, secret_kind) DO UPDATE SET
       ciphertext = excluded.ciphertext,
       iv = excluded.iv,
       key_version = excluded.key_version,
       updated_at = CURRENT_TIMESTAMP`,
  ).bind(accountId, kind, encrypted.ciphertext, encrypted.iv).run();
}

export async function loadSecret(env, accountId, kind) {
  const encrypted = await env.DB.prepare(
    `SELECT ciphertext, iv FROM credential_secrets
      WHERE account_id = ? AND secret_kind = ?`,
  ).bind(accountId, kind).first();
  if (!encrypted) return null;
  return decryptSecret(env, accountId, kind, encrypted);
}

export function normalizeCookie(rawCookie) {
  return rawCookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${COOKIE_NAME}=`)) ?? null;
}

export function cookieFromBrowserCookies(cookies) {
  const cookie = cookies.find((item) => item.name === COOKIE_NAME && item.value);
  return cookie ? `${cookie.name}=${cookie.value}` : null;
}

export function imageDataUrl(bytes) {
  return `data:image/png;base64,${bytesToBase64(bytes)}`;
}
