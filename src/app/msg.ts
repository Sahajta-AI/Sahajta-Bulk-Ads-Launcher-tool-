// Which box a message from the server goes in (pure: used by every page, unit tested).

/** "Meta is limiting…" means wait a little, not that something broke: it is shown as a warning. */
export function isMetaLimit(text: string | null | undefined): boolean {
  return !!text && /^\s*(Meta is limiting|This took too long)/.test(text);
}

/** Class for a message box: amber for "Meta is limiting…", red for every other error. */
export function msgClass(text: string | null | undefined): string {
  return isMetaLimit(text) ? "msg warning" : "msg error";
}
