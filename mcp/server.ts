// Claude Desktop extension entry point (stdio). Settings come from the extension's form:
// ADS_LAUNCHER_URL and ADS_LAUNCHER_API_KEY. The Meta token never leaves the server.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { httpApi, registerTools } from "../src/mcp/tools";

const server = new McpServer({ name: "sahajta-ads", version: "0.2.0" });
registerTools(server, httpApi(process.env.ADS_LAUNCHER_URL || "https://launcher.sahajta.com", process.env.ADS_LAUNCHER_API_KEY || ""));
await server.connect(new StdioServerTransport());
