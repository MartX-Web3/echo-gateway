# Echo Gateway — MCP Server

The MCP Server is the agent-facing interface of Echo Gateway. It exposes Echo Protocol's permission and execution layer as [Model Context Protocol](https://modelcontextprotocol.io) tools, allowing any MCP-compatible agent framework (OpenClaw, LangChain, custom bots) to interact with DeFi protocols within user-defined on-chain boundaries.

## How it fits in

```
OpenClaw / LangChain / any MCP-compatible agent
        │
        │  JSON-RPC over stdio or HTTP
        ▼
  McpServer (this module)
        │
        ├── PreValidator     — checks policy limits before + after tool call
        ├── UniswapV3Tool    — quote + build swap calldata
        ├── KeyStore         — signs UserOps with execute / session key
        └── UserOpBuilder    — assembles ERC-4337 UserOperation → Pimlico
```

The agent never touches private keys, calldata construction, or the bundler directly. It declares an intent; Echo Gateway validates, builds, signs, and submits.

---

## Tools

### MCP-01 `echo_submit_intent`

Execute a swap immediately using the real-time mode Execute Key.

Use this when the user is present and commanding a one-off swap. Each call requires the Execute Key to be loaded in KeyStore (unlocked gateway).

**Input**
```json
{
  "instanceId":  "0xabc...",
  "tokenIn":     "0xA0b8...eB48",
  "tokenOut":    "0xC02a...Cc2",
  "amount":      "100000000",
  "direction":   "exactInput",
  "slippageBps": 50
}
```

**Output**
```json
{
  "userOpHash": "0xdef...",
  "txHash":     "0x123...",
  "amountIn":   "100000000",
  "amountOut":  "49823000000000000000",
  "feeTier":    3000
}
```

**Lifecycle**
1. PreValidator Stage 1 — checks policy limits against on-chain state
2. UniswapV3Tool — gets quote, builds calldata (recipient hardcoded to AccountERC7579)
3. PreValidator Stage 2 — verifies calldata structure (target, selector, recipient, amount)
4. KeyStore.buildRealtimeSig — assembles `[0x01][executeKey]` signature
5. UserOpBuilder — builds and submits UserOperation via Pimlico

---

### MCP-02 `echo_create_session`

Create a SessionPolicy for autonomous recurring execution.

Use this when the user wants to set up an automated task (e.g. DCA, rebalancing). The user confirms once via WalletConnect/MetaMask; subsequent executions happen autonomously via `echo_execute_session`.

**Input**
```json
{
  "instanceId":     "0xabc...",
  "tokenIn":        "0xA0b8...eB48",
  "tokenOut":       "0xC02a...Cc2",
  "maxAmountPerOp": "50000000",
  "totalBudget":    "350000000",
  "maxOpsPerDay":   2,
  "sessionExpiry":  1780000000
}
```

**Output**
```json
{
  "sessionId":    "0xsess...",
  "sessionExpiry": 1780000000,
  "totalBudget":  "350000000",
  "maxOpsPerDay": 2
}
```

**Notes**
- Session is created on-chain by calling `PolicyRegistry.createSession()` from the user's wallet
- Echo Gateway stores the generated session key in KeyStore (encrypted)
- `sessionExpiry` must be ≤ `instance.expiry`
- `totalBudget` must fit within remaining `globalTotalBudget`

---

### MCP-03 `echo_execute_session`

Execute one operation within an existing session. Used by the agent scheduler for autonomous tasks.

**Input**
```json
{
  "instanceId": "0xabc...",
  "sessionId":  "0xsess...",
  "amount":     "50000000",
  "slippageBps": 50
}
```

**Output** — same as `echo_submit_intent`

**Lifecycle** — same as `echo_submit_intent` but uses session mode:
- PreValidator Stage 1 checks session limits (maxAmountPerOp, totalBudget, dailyOps) + MetaPolicy global caps
- Signature is `[0x02][sessionId][sessionKey]`

---

### MCP-04 `echo_list_sessions`

List active sessions for a PolicyInstance. Used by the agent to know which sessions are available for scheduling.

**Input**
```json
{
  "instanceId": "0xabc..."
}
```

**Output**
```json
{
  "sessions": [
    {
      "sessionId":     "0xsess...",
      "tokenIn":       "0xA0b8...eB48",
      "tokenOut":      "0xC02a...Cc2",
      "maxAmountPerOp":"50000000",
      "totalBudget":   "350000000",
      "totalSpent":    "100000000",
      "maxOpsPerDay":  2,
      "dailyOps":      1,
      "sessionExpiry": 1780000000,
      "active":        true
    }
  ]
}
```

---

### MCP-05 `echo_revoke_session`

