# echo-gateway

The local execution gateway for Echo Protocol. Runs on your machine alongside your AI agent (Claude Desktop or any MCP-compatible framework) and bridges agent intent to on-chain ERC-4337 execution.

> **Local-first.** The gateway runs entirely on your machine. No cloud server, no third-party relay. Execute keys and session keys never leave your environment.

---

## How it works

Echo Gateway combines two things:

1. **Dashboard** — a local web UI at `http://localhost:3000` for onboarding, policy management, session monitoring, and activity history.
2. **MCP server** — exposes tools that AI agents use to submit swap intents and manage autonomous sessions.

The on-chain model uses **EIP-7702 + ERC-4337**:
- The user's EOA is `UserOp.sender` (tokens stay in the EOA — no pre-deposit)
- EIP-7702 delegation to `EchoDelegationModule` is activated once during onboarding
- Real-time swaps use an Execute Key (`sig = [0x03][executeKeyHash]`)
- Session (DCA) swaps use a Session Key (`sig = [0x02][sessionId][sessionKeyHash]`) — no user confirmation per swap

---

## Quick start

### 1. Prerequisites

- Node.js 20+
- A Sepolia RPC URL (Alchemy free tier works)
- A Pimlico API key (free tier works) — used as the ERC-4337 bundler + paymaster
- A browser wallet that supports EIP-7702 (Rabby recommended)
- Claude Desktop or another MCP-compatible agent

### 2. Install

```bash
cd echo-gateway
npm install
```

### 3. Configure

```bash
cp .env.example .env
```

Edit `.env`:

```env
# ── Network ──────────────────────────────────────────
SEPOLIA_RPC_URL=https://eth-sepolia.g.alchemy.com/v2/YOUR_ALCHEMY_KEY
PIMLICO_API_KEY=YOUR_PIMLICO_API_KEY
CHAIN_ID=11155111

# ── Echo contracts (Sepolia) ─────────────────────────
POLICY_REGISTRY=0xd5Db48763809061cFc283bF51Df1F158BD237120
INTENT_REGISTRY=0x9c3c066a6dCbD5ea565171D61F7965B6319567fc
ECHO_POLICY_VALIDATOR=0xe4fecb0138Ff8E7aDC72b1F142fcbdCAcF12F554
ECHO_DELEGATION_MODULE=0x9aeAF3881FC24A639434C4e849C52341E8b1cc15
ECHO_ONBOARDING=0x6622fe1A7612Dc85aAd42F2D326a7a7572aB4805

# ── Mock Uniswap (Echo Sepolia deploy) ───────────────
UNISWAP_V3_ROUTER=0x37bFb0Bc15411FfA581732a0cE2aeb5A943cC75B
UNISWAP_V3_QUOTER=0x50F359Ae6a5A7796faF45d9D2D54EEa29BBEfe60

# ── Policy templates ──────────────────────────────────
TEMPLATE_CONSERVATIVE=0x153ccd56661fc5ac2a443a0426cb294076170bb32bd17f75580ae627fa64ea99
TEMPLATE_STANDARD=0x039a844943398a8fa17d671b48de13f72a9218515234641653363b612011a971
TEMPLATE_ACTIVE=0xb770bc267d97571e554e0ea0bc0cfde88e7d5d7fed3ebc83bb964bdf791ac4ea

# ── Gateway ───────────────────────────────────────────
GATEWAY_PORT=3000
GATEWAY_HOST=127.0.0.1

# ── Privy (optional — embedded wallet login) ──────────
# PRIVY_APP_ID=YOUR_PRIVY_APP_ID
# PRIVY_APP_SECRET=YOUR_PRIVY_APP_SECRET
```

> **Keystore password:** set `KEYSTORE_PASSWORD` in `.env` if you want to use a fixed passphrase (useful for non-interactive starts). Otherwise the gateway derives one from the environment.

### 4. Run

**Development** (hot reload via `tsx watch`):
```bash
npm run dev
```

**Production** (compile then run):
```bash
npm run build
npm start
```

The gateway listens on `http://localhost:3000` (or `GATEWAY_PORT`).

---

## Onboarding (first run)

Open `http://localhost:3000` in your browser. If no account exists in the local KeyStore, the dashboard walks you through onboarding:

### Step 1 — Connect wallet
Click **Connect wallet** in the bottom-left sidebar. Rabby, MetaMask, OKX Wallet, or any EIP-6963 browser wallet works. Rabby is recommended for EIP-7702 support.

