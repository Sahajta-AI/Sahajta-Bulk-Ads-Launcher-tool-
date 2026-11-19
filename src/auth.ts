import NextAuth from "next-auth";
import Google from "next-auth/providers/google";
import { config } from "@/lib/config";
import { encrypt } from "@/lib/crypto";
import { db } from "@/lib/db";

// Google sign-in. Only emails in ALLOWED_EMAILS get in.
// The same sign-in grants read-only Drive access; the refresh token is stored encrypted
// in the database (never in the browser cookie) so the worker can download files later.

export const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.readonly";

// Behind Caddy, Next.js sees every request as "localhost:3000", so Auth.js would send people
// back to https://localhost:3000 after Google. AUTH_URL makes it use the public address.
process.env.AUTH_URL ??= config.appUrl;

export const { handlers, auth, signIn, signOut } = NextAuth({
  trustHost: true,
  session: { strategy: "jwt", maxAge: 30 * 24 * 3600 },
  pages: { signIn: "/login", error: "/login" },
  providers: [
    Google({
      authorization: {
        params: { scope: `openid email profile ${DRIVE_SCOPE} https://www.googleapis.com/auth/gmail.send`, access_type: "offline", prompt: "consent", include_granted_scopes: "true" },
      },
    }),
  ],
  callbacks: {
    signIn({ profile }) {
      const email = profile?.email?.toLowerCase();
      return !!email && profile?.email_verified !== false && config.allowedEmails.includes(email);
    },
    jwt({ token, account, profile }) {
      if (account && profile?.email) {
        const email = profile.email.toLowerCase();
        db().prepare(
          `INSERT INTO users (email, name, google_refresh_enc, google_scope, last_login_at) VALUES (?, ?, ?, ?, datetime('now'))
           ON CONFLICT(email) DO UPDATE SET name = excluded.name, last_login_at = excluded.last_login_at,
             google_refresh_enc = COALESCE(excluded.google_refresh_enc, users.google_refresh_enc), google_scope = COALESCE(excluded.google_scope, users.google_scope)`,
        ).run(email, profile.name ?? "", account.refresh_token ? encrypt(account.refresh_token) : null, account.scope ?? null);
        // Only who you are goes in the cookie; no Google tokens.
        return { email, name: profile.name ?? email };
      }
      return token;
    },
    session({ session, token }) {
      if (session.user && token.email) session.user.email = token.email;
      return session;
    },
  },
});
