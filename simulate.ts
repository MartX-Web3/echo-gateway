import { createPublicClient, http, encodeFunctionData, encodePacked, toHex, keccak256, encodeAbiParameters, parseAbi } from 'viem';
import { sepolia } from 'viem/chains';
import { readFileSync } from 'fs';
// Load .env
const envLines = readFileSync('.env', 'utf8').split('\n');
for (const line of envLines) {
  const m = line.match(/^([^#=]+)=(.*)$/);
  if (m) process.env[m[1].trim()] = m[2].trim();
}

const client = createPublicClient({ chain: sepolia, transport: http(process.env.SEPOLIA_RPC_URL!) });

const EOA     = '0x06b90b78b0a061f0239965cadb6069f5e53a4ad6' as const;
const USDC    = '0xBa9D46448e4142AC7a678678eFf6882D9197d716' as const;
const WETH    = '0xF0527287E6B7570BdaaDe7629C47D60a3e0eF104' as const;
const ROUTER  = '0x37bFb0Bc15411FfA581732a0cE2aeb5A943cC75B' as const;
const VALIDATOR = '0xe4fecb0138Ff8E7aDC72b1F142fcbdCAcF12F554' as const;
const INSTANCE = '0x4fba2a3e1041eea5525f001dee11f847fc763422da449cd77af1d64a9b422f72' as const;

const deadline = BigInt(Math.floor(Date.now()/1000) + 300);

// Build innerCalldata (exactInputSingle with deadline)
const innerCalldata = encodeFunctionData({
  abi: [{
    name:'exactInputSingle', type:'function', stateMutability:'nonpayable',
    inputs:[{name:'params',type:'tuple',components:[
      {name:'tokenIn',type:'address'},{name:'tokenOut',type:'address'},
      {name:'fee',type:'uint24'},{name:'recipient',type:'address'},
      {name:'deadline',type:'uint256'},{name:'amountIn',type:'uint256'},
      {name:'amountOutMinimum',type:'uint256'},{name:'sqrtPriceLimitX96',type:'uint160'}
    ]}],
    outputs:[{name:'',type:'uint256'}]
  }] as const,
  functionName:'exactInputSingle',
  args:[{tokenIn:USDC, tokenOut:WETH, fee:3000, recipient:EOA, deadline, amountIn:10000000n, amountOutMinimum:0n, sqrtPriceLimitX96:0n}]
});

console.log('innerCalldata length (bytes):', (innerCalldata.length - 2) / 2, '(need >= 260)');

// executionCalldata = abi.encodePacked(target, uint256(0), innerCalldata)
const executionCalldata = encodePacked(['address','uint256','bytes'], [ROUTER, 0n, innerCalldata]);

// outerCalldata = execute(CALLTYPE_SINGLE, executionCalldata)
const outerCalldata = encodeFunctionData({
  abi:[{name:'execute',type:'function',stateMutability:'payable',
    inputs:[{name:'mode',type:'bytes32'},{name:'executionCalldata',type:'bytes'}],outputs:[]}] as const,
  functionName:'execute',
  args:[('0x'+'00'.repeat(32)) as `0x${string}`, executionCalldata]
});

// Verify target extraction: bytes [100:120] from outerCalldata
const outerBytes = outerCalldata.slice(2); // remove '0x'
const target = outerBytes.slice(200, 240); // bytes 100..120 = chars 200..240
console.log('target@[100:120]:', '0x'+target, '(should be router)');
console.log('expected router: ', ROUTER.toLowerCase());

// Use dummy key [0x03][0x01*32]
const sig = toHex(new Uint8Array(33).fill(1).map((v,i) => i===0 ? 0x03 : v));

const validateAbi = [{
  name:'validateFor7702', type:'function', stateMutability:'nonpayable',
  inputs:[
    {name:'userOp', type:'tuple', components:[
      {name:'sender',type:'address'},{name:'nonce',type:'uint256'},
      {name:'initCode',type:'bytes'},{name:'callData',type:'bytes'},
      {name:'accountGasLimits',type:'bytes32'},{name:'preVerificationGas',type:'uint256'},
      {name:'gasFees',type:'bytes32'},{name:'paymasterAndData',type:'bytes'},
      {name:'signature',type:'bytes'}
    ]},
    {name:'userOpHash',type:'bytes32'}
  ],
  outputs:[{name:'',type:'uint256'}]
}] as const;

try {
  const r = await client.simulateContract({
    address: VALIDATOR,
    abi: validateAbi,
    functionName: 'validateFor7702',
    account: EOA,
    args: [{
      sender: EOA,
      nonce: 0n,
      initCode: '0x',
      callData: outerCalldata,
      accountGasLimits: ('0x'+'00'.repeat(32)) as `0x${string}`,
      preVerificationGas: 0n,
      gasFees: ('0x'+'00'.repeat(32)) as `0x${string}`,
      paymasterAndData: '0x',
      signature: sig
    }, ('0x'+'00'.repeat(32)) as `0x${string}`]
  });
  console.log('simulateContract result:', r.result, '(0=success, 1=fail)');
} catch(e: any) {
  console.error('ERROR:', e.message?.substring(0, 600));
  if (e.cause) console.error('CAUSE:', String(e.cause).substring(0, 600));
}
