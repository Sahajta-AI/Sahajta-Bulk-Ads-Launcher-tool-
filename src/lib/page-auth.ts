import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { config } from "./config";

/** For server-rendered pages: the signed-in, allowed email, or a redirect to /login. */
export async function requirePageUser(): Promise<string> {
  const dev = process.env.DEV_LOGIN_EMAIL;
  if (dev && process.env.NODE_ENV === "development") return dev.toLowerCase();
  const session = await auth();
  const email = session?.user?.email?.toLowerCase();
  if (!email || !config.allowedEmails.includes(email)) redirect("/login");
  return email;
}
