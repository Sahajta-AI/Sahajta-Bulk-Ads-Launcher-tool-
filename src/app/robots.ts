import type { MetadataRoute } from "next";

// Meta checks the privacy, terms and data-deletion pages before the app can go Live,
// and its checker reads robots.txt first. Those three pages are public; the rest of the
// launcher is behind sign-in and has nothing for search engines.
export default function robots(): MetadataRoute.Robots {
  const legal = ["/privacy", "/terms", "/data-deletion"];
  return {
    rules: [
      { userAgent: ["facebookexternalhit", "Facebot", "meta-externalagent"], allow: legal },
      { userAgent: "*", allow: legal, disallow: "/" },
    ],
  };
}
