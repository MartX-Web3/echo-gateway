/**
 * Minimal ABIs for Uniswap V3 contracts used by Echo Gateway.
 * Only the functions actually called are included.
 */

/** ISwapRouter — exactInputSingle and exactOutputSingle */
export const SWAP_ROUTER_ABI = [
  {
    name: 'exactInputSingle',
    type: 'function',
    stateMutability: 'payable',
    inputs: [
      {
        name: 'params',
        type: 'tuple',
        components: [
          { name: 'tokenIn',           type: 'address' },
          { name: 'tokenOut',          type: 'address' },
          { name: 'fee',               type: 'uint24'  },
          { name: 'recipient',         type: 'address' },
          { name: 'deadline',          type: 'uint256' },
          { name: 'amountIn',          type: 'uint256' },
          { name: 'amountOutMinimum',  type: 'uint256' },
          { name: 'sqrtPriceLimitX96', type: 'uint160' },
        ],
      },
    ],
    outputs: [{ name: 'amountOut', type: 'uint256' }],
  },
  {
    name: 'exactOutputSingle',
    type: 'function',
    stateMutability: 'payable',
    inputs: [
      {
        name: 'params',
        type: 'tuple',
        components: [
          { name: 'tokenIn',           type: 'address' },
          { name: 'tokenOut',          type: 'address' },
          { name: 'fee',               type: 'uint24'  },
          { name: 'recipient',         type: 'address' },
          { name: 'deadline',          type: 'uint256' },
          { name: 'amountOut',         type: 'uint256' },
          { name: 'amountInMaximum',   type: 'uint256' },
          { name: 'sqrtPriceLimitX96', type: 'uint160' },
        ],
      },
    ],
    outputs: [{ name: 'amountIn', type: 'uint256' }],
  },
] as const;

/** IQuoterV2 — quoteExactInputSingle and quoteExactOutputSingle */
export const QUOTER_V2_ABI = [
  {
    name: 'quoteExactInputSingle',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      {
        name: 'params',
        type: 'tuple',
        components: [
          { name: 'tokenIn',           type: 'address' },
          { name: 'tokenOut',          type: 'address' },
          { name: 'amountIn',          type: 'uint256' },
          { name: 'fee',               type: 'uint24'  },
          { name: 'sqrtPriceLimitX96', type: 'uint160' },
        ],
      },
    ],
    outputs: [
      { name: 'amountOut',                   type: 'uint256' },
      { name: 'sqrtPriceX96After',           type: 'uint160' },
      { name: 'initializedTicksCrossed',     type: 'uint32'  },
      { name: 'gasEstimate',                 type: 'uint256' },
    ],
  },
  {
    name: 'quoteExactOutputSingle',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      {
        name: 'params',
        type: 'tuple',
        components: [
          { name: 'tokenIn',           type: 'address' },
          { name: 'tokenOut',          type: 'address' },
          { name: 'amount',            type: 'uint256' },
          { name: 'fee',               type: 'uint24'  },
          { name: 'sqrtPriceLimitX96', type: 'uint160' },
        ],
      },
    ],
    outputs: [
      { name: 'amountIn',                    type: 'uint256' },
      { name: 'sqrtPriceX96After',           type: 'uint160' },
      { name: 'initializedTicksCrossed',     type: 'uint32'  },
      { name: 'gasEstimate',                 type: 'uint256' },
    ],
  },
] as const;

/**
 * Uniswap V3 function selectors (keccak256 of function signature, first 4 bytes).
 * These match IntentRegistry.sol EXACT_INPUT_SINGLE and EXACT_OUTPUT_SINGLE.
 */
export const SELECTORS = {
  exactInputSingle:  '0x414bf389' as const,
  exactOutputSingle: '0x4aa4a4fa' as const,
} as const;
