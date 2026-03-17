# echo-gateway

The local execution gateway for Echo Protocol. Runs on your machine alongside your AI agent framework and serves as the bridge between agent intent and on-chain execution.

> **Local-first.** The gateway runs entirely on your machine. No cloud server, no third-party relay. Your keys never leave your local environment.

---

## Overview

Echo Gateway has two jobs:

1. **Control plane (for AI agents):** Exposes an MCP server that OpenClaw uses to query available tools, submit intents, manage sessions, and monitor activity.
2. **Execution plane (for transactions):** Intercepts Ethereum RPC calls from tools, runs two-stage pre-validation, builds UserOperations, and submits them to Pimlico.

The gateway enforces Echo's security model at the application layer — but the on-chain `EchoPolicyValidator` is always the final authority.

---

## Architecture

```
OpenClaw agent
 │
 ├─ MCP Server (port 3000)          ← agent control plane
 │    ├─ echo_get_available_tools
 │    ├─ echo_submit_intent          intent → pre-val #1 → tool → pre-val #2 → UserOp
 │    ├─ echo_create_session
 │    ├─ echo_execute_session        session intent → pre-val → UserOp
 │    ├─ echo_list_sessions
 │    ├─ echo_revoke_session
 │    └─ echo_get_activity_log
 │
 └─ Proxy Adapter (port 8545)       ← transparent RPC proxy
      └─ eth_sendTransaction → intercept + wrap
         all other methods  → passthrough to Alchemy


Internal components:
 ├─ KeyStore           AES-256 encrypted local file
 │                     executeKey and sessionKey storage
 │                     survives gateway restart
 │
 ├─ UniswapV3Tool      internal tool module (MVP only)
 │                     calls Uniswap Quoter for optimal routing
 │                     builds exactInputSingle calldata
 │                     recipient hardcoded = AccountERC7579
 │
 ├─ PreValidator       two-stage validation before chain submission
 │    ├─ stage 1       intent layer — check policy limits before calling tool
 │    └─ stage 2       transaction layer — verify calldata after tool returns
 │
 └─ UserOpBuilder      constructs ERC-4337 UserOperations
                       real-time:  sig = [0x01][pad(executeKey, 32)]
                       session:    sig = [0x02][sessionId][pad(sessionKey, 32)]
```

---

## Request lifecycle

### Real-time mode

```
User → OpenClaw: "buy 100 USDC of ETH"

1. OpenClaw → MCP: echo_submit_intent({
     tool: "uniswap-v3", action: "swap",
     tokenIn: "USDC", tokenOut: "WETH", amount: 100
   })

2. Pre-validation #1 (intent layer):
   - PolicyInstance active and not paused?
   - uniswap-v3 in installed tools?
   - WETH in tokenLimits or explorationBudget?
   - 100 USDC ≤ maxPerOp?
   - daily cap not exceeded?
   - global cap not exceeded?
   → PASS: forward to UniswapV3Tool

3. UniswapV3Tool:
   - call Uniswap Quoter → optimal amountOutMinimum
   - build exactInputSingle calldata
   - recipient = AccountERC7579 (hardcoded, not from agent)
   → return calldata

4. Pre-validation #2 (transaction layer):
   - target == Uniswap V3 SwapRouter constant?
   - selector == exactInputSingle?
   - decoded recipient == AccountERC7579?
   - decoded amountIn matches declared intent?
   → PASS: build UserOperation

5. UserOpBuilder:
   - sender = AccountERC7579
   - signature = [0x01][pad(executeKey, 32)]
   - gas estimate via Pimlico

6. Submit to Pimlico bundler
   → EntryPoint → AccountERC7579 → EchoPolicyValidator (on-chain)
   → PASS → Uniswap swap executes

7. Return { txHash, amountOut } to OpenClaw
```

### Session mode

```
User → OpenClaw: "DCA into ETH, 50 USDC/day for 7 days"

1. OpenClaw → MCP: echo_create_session({
     tool: "uniswap-v3", tokenIn: "USDC", tokenOut: "WETH",
     amountPerOp: 50, totalBudget: 350, durationDays: 7
   })

2. Gateway validates params ⊆ PolicyInstance
   → WalletConnect push to user's phone
   → user confirms (one tap)
   → SessionPolicy stored on-chain
   → Session Key generated locally, stored in KeyStore
   → return { sessionId }

3. OpenClaw scheduler fires daily:
   OpenClaw → MCP: echo_execute_session({
     sessionId: "...",
     intent: { action: "swap", tokenIn: "USDC", tokenOut: "WETH", amount: 50 }
   })

4. Same pre-validation #1 + #2 as real-time, but against SessionPolicy
   signature = [0x02][sessionId][pad(sessionKey, 32)]

5. On-chain: EchoPolicyValidator validates SessionPolicy
   session.totalSpent updated after pass
```

---

## Two-stage pre-validation

Pre-validation is a UX layer, not a security layer. The on-chain Validator is always the final authority.

**Stage 1 — intent layer** (before calling the tool)
- Catches obviously invalid requests fast, without wasting a Tool call
- Returns human-readable errors to the agent immediately

**Stage 2 — transaction layer** (after the tool returns calldata)
- Echo does not trust the tool's output
- Independently decodes the calldata and verifies it matches the declared intent
- Verifies `recipient == AccountERC7579` — the most critical check
- Verifies `target` and `selector` are on the allowlist

