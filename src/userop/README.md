# UserOpBuilder

Assembles and submits ERC-4337 `PackedUserOperation`s via Pimlico.

This is the final step in the Echo Gateway execution pipeline:

```
McpServer
  └── _submitUserOp(account, calldata, signature)
        │
        ▼
  UserOpBuilder
    1. Wrap calldata → AccountERC7579.execute() outer call
    2. Estimate gas (eth_estimateUserOperationGas via Pimlico)
    3. Get fee data (eth_maxFeePerGas, eth_maxPriorityFeePerGas)
    4. Assemble PackedUserOperation
    5. Submit (eth_sendUserOperation via Pimlico)
    6. Poll for receipt (eth_getUserOperationReceipt)
    7. Return { userOpHash, txHash }
```

---

## ERC-4337 PackedUserOperation layout (EntryPoint v0.7)

```
struct PackedUserOperation {
  address sender;              // AccountERC7579 clone address
  uint256 nonce;               // from EntryPoint.getNonce(account, 0)
  bytes   initCode;            // empty (account already deployed)
  bytes   callData;            // AccountERC7579.execute(mode, executionCalldata)
  bytes32 accountGasLimits;    // abi.encodePacked(verificationGasLimit uint128, callGasLimit uint128)
  uint256 preVerificationGas;
  bytes32 gasFees;             // abi.encodePacked(maxPriorityFeePerGas uint128, maxFeePerGas uint128)
  bytes   paymasterAndData;    // empty (user pays gas in ETH for MVP)
  bytes   signature;           // [0x01][executeKey] or [0x02][sessionId][sessionKey]
}
```

---

## callData construction

`userOp.callData` is NOT the raw swap calldata — it is a call to `AccountERC7579.execute()` which wraps the swap calldata:

```
AccountERC7579.execute(bytes32 mode, bytes calldata executionCalldata)

mode = CALLTYPE_SINGLE = bytes32(0)

executionCalldata = abi.encodePacked(
  target,        // Uniswap V3 SwapRouter (20 bytes)
  value,         // 0 (uint256, 32 bytes)
  innerCalldata  // exactInputSingle / exactOutputSingle calldata
)
```

This produces the outer calldata layout that `EchoPolicyValidator._extractTarget()` and `_extractInnerCalldata()` parse:

```
[0:4]    execute() selector
[4:36]   mode (bytes32 = 0)
[36:68]  offset pointer to executionCalldata (= 0x40)
[68:100] length of executionCalldata
[100:120] target address (20 bytes, abi.encodePacked)
[120:152] value (uint256 = 0)
[152:...]  innerCalldata (exactInputSingle / exactOutputSingle)
```

---

## Gas handling (MVP)

- `verificationGasLimit` and `callGasLimit`: estimated via `eth_estimateUserOperationGas` (Pimlico)
- `preVerificationGas`: returned by the same estimate call
- `maxFeePerGas` and `maxPriorityFeePerGas`: from `pimlico_getUserOperationGasPrice`
- Paymaster: **Pimlico Verifying Paymaster** — sponsor gas fees, so the user does not need ETH in `AccountERC7579` for gas
- Gas limits are padded by 20% to reduce revert risk from estimation error

---

## Pimlico API

Pimlico is used as the ERC-4337 bundler. It exposes a standard JSON-RPC endpoint:

```
https://api.pimlico.io/v2/sepolia/rpc?apikey=YOUR_KEY
```

Key methods used:

| Method | Purpose |
|---|---|
| `eth_estimateUserOperationGas` | Get gas limits for a UserOp |
| `pimlico_getUserOperationGasPrice` | Get current fee recommendations |
| `eth_sendUserOperation` | Submit the UserOp to the mempool |
| `eth_getUserOperationReceipt` | Poll for on-chain inclusion |

EntryPoint v0.7 address (same on all chains):
`0x0000000071727De22E5E9d8BAf0edAc6f37da032`

---

## Nonce

Nonces are fetched from the EntryPoint contract before each submission:

```solidity
EntryPoint.getNonce(address account, uint192 key) → uint256
```

Key is always `0` for MVP (single-key nonce space). The nonce is a 2D value: `key (192 bits) | seq (64 bits)`. EntryPoint auto-increments `seq` on each successful UserOp.

---

## Error handling

| Error | Cause | Recovery |
|---|---|---|
| `AA21 didn't pay prefund` | Account has no ETH for gas | User must deposit ETH into AccountERC7579 |
| `AA23 reverted` | EchoPolicyValidator rejected the UserOp | Check PreValidator output — policy limit hit |
| `AA25 invalid account nonce` | Nonce collision (concurrent UserOps) | Retry with fresh nonce |
| `replacement underpriced` | Gas price too low | Retry with higher gas price |

All errors are surfaced as structured `McpError` responses to the agent.

---

## Polling strategy

After `eth_sendUserOperation`, UserOpBuilder polls `eth_getUserOperationReceipt` with exponential backoff:

```
attempt 1: wait 2s
attempt 2: wait 4s
attempt 3: wait 8s
...
max attempts: 10 (total ~34 minutes, well beyond any reasonable block inclusion time)
timeout error after max attempts
```

On Sepolia, block time is ~12s. Most UserOps are included within 1-2 blocks (12-24s).