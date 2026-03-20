/**
 * Echo Gateway configuration.
 * Reads from environment variables with sensible defaults.
 * Call loadConfig() once at startup.
 */

import { join } from 'node:path';
import { homedir } from 'node:os';

export interface GatewayConfig {
  // Network
  sepoliaRpcUrl: string;
  pimlicoApiKey: string;
  chainId: number;

  // Contract addresses (Sepolia Phase 2)
  contracts: {
    policyRegistry:       `0x${string}`;
    intentRegistry:       `0x${string}`;
    echoPolicyValidator:  `0x${string}`;
    /** EchoDelegationModule — EIP-7702 delegate target for UserOp.sender (user EOA). */
    echoDelegationModule: `0x${string}`;
    uniswapV3Router:      `0x${string}`;
    uniswapV3Quoter:      `0x${string}`;
  };

  /** Optional — EchoOnboarding / docs links only; not required for UserOp assembly. */
  echoOnboarding: `0x${string}` | null;

  // Template IDs (from Deploy.s.sol output)
  templates: {
    conservative: `0x${string}`;
    standard:     `0x${string}`;
    active:       `0x${string}`;
  };

  // Privy embedded wallet auth (optional)
  privy: {
    appId:     string;
    appSecret: string;
  } | null;

  // KeyStore
  keystorePath: string;

  // Gateway server
  port: number;
  host: string;
}

function required(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Gateway config: missing required env var ${name}`);
  return val;
}

function optional(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

function addr(name: string): `0x${string}` {
  const val = required(name);
  if (!val.startsWith('0x') || val.length !== 42) {
    throw new Error(`Gateway config: ${name} is not a valid address`);
  }
  return val as `0x${string}`;
}

function optionalAddr(name: string): `0x${string}` | null {
  const val = process.env[name];
  if (!val?.trim()) return null;
  if (!val.startsWith('0x') || val.length !== 42) {
    throw new Error(`Gateway config: ${name} is not a valid address`);
  }
  return val as `0x${string}`;
}

function bytes32(name: string): `0x${string}` {
  const val = required(name);
  if (!val.startsWith('0x') || val.length !== 66) {
    throw new Error(`Gateway config: ${name} is not a valid bytes32`);
  }
  return val as `0x${string}`;
}

export function loadConfig(): GatewayConfig {
  return {
    sepoliaRpcUrl: required('SEPOLIA_RPC_URL'),
    pimlicoApiKey: required('PIMLICO_API_KEY'),
    chainId:       parseInt(optional('CHAIN_ID', '11155111'), 10),

    contracts: {
      policyRegistry:       addr('POLICY_REGISTRY'),
      intentRegistry:       addr('INTENT_REGISTRY'),
      echoPolicyValidator:  addr('ECHO_POLICY_VALIDATOR'),
      echoDelegationModule: addr('ECHO_DELEGATION_MODULE'),
      uniswapV3Router:      addr('UNISWAP_V3_ROUTER'),
      uniswapV3Quoter:      addr('UNISWAP_V3_QUOTER'),
    },

    echoOnboarding: optionalAddr('ECHO_ONBOARDING'),

    templates: {
      conservative: bytes32('TEMPLATE_CONSERVATIVE'),
      standard:     bytes32('TEMPLATE_STANDARD'),
      active:       bytes32('TEMPLATE_ACTIVE'),
    },

    privy: (() => {
      const appId     = process.env['PRIVY_APP_ID']?.trim();
      const appSecret = process.env['PRIVY_APP_SECRET']?.trim();
      if (appId && appSecret) return { appId, appSecret };
      return null;
    })(),

    keystorePath: optional(
      'KEYSTORE_PATH',
      join(homedir(), '.echo', 'keystore.json'),
    ),

    port: parseInt(optional('GATEWAY_PORT', '18790'), 10),
    host: optional('GATEWAY_HOST', '127.0.0.1'),
  };
}