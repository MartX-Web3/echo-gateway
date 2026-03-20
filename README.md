# echo-gateway

The local execution gateway for Echo Protocol. Runs on your machine alongside your AI agent framework and serves as the bridge between agent intent and on-chain execution.

> **Local-first.** The gateway runs entirely on your machine. No cloud server, no third-party relay. Your keys never leave your local environment.

**EIP-7702 (MVP):** `UserOperation.sender` is the **user EOA**. The EOA delegates execution code to **`EchoDelegationModule`** (`ECHO_DELEGATION_MODULE`). Pimlico requests include optional **`eip7702Auth`** (signed authorization). Real-time UserOp signatures use **`0x03` + 32-byte ExecuteKey** (`validateFor7702`); session mode remains **`0x02`**. On-chain registration and lifecycle are documented in the sibling **`echo-contracts`** repo (`README.md`).

---

## Overview

Echo Gateway has two jobs:

1. **Dashboard & control plane (for humans + AI agents):**
   - Serves a local dashboard where users complete onboarding after starting the gateway.
   - The dashboard lists **policy contexts** stored in the local KeyStore (each maps a `PolicyInstance` to your **EOA** as `UserOp.sender`). If none exist, onboarding walks you through naming, optional template hints, then **linking** an instance ID after you register on-chain via **echo-contracts**.
   - Each entry represents one policy instance, the **EOA** used as sender/recipient, owner wallet, and activity. Users can switch contexts in the sidebar.
   - Exposes an MCP server that agent frameworks (e.g. OpenClaw) use to query tools, submit intents, manage sessions, and monitor activity **for the currently selected context**.
2. **Execution plane (for transactions):** Explicit transactions are built by the gateway (no separate “build transaction” tool; no RPC intercept). We build UserOperations from agent intents using **user-registered protocols** (allowedTargets) and **allowed selectors**, run **two-stage pre-validation** (PreValidator), then submit via Pimlico.

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
 └─ RPC proxy (/api/rpc)             ← passthrough only (e.g. for dashboard); no intercept


Internal components:
 ├─ KeyStore           AES-256 encrypted local file
 │                     executeKey and sessionKey storage
 │                     survives gateway restart
 │
 ├─ UniswapV3Tool      internal tool module (MVP only)
 │                     calls Uniswap Quoter for optimal routing
 │                     builds exactInputSingle calldata
 │                     recipient hardcoded = user EOA
 │
 ├─ PreValidator       two-stage validation before chain submission
 │    ├─ stage 1       intent layer — check policy limits before calling tool
 │    └─ stage 2       transaction layer — verify calldata after tool returns
 │
 └─ UserOpBuilder      constructs ERC-4337 UserOperations (initCode empty)
                       real-time:  sig = [0x03][pad(executeKey, 32)]  (7702 / validateFor7702)
                       session:    sig = [0x02][sessionId][pad(sessionKey, 32)]
                       optional:   eip7702Auth on Pimlico JSON-RPC when required
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
   - recipient = user EOA (hardcoded, not from agent)
   → return calldata

4. Pre-validation #2 (transaction layer):
   - target == Uniswap V3 SwapRouter constant?
   - selector == exactInputSingle?
   - decoded recipient == user EOA?
   - decoded amountIn matches declared intent?
   → PASS: build UserOperation

5. UserOpBuilder:
   - sender = user EOA; initCode = empty
   - signature = [0x03][pad(executeKey, 32)]
   - gas estimate / sponsor via Pimlico; include eip7702Auth when configured (e.g. `context.json`)

6. Submit to Pimlico bundler
   → EntryPoint → EchoDelegationModule (7702) → EchoPolicyValidator (on-chain)
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
- Verifies `recipient == user EOA` (`UserOp.sender`) — the most critical check
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
- A browser to access the local Echo Gateway dashboard (onboarding links your EOA + policy instance after on-chain registration)
- OpenClaw (or another MCP-compatible agent) installed locally

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

# Echo contracts (Sepolia) — names match .env.example
POLICY_REGISTRY=0x...
INTENT_REGISTRY=0x...
ECHO_POLICY_VALIDATOR=0x...
ECHO_DELEGATION_MODULE=0x...
# Optional: ECHO_ONBOARDING=0x...

# Key Store
KEYSTORE_PASSWORD=your_local_password

