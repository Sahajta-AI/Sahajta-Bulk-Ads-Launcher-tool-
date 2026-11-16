import path from "node:path";

// All settings come from the environment. Secrets (tokens, keys) are read here
// and nowhere else, and are never sent to the browser.

function env(name: string, fallback = ""): string {
  return process.env[name] ?? fallback;
}

export const config = {
  get dataDir() {
    return path.resolve(env("DATA_DIR", "data"));
  },
  get dbPath() {
    return path.join(this.dataDir, "launcher.db");
  },
  get filesDir() {
    return path.join(this.dataDir, "files");
  },
  get uploadsDir() {
    return path.join(this.dataDir, "uploads");
  },
  get appUrl() {
    return env("APP_URL", "http://localhost:3000").replace(/\/$/, "");
  },
  get allowedEmails() {
    return env("ALLOWED_EMAILS")
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean);
  },
  get encryptionKey() {
    return env("APP_ENCRYPTION_KEY");
  },
  get metaApiVersion() {
    return env("META_API_VERSION", "v26.0");
  },
  get metaGraphUrl() {
    return env("META_GRAPH_URL", "https://graph.facebook.com");
  },
  /** The launcher's own Meta app (App settings → Basic). Needed for Connect Meta. */
  get metaAppId() {
    return env("META_APP_ID");
  },
  get metaAppSecret() {
    return env("META_APP_SECRET");
  },
  /** Facebook Login for Business configuration ID. Without it, the login asks for the permissions by name. */
  get metaLoginConfigId() {
    return env("META_LOGIN_CONFIG_ID");
  },
  get googleClientId() {
    return env("AUTH_GOOGLE_ID");
  },
  get googleClientSecret() {
    return env("AUTH_GOOGLE_SECRET");
  },
  get backupParUrl() {
    return env("BACKUP_PAR_URL");
  },
  /** When set, every object name gets this prefix (used for real-account tests: "TEST_"). */
  get namePrefix() {
    return env("NAME_PREFIX");
  },
};
