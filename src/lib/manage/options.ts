// Plain-words option lists for campaigns and ad sets, and the Meta API value behind each.
// The app's forms and Claude's list_options tool both read these. Meta checks the final
// combination itself: every plan's first create of each kind is sent with validate_only
// before anything is created (see plan.ts).

export interface Option {
  value: string;
  label: string;
  note?: string;
}

export const OBJECTIVES: Option[] = [
  { value: "OUTCOME_LEADS", label: "Leads" },
  { value: "OUTCOME_SALES", label: "Sales" },
  { value: "OUTCOME_TRAFFIC", label: "Traffic" },
  { value: "OUTCOME_ENGAGEMENT", label: "Engagement" },
  { value: "OUTCOME_AWARENESS", label: "Awareness" },
  { value: "OUTCOME_APP_PROMOTION", label: "App promotion" },
];

export const BID_STRATEGIES: Option[] = [
  { value: "LOWEST_COST_WITHOUT_CAP", label: "Highest volume (no cap)" },
  { value: "COST_CAP", label: "Cost per result goal (cost cap)", note: "needs bid_amount" },
  { value: "LOWEST_COST_WITH_BID_CAP", label: "Bid cap", note: "needs bid_amount" },
  { value: "LOWEST_COST_WITH_MIN_ROAS", label: "ROAS goal", note: "needs roas_average_floor" },
];

export const SPECIAL_AD_CATEGORIES: Option[] = [
  { value: "NONE", label: "None" },
  { value: "HOUSING", label: "Housing" },
  { value: "EMPLOYMENT", label: "Employment" },
  { value: "FINANCIAL_PRODUCTS_SERVICES", label: "Financial products and services" },
  { value: "ISSUES_ELECTIONS_POLITICS", label: "Social issues, elections or politics" },
  { value: "ONLINE_GAMBLING_AND_GAMING", label: "Online gambling and gaming" },
];

/** "Conversion location" in Ads Manager → the ad set's destination_type. */
export const DESTINATIONS: Option[] = [
  { value: "WEBSITE", label: "Website" },
  { value: "APP", label: "App" },
  { value: "WEBSITE_AND_APP", label: "Website and app", note: "Meta may refuse this for some objectives; the plan check shows it" },
  { value: "MESSENGER", label: "Message destination: Messenger" },
  { value: "INSTAGRAM_DIRECT", label: "Message destination: Instagram Direct" },
  { value: "WHATSAPP", label: "Message destination: WhatsApp" },
  { value: "MESSAGING_INSTAGRAM_DIRECT_MESSENGER_WHATSAPP", label: "Message destinations: Messenger, Instagram and WhatsApp" },
  { value: "ON_AD", label: "Instant forms (or 'On your ad' for engagement)" },
  { value: "LEAD_FROM_MESSENGER", label: "Instant forms and Messenger" },
  { value: "PHONE_CALL", label: "Calls" },
  { value: "WEBSITE_AND_PHONE_CALL", label: "Website and calls" },
  { value: "WEBSITE_AND_IN_STORE", label: "Website and in-store", note: "needs an offline event set; the plan check shows if Meta accepts it" },
  { value: "INSTAGRAM_PROFILE_AND_FACEBOOK_PAGE", label: "Facebook / Instagram profile" },
  { value: "ON_POST", label: "On your ad: the post" },
  { value: "ON_VIDEO", label: "On your ad: the video" },
];

/** "Performance goal" → the ad set's optimization_goal. */
export const GOALS: Option[] = [
  { value: "LEAD_GENERATION", label: "Leads" },
  { value: "QUALITY_LEAD", label: "Conversion leads" },
  { value: "OFFSITE_CONVERSIONS", label: "Conversions (website pixel event or app event)" },
  { value: "LANDING_PAGE_VIEWS", label: "Landing page views" },
  { value: "LINK_CLICKS", label: "Link clicks" },
  { value: "CONVERSATIONS", label: "Conversations" },
  { value: "QUALITY_CALL", label: "Calls" },
  { value: "IMPRESSIONS", label: "Impressions" },
  { value: "REACH", label: "Daily unique reach" },
  { value: "POST_ENGAGEMENT", label: "Post engagement" },
  { value: "THRUPLAY", label: "Video views (ThruPlay)" },
  { value: "APP_INSTALLS", label: "App installs" },
  { value: "VALUE", label: "Value" },
];

