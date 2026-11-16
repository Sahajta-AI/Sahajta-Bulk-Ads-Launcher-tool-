"use client";

import { usePathname } from "next/navigation";
import { signOutAction } from "./actions";

const LINKS = [
  { href: "/", label: "New batch", on: (p: string) => p === "/" },
  { href: "/history", label: "History", on: (p: string) => p.startsWith("/history") || p.startsWith("/batches") },
  { href: "/settings", label: "Settings", on: (p: string) => p.startsWith("/settings") },
];

export default function Nav({ mock, email }: { mock: boolean; email: string | null }) {
  const path = usePathname() ?? "/";
  if (["/login", "/privacy", "/terms", "/data-deletion"].includes(path)) {
    return (
      <nav className="top">
        <a className="brand" href="/"><span className="logo">S</span>Sahajta Ads Launcher</a>
      </nav>
    );
  }
  return (
    <nav className="top">
      <a className="brand" href="/"><span className="logo">S</span>Sahajta Ads Launcher</a>
      {mock && <span className="mock" title="Nothing is sent to Meta. Set META_MOCK=0 to use the real account.">Practice mode</span>}
      {LINKS.map((l) => (
        <a key={l.href} className={`nav ${l.on(path) ? "on" : ""}`} href={l.href}>{l.label}</a>
      ))}
      {email && (
        <form action={signOutAction} className="account">
          <span className="who" title={email}>{email}</span>
          <button type="submit" className="link" onClick={(e) => { if (!confirm("Sign out of the launcher?")) e.preventDefault(); }}>Sign out</button>
        </form>
      )}
    </nav>
  );
}
