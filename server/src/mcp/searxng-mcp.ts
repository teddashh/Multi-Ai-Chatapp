// Stdio MCP server that exposes our self-hosted SearXNG as a `web_search`
// tool. Codex CLI auto-spawns MCP servers registered via
// `codex mcp add <name> -- node …/searxng-mcp.js`, so registering this
// once gives every Codex run web search without changing how we
// shell out from cli.ts.
//
// The server is intentionally tiny: one tool, no auth, stdio transport.
// SearXNG itself is bound to localhost only, so trust matches.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { formatSearchResults, webSearch } from '../lib/webSearch.js';

const server = new Server(
  { name: 'searxng', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'web_search',
      description:
        'Search the web for current information when the answer requires up-to-date facts (news, prices, schedules, recent events, anything past your training cutoff). Returns a numbered list of pages with title, URL, and snippet.',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description:
              'Search query — phrase it the way a normal user would type into a search engine, in the language most likely to find good results.',
          },
        },
        required: ['query'],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  if (name !== 'web_search') {
    throw new Error(`unknown tool: ${name}`);
  }
  const query = ((args?.query as string | undefined) ?? '').trim();
  if (!query) {
    return { content: [{ type: 'text', text: 'Empty query' }] };
  }
  try {
    const results = await webSearch(query, 5);
    return {
      content: [{ type: 'text', text: formatSearchResults(query, results) }],
    };
  } catch (err) {
    return {
      content: [
        { type: 'text', text: `Search failed: ${(err as Error).message}` },
      ],
      isError: true,
    };
  }
});

await server.connect(new StdioServerTransport());
