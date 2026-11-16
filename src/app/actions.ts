"use server";

import { signOut } from "@/auth";

/** Sign out of the launcher (Google stays signed in; the next sign-in is one click). */
export async function signOutAction() {
  await signOut({ redirectTo: "/login" });
}
