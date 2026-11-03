import * as jose from "jose";

const DEV_DEFAULT_SECRET = "polaris-dev-secret-change-in-prod";
const JWT_SECRET = new TextEncoder().encode(process.env.POLARIS_JWT_SECRET ?? DEV_DEFAULT_SECRET);
const JWT_ISSUER = "polaris";
const JWT_EXPIRY = "30d";

// Refuse to run in production with a missing or default JWT secret.
export function assertSecretConfigured(): void {
  const secret = process.env.POLARIS_JWT_SECRET;
  if (process.env.NODE_ENV === "production" && (!secret || secret === DEV_DEFAULT_SECRET)) {
    throw new Error("POLARIS_JWT_SECRET must be set to a non-default value in production");
  }
}

export interface TokenPayload {
  sub: string; // user ID
  email: string;
  name: string;
  org_id: string;
  participant_id: string;
}

export async function createToken(payload: TokenPayload): Promise<string> {
  return new jose.SignJWT({
    email: payload.email,
    name: payload.name,
    org_id: payload.org_id,
    participant_id: payload.participant_id,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setIssuer(JWT_ISSUER)
    .setSubject(payload.sub)
    .setExpirationTime(JWT_EXPIRY)
    .sign(JWT_SECRET);
}

// Renew only tokens that are valid (signature, issuer, not expired) and within this
// window of expiry; returns a fresh full-length token with the same claims.
export const RENEW_WITHIN_MS = 7 * 24 * 60 * 60_000;

export async function renewTokenIfExpiring(token: string): Promise<string | null> {
  try {
    const { payload } = await jose.jwtVerify(token, JWT_SECRET, { issuer: JWT_ISSUER });
    if (typeof payload.exp !== "number" || payload.exp * 1000 - Date.now() > RENEW_WITHIN_MS) return null;
    return await createToken({
      sub: payload.sub!,
      email: payload.email as string,
      name: payload.name as string,
      org_id: payload.org_id as string,
      participant_id: payload.participant_id as string,
    });
  } catch {
    return null;
  }
}

export async function verifyToken(token: string): Promise<TokenPayload | null> {
  try {
    const { payload } = await jose.jwtVerify(token, JWT_SECRET, {
      issuer: JWT_ISSUER,
    });
    return {
      sub: payload.sub!,
      email: payload.email as string,
      name: payload.name as string,
      org_id: payload.org_id as string,
      participant_id: payload.participant_id as string,
    };
  } catch {
    return null;
  }
}