### Step 2 — Name your account
Give the account a label (e.g. `main`, `trading`). Select a policy template:
- **Conservative** — tight daily limits, small per-swap cap
- **Standard** — balanced defaults
- **Active** — higher limits for frequent trading

### Step 3 — Set token limits
Add token limits for the assets your agent will trade (e.g. USDC → WETH). These are enforced on-chain by `EchoPolicyValidator`.

### Step 4 — Register on-chain (one transaction)
Click **Activate**. This sends a single **type-4 (EIP-7702) transaction** that:
1. Activates delegation from your EOA to `EchoDelegationModule`
2. Calls `EchoOnboarding.registerInstanceAndEip7702` to register your `PolicyInstance`

Sign in your wallet. After the transaction confirms, your account is active and the gateway stores your Execute Key locally.

> **EIP-7702 delegation is permanent after this transaction.** Future UserOps don't require re-signing the authorization.

---

## Connect to Claude Desktop

Add to your Claude Desktop `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "echo-gateway": {
      "command": "node",
      "args": ["C:/path/to/echo-mvp/echo-gateway/dist/index.js"],
      "env": {
        "GATEWAY_PORT": "3000"
      }
    }
  }
}
```

Or for development (no build step):

```json
{
  "mcpServers": {
    "echo-gateway": {
      "command": "npx",
      "args": ["tsx", "C:/path/to/echo-mvp/echo-gateway/src/index.ts"]
    }
  }
}
```

Restart Claude Desktop after editing. The gateway serves both the HTTP dashboard and the MCP server from the same process.

---

## MCP tools

| Tool | Description |
|------|-------------|
| `echo_get_context` | Returns the active account (instanceId, EOA, network). Always call this first. |
| `echo_get_policy` | Returns policy limits (daily cap, token limits, budget used). |
| `echo_submit_intent` | Execute a real-time swap. Runs pre-validation, builds and submits a UserOp via Pimlico. No user confirmation required. |
| `echo_create_session` | Create an autonomous session (DCA). Returns a `pendingTx` the user must sign once in the dashboard. |
| `echo_execute_session` | Execute one iteration of a session (e.g. daily DCA buy). No user confirmation required. |
| `echo_list_sessions` | List active sessions for the current account. |
| `echo_revoke_session` | Revoke a session on-chain. Returns a `pendingTx` for the user to sign. |
| `echo_pause_instance` | Pause/unpause the PolicyInstance. Returns a `pendingTx`. |

### Example: real-time swap

```
echo_submit_intent({
  tokenIn:   "0xBa9D46448e4142AC7a678678eFf6882D9197d716",  // MockUSDC
  tokenOut:  "0xF0527287E6B7570BdaaDe7629C47D60a3e0eF104",  // MockWETH
  amount:    "10000000",   // 10 USDC (6 decimals)
  direction: "exactInput"
})
```

### Example: daily DCA (session)

```
# 1. Create session (user signs once in dashboard)
echo_create_session({
  instanceId:      "0x...",
  tokenIn:         "0xBa9D46448e...",   // MockUSDC
  tokenOut:        "0xF0527287E6...",   // MockWETH
  maxAmountPerOp:  "10000000",          // 10 USDC max per swap
  totalBudget:     "300000000",         // 300 USDC total
  maxOpsPerDay:    1,
  sessionExpiry:   1776729600           // Unix timestamp
})

# 2. Execute daily (no user confirmation needed)
echo_execute_session({
  sessionId: "0xb90ea3e2...",
  amount:    "10000000"
})
```

---

## Deployed contracts (Sepolia — 2026-03-20)

| Contract | Address |
|----------|---------|
| PolicyRegistry | `0xd5Db48763809061cFc283bF51Df1F158BD237120` |
| IntentRegistry | `0x9c3c066a6dCbD5ea565171D61F7965B6319567fc` |
| EchoPolicyValidator | `0xe4fecb0138Ff8E7aDC72b1F142fcbdCAcF12F554` |
| EchoDelegationModule | `0x9aeAF3881FC24A639434C4e849C52341E8b1cc15` |
| EchoOnboarding | `0x6622fe1A7612Dc85aAd42F2D326a7a7572aB4805` |
| MockSwapRouter | `0x37bFb0Bc15411FfA581732a0cE2aeb5A943cC75B` |
| MockQuoterV2 | `0x50F359Ae6a5A7796faF45d9D2D54EEa29BBEfe60` |
| MockWETH | `0xF0527287E6B7570BdaaDe7629C47D60a3e0eF104` |
| MockUSDC | `0xBa9D46448e4142AC7a678678eFf6882D9197d716` |

