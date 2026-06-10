/**
 * Minimal client for the hosted Casper MCP server (CSPR.cloud).
 *
 * Connects to https://mcp.testnet.cspr.cloud/mcp (Streamable HTTP) using a
 * CSPR.cloud API key and pulls one read-only snapshot the Oracle folds into
 * the evidence packet's provenance. Returns null when no key is configured
 * or the network is unreachable, so offline demos keep working.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export interface McpSnapshotClient {
  fetchSnapshot(): Promise<{ tool: string; payload: unknown } | null>;
}

/** Read-only tools we are happy to call, in order of preference. */
const SNAPSHOT_TOOLS = ["GetNetworkStatus", "GetLatestBlock", "GetRates"];

export function createCasperMcpClient(opts: {
  url?: string;
  apiKey?: string;
}): McpSnapshotClient {
  const url = opts.url ?? "https://mcp.testnet.cspr.cloud/mcp";
  const apiKey = opts.apiKey;

  return {
    async fetchSnapshot() {
      if (!apiKey) return null;
      const client = new Client({ name: "quorum-oracle", version: "0.1.0" });
      try {
        const transport = new StreamableHTTPClientTransport(new URL(url), {
          requestInit: { headers: { "X-CSPR-Cloud-Api-Key": apiKey } },
        });
        // The SDK's Transport type clashes with exactOptionalPropertyTypes.
        await client.connect(transport as unknown as Parameters<typeof client.connect>[0]);
        const { tools } = await client.listTools();
        const tool = SNAPSHOT_TOOLS.find((t) => tools.some((x) => x.name === t));
        if (!tool) return null;
        const result = await client.callTool({ name: tool, arguments: {} });
        return { tool, payload: result.content };
      } catch {
        return null;
      } finally {
        await client.close().catch(() => {});
      }
    },
  };
}