Revoke an active session immediately. Calls `PolicyRegistry.revokeSession()` on-chain.

**Input**
```json
{
  "sessionId": "0xsess..."
}
```

**Output**
```json
{
  "revoked": true,
  "txHash":  "0x123..."
}
```

---

### MCP-06 `echo_get_policy`

Read the current state of a PolicyInstance. Useful for the agent to understand remaining budget and limits before planning a task.

**Input**
```json
{
  "instanceId": "0xabc..."
}
```

**Output**
```json
{
  "instanceId":        "0xabc...",
  "paused":            false,
  "expiry":            1780000000,
  "globalTotalBudget": "5000000000",
  "globalTotalSpent":  "1200000000",
  "globalMaxPerDay":   "1000000000",
  "globalDailySpent":  "300000000",
  "explorationBudget": "50000000",
  "explorationSpent":  "10000000",
  "tokenLimits": [
    {
      "token":      "0xC02a...Cc2",
      "maxPerOp":   "100000000",
      "maxPerDay":  "500000000",
      "dailySpent": "200000000"
    }
  ]
}
```

---

### MCP-07 `echo_pause_instance`

Emergency pause — stops all agent operations immediately without revoking the policy.

**Input**
```json
{
  "instanceId": "0xabc..."
}
```

**Output**
```json
{
  "paused": true,
  "txHash": "0x123..."
}
```

**Notes**
- Calls `PolicyRegistry.pauseInstance()` on-chain from the user's wallet
- Any UserOp submitted while paused will be rejected by EchoPolicyValidator
- Unpause via `PolicyRegistry.unpauseInstance()` directly or through the Dashboard

---

## Security properties preserved by MCP layer

| Property | How the MCP layer enforces it |
|---|---|
| S1 — No bypass of policy | PreValidator runs before and after every tool call. The on-chain Validator is always the final authority. |
| S2 — recipient == AccountERC7579 | UniswapV3Tool hardcodes recipient. PreValidator Stage 2 independently re-checks it before signing. |
| S3 — totalSpent append-only | MCP layer is read-only with respect to spend counters. Only `recordSpend()` (onlyValidator on-chain) can increment them. |
| S4 — only owner modifies policy | MCP-05/06/07 require the user's wallet to sign the on-chain transaction. The gateway cannot sign on behalf of the owner. |

---

## Error handling

All tools return structured errors. The agent can inspect the `code` field to decide how to respond.

```json
{
  "error": true,
  "code":  "EXCEEDS_PER_OP_LIMIT",
  "reason": "Amount 200000000 exceeds maxPerOp 100000000 for token 0xC02a..."
}
```

Common error codes (from PreValidator):

| Code | Meaning |
|---|---|
| `INSTANCE_PAUSED` | User has paused the instance |
| `INSTANCE_EXPIRED` | Policy has expired — user must create a new one |
| `EXCEEDS_PER_OP_LIMIT` | Single swap amount too large |
| `EXCEEDS_TOKEN_DAILY_LIMIT` | Token daily cap reached — try again tomorrow |
| `EXCEEDS_GLOBAL_DAILY_LIMIT` | Aggregate daily cap reached |
| `GLOBAL_BUDGET_EXHAUSTED` | Lifetime budget fully consumed |
| `EXPLORATION_BUDGET_EXHAUSTED` | Exploration budget consumed — promote token to tokenLimits |
| `SESSION_REVOKED` | Session was manually revoked |
| `SESSION_BUDGET_EXHAUSTED` | Session's totalBudget fully spent |
| `SESSION_DAILY_OPS_EXCEEDED` | maxOpsPerDay reached — try again tomorrow |
| `TARGET_NOT_ALLOWED` | Protocol not in allowedTargets whitelist |
| `RECIPIENT_MISMATCH` | Internal error — recipient was not AccountERC7579 |

---

## OpenClaw integration

Add to `openclaw_settings.json`:

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

The agent can then call Echo tools naturally:

```
User: "Buy 100 USDC worth of ETH"
OpenClaw → echo_submit_intent({ tokenIn: USDC, tokenOut: WETH, amount: "100000000", direction: "exactInput" })
Echo Gateway → validates → quotes → builds → signs → submits
OpenClaw ← { userOpHash: "0x...", amountOut: "49823..." }
```

```
User: "DCA into ETH, 50 USDC per day for a week, I'm going to sleep"
OpenClaw → echo_create_session({ maxAmountPerOp: "50000000", totalBudget: "350000000", maxOpsPerDay: 1, ... })
[User confirms on phone — one MetaMask signature]
OpenClaw scheduler → echo_execute_session({ sessionId: "0x...", amount: "50000000" }) [daily]
```