If Stage 2 fails, the UserOp is never built. The tool's calldata is rejected.

---

## MCP tools reference

| Tool | PRD ref | Description |
|---|---|---|
| `echo_get_available_tools()` | MCP-01 | Returns installed tools and their supported actions |
| `echo_submit_intent(params)` | MCP-02 | Submit a real-time intent. Runs pre-val #1, calls tool, runs pre-val #2, builds and submits UserOp |
| `echo_create_session(params)` | MCP-03 | Create a SessionPolicy on-chain. Returns sessionId after user confirms |
| `echo_execute_session(params)` | MCP-04 | Execute one iteration of a session task |
| `echo_list_sessions()` | MCP-05 | List all active sessions with progress |
| `echo_revoke_session(sessionId)` | MCP-06 | Revoke a session on-chain after user confirms |
| `echo_get_activity_log(limit)` | MCP-07 | Fetch recent ValidationPassed/ValidationFailed events |

### Error format

All MCP tools return structured errors on failure:

```json
{
  "error": true,
  "code": "DAILY_LIMIT_EXCEEDED",
  "message": "WETH daily limit is 500 USDC. You have spent 480 today. Remaining: 20 USDC.",
  "details": {
    "token": "WETH",
    "limit": 500000000,
    "spent": 480000000,
    "remaining": 20000000
  }
}
```

---

## Key Store

The Key Store is an AES-256 encrypted local file that persists execute keys and session keys across gateway restarts.

- Raw keys are stored only here — never in logs, never transmitted, never on-chain
- On-chain, only `keccak256(rawKey)` is stored
- If the Key Store file is deleted, keys must be re-issued (old on-chain hashes become unreachable)
- The encryption password is derived from an environment variable

```
~/.echo/keystore.enc
  executeKeys:
    { raw: "0x...", instanceId: "0x...", label: "openclaw-main" }
  sessionKeys:
    { raw: "0x...", sessionId: "0x...", instanceId: "0x..." }
```

---

## Setup

### Prerequisites

- Node.js 20+
- An Echo account deployed via [echo-dashboard](https://github.com/echo-protocol/echo-dashboard)
- OpenClaw installed locally

### Install

```bash
git clone https://github.com/echo-protocol/echo-gateway
cd echo-gateway
npm install
cp .env.example .env
```

### Configure

```env
# Chain
SEPOLIA_RPC_URL=https://eth-sepolia.g.alchemy.com/v2/YOUR_KEY
CHAIN_ID=11155111

# Pimlico
PIMLICO_API_KEY=your_pimlico_key

# Echo contracts (Sepolia)
POLICY_REGISTRY_ADDRESS=0x...
INTENT_REGISTRY_ADDRESS=0x...
VALIDATOR_ADDRESS=0x...
FACTORY_ADDRESS=0x...

# Key Store
KEYSTORE_PASSWORD=your_local_password

# MCP Server
MCP_PORT=3000

# Proxy Adapter
PROXY_PORT=8545
ALCHEMY_RPC_URL=https://eth-sepolia.g.alchemy.com/v2/YOUR_KEY
```

### Start

```bash
npm run build
npm start
```

The gateway starts two services:
- MCP Server on `localhost:3000`
- Proxy Adapter on `localhost:8545`

### Connect to OpenClaw

Add to your `openclaw_settings.json`:

```json
{
  "mcpServers": {
    "echo": {
      "command": "npx",
      "args": ["@echo-protocol/gateway-mcp"],
      "env": {
        "ECHO_GATEWAY": "http://localhost:3000"
      }
    }
  }
}
```

Set your Execute Key (generated in Echo Dashboard):

```env
ECHO_EXECUTE_KEY=0x...
ECHO_INSTANCE_ID=0x...
```

---

## Project structure

```
src/
├── index.ts                gateway entry point
├── config/
│   └── index.ts            environment config and validation
├── keystore/
│   └── KeyStore.ts         AES-256 encrypted key storage
├── tools/
│   └── UniswapV3Tool.ts    Uniswap V3 tool module (MVP)
├── validation/
│   ├── PreValidator.ts     two-stage pre-validation
│   └── errors.ts           structured error types
├── mcp/
│   ├── McpServer.ts        MCP server setup
│   └── tools/              one file per MCP tool
├── proxy/
│   └── ProxyAdapter.ts     HTTP proxy on :8545
├── userop/
│   └── UserOpBuilder.ts    ERC-4337 UserOp construction
├── contracts/
│   ├── abis.ts             contract ABIs
│   └── addresses.ts        Sepolia deployment addresses
└── types/
    └── index.ts            shared TypeScript types
```

---

## Dependencies

| Package | Purpose |
|---|---|
| `viem` | Ethereum interaction |
| `@modelcontextprotocol/sdk` | MCP server implementation |
| `permissionless` | ERC-4337 UserOp building |
| `dotenv` | Environment config |

---

## What the gateway cannot protect against

- If the user's private key is stolen, an attacker can modify the PolicyInstance and bypass all limits
- The gateway is a pre-flight check layer — the on-chain Validator is the real security boundary
- If the gateway process itself is compromised (e.g. malware on the user's machine), the attacker holds the Execute Key and can operate within MetaPolicy limits

In Phase 4, a TEE-isolated remote gateway will provide the same security guarantees without local deployment.

---

## License

MIT