# Gateway HTTP (Dashboard + API)
GATEWAY_PORT=3000

# Mock Uniswap stack (MVP on Sepolia) — see "Reference deployment" below
UNISWAP_V3_ROUTER=0x...
UNISWAP_V3_QUOTER=0x...

# Template bytes32 IDs (from same deploy)
TEMPLATE_CONSERVATIVE=0x...
TEMPLATE_STANDARD=0x...
TEMPLATE_ACTIVE=0x...
```

### Reference deployment (Sepolia — Mock + EIP-7702)

Pinned addresses from a typical **echo-contracts** `Deploy.s.sol` run on **Sepolia**. Copy into `.env` as needed; **redeploys change these** — treat as examples unless you own that deployment.

**Echo Protocol mock contracts (Sepolia)**

| Contract | Address |
|----------|---------|
| MockWETH | `0xD9100773B0B2717B927265Ce92afeA7c3dCA620E` |
| MockUSDC | `0x74c954C2e6f090d0Ef94cA9A220f5B4D70aB6A43` |
| MockQuoterV2 | `0x4683a16b9D165ff8EaA90b1cD711c62caBA9c70e` |
| MockSwapRouter | `0x68a27E6b5E671375bA5b2De857DaeB4E757a9e17` |

Gateway maps **`UNISWAP_V3_ROUTER`** → MockSwapRouter, **`UNISWAP_V3_QUOTER`** → MockQuoterV2. MockWETH / MockUSDC are **not** separate env vars; the Dashboard and scripts default token lists point at these two addresses.

**Core deployment (EIP-7702 path)**

| Contract | Address | `.env` key |
|----------|---------|------------|
| PolicyRegistry | `0x97d34e2af18c20971BE7F1D85Abe73624A13762b` | `POLICY_REGISTRY` |
| IntentRegistry | `0x69961Da79ad0d8D944357AdEE272E30C3c6E9643` | `INTENT_REGISTRY` |
| EchoPolicyValidator | `0xb75a300d766b30B5DCec9F79406A9719dF0e350c` | `ECHO_POLICY_VALIDATOR` |
| EchoDelegationModule | `0x4b6f847f5D85539895A3D9B7b8CE34fF086a0a86` | `ECHO_DELEGATION_MODULE` |
| EchoOnboarding | `0xe7572264D59BD249119aD83ED31E92d1E49bA7bb` | `ECHO_ONBOARDING` (optional) |

**Policy template IDs (`bytes32`)**

| Template | ID |
|----------|-----|
| Conservative | `0x153ccd56661fc5ac2a443a0426cb294076170bb32bd17f75580ae627fa64ea99` |
| Standard | `0x039a844943398a8fa17d671b48de13f72a9218515234641653363b612011a971` |
| Active | `0xb770bc267d97571e554e0ea0bc0cfde88e7d5d7fed3ebc83bb964bdf791ac4ea` |

Use `TEMPLATE_CONSERVATIVE`, `TEMPLATE_STANDARD`, `TEMPLATE_ACTIVE` in `.env` for the three rows above.

### Start

```bash
npm run build
npm start
```

The gateway starts the HTTP server (dashboard + API). RPC proxy is at `/api/rpc` (passthrough only; no intercept).

After the process starts, **open the dashboard in your browser first**:

- If there are no contexts in the local KeyStore, the dashboard enters onboarding:
  - connect your wallet (EOA),
  - set a nickname and policy limits,
  - **Guided path (recommended):** `POST /api/onboarding/prepare` → sign EIP-7702 `authorize()` (delegate = `ECHO_DELEGATION_MODULE`) → submit `EchoOnboarding.registerInstanceAndEip7702` from the dashboard → `POST /api/onboarding/finalize` + `POST /api/context` (optional `eip7702Auth`). Requires `ECHO_ONBOARDING` in `.env`.
  - **Manual path:** register elsewhere, then paste **instance ID** and use `POST /api/register-key` (Dashboard “Manual link”).
- If there are existing contexts, the dashboard lists them and lets you switch for management.

Once linking is complete, you can connect MCP-compatible agents. Tools use the **currently selected context** (EOA + instance) in the dashboard.

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
├── http/
│   └── routes/
│       └── rpcProxy.ts     RPC passthrough (/api/rpc); no intercept
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