---

## Local data

The gateway stores data in `~/.echo/`:

| File | Contents |
|------|----------|
| `keystore.json` | AES-256-GCM encrypted execute keys and session keys |
| `context.json` | Active account selection (`activeInstanceId`) |
| `activity.json` | Local swap history (appended on each successful submit) |

> Raw keys are never transmitted or logged. On-chain, only `keccak256(rawKey)` is stored. If `keystore.json` is deleted, execute keys must be re-issued on-chain.

---

## Architecture

```
Claude Desktop (or any MCP client)
 │
 └─ MCP Server (stdio / same process as HTTP)
      ├─ echo_get_context
      ├─ echo_submit_intent   → PreValidator → UniswapV3Tool → UserOpBuilder → Pimlico
      ├─ echo_create_session  → builds calldata for user to sign in dashboard
      ├─ echo_execute_session → PreValidator → UniswapV3Tool → UserOpBuilder → Pimlico
      ├─ echo_list_sessions   → reads KeyStore + on-chain PolicyRegistry
      └─ echo_revoke_session  → builds calldata for user to sign

HTTP server (Express, same port)
 ├─ GET  /              → Dashboard (index.html)
 ├─ GET  /api/context   → active account
 ├─ GET  /api/policy    → on-chain policy state
 ├─ GET  /api/sessions  → session list (pending + active)
 ├─ POST /api/sessions/confirm     → store real on-chain sessionId after activation tx
 ├─ POST /api/sessions/resolve-tx  → resolve stuck pending session from txHash
 ├─ GET  /api/activity  → local activity log
 ├─ GET  /api/keys      → list execute key accounts
 └─ POST /api/register-key → link existing on-chain instance

Internal components:
 ├─ KeyStore        AES-256-GCM encrypted file (~/.echo/keystore.json)
 ├─ PreValidator    two-stage off-chain policy check (mirrors on-chain logic)
 ├─ UserOpBuilder   builds + sponsors UserOps via Pimlico (pm_sponsorUserOperation)
 ├─ UniswapV3Tool   quotes via MockQuoterV2, builds exactInputSingle calldata
 └─ ActivityLog     append-only local swap log (~/.echo/activity.json)
```

---

## Project structure

```
src/
├── index.ts                  entry point — starts HTTP + MCP server
├── config/index.ts           env config and contract addresses
├── keystore/KeyStore.ts      AES-256-GCM key storage
├── mcp/McpServer.ts          MCP tool handlers
├── http/
│   ├── HttpServer.ts         Express server + route registration
│   └── routes/
│       ├── keystore.ts       /api/context, /api/keys, /api/register-key
│       ├── policy.ts         /api/policy, /api/pause
│       └── sessions.ts       /api/sessions (CRUD + confirm + resolve-tx)
├── userop/UserOpBuilder.ts   ERC-4337 UserOp construction + Pimlico submission
├── validation/PreValidator.ts two-stage pre-flight validation
├── tools/UniswapV3Tool.ts    swap quote + calldata builder
├── activity/ActivityLog.ts   local activity log
├── contracts/
│   └── PolicyRegistryABI.ts  on-chain ABI
└── dashboard/index.html      single-file dashboard UI
```

---

## Session lifecycle notes

Sessions have a two-phase activation flow:

1. `echo_create_session` generates a session key locally, stores it in KeyStore, and returns a `pendingTx` (calldata for `PolicyRegistry.createSession`).
2. The user must sign this transaction from the dashboard (Sessions page → **Sign to activate**). After the tx confirms, the dashboard parses the `SessionCreated` event to capture the real on-chain `sessionId` and writes it back to the keystore.
3. `echo_execute_session` uses the session key (no user confirmation) for each swap.

If a session tx was signed outside the auto-confirm flow, use the **"Already signed? Paste tx hash"** resolver on the Sessions page to link the confirmed sessionId to the local key.

---

## Security notes

- The gateway enforces policy pre-flight at the application layer — the on-chain `EchoPolicyValidator` is always the final authority
- If `keystore.json` is compromised, an attacker can operate within the PolicyInstance limits but cannot change those limits (that requires the owner EOA)
- The KEYSTORE_PASSWORD should not be left in plaintext in production; use a secrets manager or prompt on startup

---

## License

MIT