/** Website pixel standard events → promoted_object.custom_event_type. */
export const PIXEL_EVENTS: Option[] = [
  { value: "LEAD", label: "Lead" },
  { value: "COMPLETE_REGISTRATION", label: "Complete registration" },
  { value: "CONTACT", label: "Contact" },
  { value: "SCHEDULE", label: "Schedule" },
  { value: "SUBMIT_APPLICATION", label: "Submit application" },
  { value: "PURCHASE", label: "Purchase" },
  { value: "ADD_TO_CART", label: "Add to cart" },
  { value: "INITIATED_CHECKOUT", label: "Initiate checkout" },
  { value: "ADD_PAYMENT_INFO", label: "Add payment info" },
  { value: "CONTENT_VIEW", label: "View content" },
  { value: "SEARCH", label: "Search" },
  { value: "START_TRIAL", label: "Start trial" },
  { value: "SUBSCRIBE", label: "Subscribe" },
  { value: "FIND_LOCATION", label: "Find location" },
  { value: "OTHER", label: "Custom event (give custom_event_str)" },
];

export const BILLING_EVENTS: Option[] = [
  { value: "IMPRESSIONS", label: "Impressions (the usual choice)" },
  { value: "LINK_CLICKS", label: "Link clicks" },
  { value: "THRUPLAY", label: "ThruPlay" },
];

export const GENDERS: Option[] = [
  { value: "all", label: "All" },
  { value: "1", label: "Men" },
  { value: "2", label: "Women" },
];

export const PLACEMENT_PLATFORMS: Option[] = [
  { value: "facebook", label: "Facebook" },
  { value: "instagram", label: "Instagram" },
  { value: "messenger", label: "Messenger" },
  { value: "audience_network", label: "Audience Network" },
  { value: "threads", label: "Threads" },
  // WhatsApp Status (checked on 1A with validate_only, 21 Nov 2026: publisher_platforms "whatsapp", whatsapp_positions ["status"]).
  { value: "whatsapp", label: "WhatsApp (Status)" },
];

/** Every platform but Audience Network: "Advantage+ without Audience Network" (Meta picks the positions on these). */
export const NO_AUDIENCE_NETWORK = PLACEMENT_PLATFORMS.map((p) => p.value).filter((v) => v !== "audience_network");

/** Ad set attribution: click and view windows in days. */
export const ATTRIBUTION: Option[] = [
  { value: "7d_click_1d_view", label: "7-day click or 1-day view (Meta's default)" },
  { value: "7d_click", label: "7-day click" },
  { value: "1d_click", label: "1-day click" },
  { value: "1d_click_1d_view", label: "1-day click or 1-day view" },
  { value: "7d_click_1d_view_1d_engaged", label: "7-day click, 1-day view or 1-day engaged view" },
];

export function attributionSpec(v: string): { event_type: string; window_days: number }[] | undefined {
  const out: { event_type: string; window_days: number }[] = [];
  const m = v.match(/(\d+)d_click/);
  if (m) out.push({ event_type: "CLICK_THROUGH", window_days: Number(m[1]) });
  const vw = v.match(/(\d+)d_view/);
  if (vw) out.push({ event_type: "VIEW_THROUGH", window_days: Number(vw[1]) });
  const en = v.match(/(\d+)d_engaged/);
  if (en) out.push({ event_type: "ENGAGED_VIDEO_VIEW", window_days: Number(en[1]) });
  return out.length ? out : undefined;
}

export function label(list: Option[], value: string | undefined | null): string {
  if (!value || value === "UNDEFINED" || value === "NONE") return "";
  return list.find((o) => o.value === value)?.label ?? value.replace(/_/g, " ").toLowerCase();
}

/** Everything at once, for Claude's list_options tool and the app's forms. */
export function allOptions() {
  return {
    objectives: OBJECTIVES,
    bidStrategies: BID_STRATEGIES,
    specialAdCategories: SPECIAL_AD_CATEGORIES,
    destinations: DESTINATIONS,
    goals: GOALS,
    pixelEvents: PIXEL_EVENTS,
    billingEvents: BILLING_EVENTS,
    genders: GENDERS,
    placementPlatforms: PLACEMENT_PLATFORMS,
    attribution: ATTRIBUTION,
  };
}

// ---------- Money ----------

/** Currencies Meta counts in whole units (no cents). Everything else is in 1/100. */
const NO_MINOR_UNIT = new Set(["JPY", "KRW", "VND", "CLP", "COP", "CRC", "HUF", "ISK", "IDR", "PYG", "TWD"]);

export function toMinor(amount: number, currency: string): number {
  return Math.round(amount * (NO_MINOR_UNIT.has(currency.toUpperCase()) ? 1 : 100));
}

export function fromMinor(minor: number | string | null | undefined, currency: string): number | null {
  if (minor === null || minor === undefined || minor === "") return null;
  const n = Number(minor);
  if (!Number.isFinite(n)) return null;
  return NO_MINOR_UNIT.has(currency.toUpperCase()) ? n : n / 100;
}

export function money(amount: number | null | undefined, currency: string): string {
  if (amount === null || amount === undefined) return "";
  const sym = currency.toUpperCase() === "INR" ? "₹" : `${currency.toUpperCase()} `;
  return `${sym}${amount.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
}
