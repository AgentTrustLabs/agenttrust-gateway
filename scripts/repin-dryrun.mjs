import { mcpFor } from '../src/registry/mcpClient.js';
import { TESTNET } from '../src/core/types.js';
const mcp = mcpFor(TESTNET);
const NEW_URI = 'https://api.sabokun.my.id/agenttrust/.well-known/agent-card.json';
const p = await mcp.buildSetAgentUri({ tokenId: 1004, agentUri: NEW_URI, metadataHashHex: '1f001ec9bd89f8ce48f2d3bf343f9ebd41604155f42f6a2fec426dd5101d7f84', sender: '4dWn8miA4PB7qE7mQpAPtG71JNWz5BBsNJPuq98znRF5evZg4d' });
console.log(JSON.stringify({contract: p.contract_address, receive: p.receive_name, energy: p.suggested_energy, hex: p.parameter_hex}, null, 1));
