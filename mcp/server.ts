// Claude Desktop extension entry point (stdio). Settings come from the extension's form:
// ADS_LAUNCHER_URL and ADS_LAUNCHER_API_KEY. The Meta token never leaves the server.
//
// The extension holds no tools of its own: it passes Claude's requests to the launcher's own MCP
// endpoint (/api/mcp) and returns the answers. So when the launcher gets new or changed tools,
// Claude sees them after a restart of Claude Desktop, without installing the extension again
// (17 Nov 2026: the 21 new tools only appeared after a re-install).
// If the launcher can't be reached, it falls back to the tools bundled at build time.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { httpApi, registerTools } from "../src/mcp/tools";
import { EXTENSION_VERSION } from "./version";

const base = (process.env.ADS_LAUNCHER_URL || "https://launcher.sahajta.com").replace(/\/$/, "");
const key = process.env.ADS_LAUNCHER_API_KEY || "";

let remote: Client | null = null;
async function launcher(): Promise<Client> {
  if (remote) return remote;
  const c = new Client({ name: "sahajta-ads-extension", version: EXTENSION_VERSION });
  await c.connect(
    new StreamableHTTPClientTransport(new URL(`${base}/api/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${key}`, "X-Extension-Version": EXTENSION_VERSION } },
    }),
  );
  remote = c;
  return c;
}

// The bundled tools, reached through an in-memory client: used only when the launcher can't be reached.
const bundled = new McpServer({ name: "sahajta-ads-bundled", version: EXTENSION_VERSION });
registerTools(bundled, httpApi(base, key));
const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
await bundled.connect(serverSide);
const fallback = new Client({ name: "sahajta-ads-fallback", version: EXTENSION_VERSION });
await fallback.connect(clientSide);

const server = new Server({ name: "sahajta-ads", version: EXTENSION_VERSION }, { capabilities: { tools: { listChanged: true } } });

server.setRequestHandler(ListToolsRequestSchema, async (req) => {
  if (!key) return fallback.listTools(req.params);
  try {
    return await (await launcher()).listTools(req.params);
  } catch {
    remote = null;
    return fallback.listTools(req.params);
  }
});

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (!key) return { content: [{ type: "text", text: "No API key set. Create one in the launcher under Settings → Claude connection, then paste it in this extension's settings." }], isError: true };
  try {
    return await (await launcher()).callTool(req.params, undefined, { timeout: 300_000 });
  } catch (e) {
    remote = null;
    // A connection problem: try the bundled tool once (it calls the same launcher API).
    try {
      return await fallback.callTool(req.params, undefined, { timeout: 300_000 });
    } catch {
      return { content: [{ type: "text", text: `Couldn't reach the launcher at ${base} (${e instanceof Error ? e.message : String(e)}).` }], isError: true };
    }
  }
});

await server.connect(new StdioServerTransport());
