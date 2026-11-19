import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { caller } from "@/lib/http";
import { sha256 } from "@/lib/crypto";
import { cacheSet } from "@/lib/store";
import { httpApi, registerTools } from "@/mcp/tools";
import { EXTENSION_VERSION } from "../../../../mcp/version";

export const dynamic = "force-dynamic";

// The launcher's MCP tools over HTTP, for Claude Code:
//   claude mcp add --transport http sahajta-ads https://launcher.sahajta.com/api/mcp --header "Authorization: Bearer <key>"
// Stateless: a fresh server per request. The tools call this app's own API with the same key.

const PORT = process.env.PORT ?? "3000";

async function handle(req: Request) {
  try {
    const who = await caller(req);
    if (who.via !== "api_key") throw new Error("Use an API key");
  } catch {
    return Response.json({ error: "Send an API key: Authorization: Bearer <key>. Create one in Settings → Claude connection." }, { status: 401 });
  }
  const key = req.headers.get("authorization")!.slice(7).trim();
  // Which Claude Desktop extension version is calling (Settings → Claude shows it).
  const ext = req.headers.get("x-extension-version");
  if (ext) cacheSet(`ext_version:${sha256(key).slice(0, 16)}`, { version: ext, at: new Date().toISOString() }, 90 * 86_400_000);
  // The same version as the Claude Desktop extension (mcp/version.ts), so both report one number.
  const server = new McpServer({ name: "sahajta-ads", version: EXTENSION_VERSION });
  registerTools(server, httpApi(`http://127.0.0.1:${PORT}`, key));
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  return transport.handleRequest(req);
}

export const GET = handle;
export const POST = handle;
export const DELETE = handle;
