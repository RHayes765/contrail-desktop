/**
 * Minimal stdio MCP server for the S8 live demo: one tool, `echo`.
 * Hand-rolled newline-delimited JSON-RPC — no dependencies — so the demo
 * proves the SDK passthrough, not a framework.
 */
import readline from 'node:readline';

const rl = readline.createInterface({ input: process.stdin });

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

rl.on('line', (line) => {
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    return;
  }
  if (req.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: req.id,
      result: {
        protocolVersion: req.params?.protocolVersion ?? '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'contrail-demo-echo', version: '1.0.0' },
      },
    });
  } else if (req.method === 'tools/list') {
    send({
      jsonrpc: '2.0',
      id: req.id,
      result: {
        tools: [
          {
            name: 'echo',
            description: 'Echoes the provided text back, prefixed with ECHO:.',
            inputSchema: {
              type: 'object',
              properties: { text: { type: 'string', description: 'Text to echo.' } },
              required: ['text'],
            },
          },
        ],
      },
    });
  } else if (req.method === 'tools/call') {
    const text = String(req.params?.arguments?.text ?? '');
    send({
      jsonrpc: '2.0',
      id: req.id,
      result: { content: [{ type: 'text', text: `ECHO: ${text}` }] },
    });
  } else if (req.id !== undefined) {
    // Any other REQUEST gets an empty result; notifications are ignored.
    send({ jsonrpc: '2.0', id: req.id, result: {} });
  }
});
