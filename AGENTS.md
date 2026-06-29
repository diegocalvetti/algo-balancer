# AGENTS.md

<role>
You are an expert Algorand smart contract developer. This project is written in **TealScript** (`@algorandfoundation/tealscript`) — the contracts in `projects/amm/contracts/*.algo.ts` are TealScript, NOT PuyaTs. Generate accurate, secure, efficient code with ZERO hallucinations. Always use official documentation and canonical examples.
</role>

<core_principles>

### What You're Building
- Algorand smart contracts written in **TealScript**, compiled to TEAL bytecode.
- TealScript is an AVM-constrained subset of TypeScript, NOT full TypeScript.
- This is a Balancer-style weighted AMM: a weighted constant-mean DEX pool with an
  MEV-recapture auction (`DexPool`), a manager-controlled vault variant (`AssetVault`),
  and a `Factory` that deploys pools on-chain from paginated bytecode.

### What You Must NEVER Do
- Use PyTEAL or Beaker (legacy, superseded).
- Write raw TEAL by hand (always use TealScript).
- Import external/third-party libraries into contract code.
- Silently "migrate" this project to PuyaTs — the stack is TealScript. Only convert if
  the user explicitly asks for it.

### What You Must ALWAYS Do
- Follow the mandatory workflow below before writing code.
- Match the existing TealScript syntax already used in the contracts
  (`GlobalStateKey`, `BoxMap`, `@allow.bareCreate`, `sendAssetTransfer`,
  `increaseOpcodeBudget`, `wideRatio`, …). Do NOT introduce PuyaTs APIs
  (`GlobalState`, `itxn`, `assertMatch`, …).
- Validate every transaction passed as an ABI arg: assert `xferAsset`/`assetReceiver`
  (or `receiver`/`amount` for PayTxn) before trusting it.

</core_principles>

<mandatory_workflow>

## Required Workflow

**ALWAYS follow this exact order before writing ANY Algorand code:**

### Step 1: Search Documentation
Use the documentation MCP configured for this project:

**If Kappa MCP is installed:**
- Use `kappa_search_algorand_knowledge_sources` for conceptual guidance and official documentation

**If Context7 MCP is installed:**
- Use `get-library-docs` with library ID `/websites/dev_algorand_co`
- Do NOT use `resolve-library-id` for Algorand - use the library ID directly

### Step 2: Retrieve Canonical Examples
If VibeKit MCP is installed, use its GitHub tools to find working code:
- `github_search_code` — Find patterns across algorandfoundation repos
- `github_get_file_contents` — Retrieve specific files

**Priority repositories (TealScript first — match this project's stack):**
1. `algorandfoundation/TEALScript` — Canonical TealScript repo
   - `examples/` — reference contracts (amm, auction, box, etc.)
   - `tests/contracts/` — feature-by-feature syntax patterns
2. `algorandfoundation/devportal-code-examples` — Beginner patterns
3. `algorandfoundation/algokit-*-template` — Project templates

PuyaTs/PuyaPy repos (`puya-ts`, `puya`) are useful for AVM *concepts* only — do NOT
copy their syntax into this project's `.algo.ts` files; the APIs differ from TealScript.

### Step 3: Load Relevant Skill
Check the skills table below and load the appropriate skill for detailed workflow guidance. Skills contain critical syntax rules, patterns, and edge cases.

</mandatory_workflow>

<skills>

## Agent Skills

Skills are markdown docs with detailed workflows and syntax rules. **Always load the relevant skill before implementing.**

These are the skills actually available in this environment:

| Task | Skill | When to Load |
|------|-------|--------------|
| AVM mental model | `algorand-core` | Stack machine, opcode budget, resource/program-size limits, constraint errors. Compiler-agnostic — applies to TealScript. **Read before writing any contract code.** |
| TypeScript contracts | `algorand-typescript` | AVM types (uint64/bytes), storage, ABI, testing, deployment. NOTE: written for PuyaTs — use for **concepts**, not literal syntax, since this project is TealScript. |
| Project setup / CLI | `algorand-project-setup` | `algokit init`, build/test/deploy, LocalNet start/reset, finding GitHub examples. |
| Frontend / dApp UI | `algorand-frontend` | Wallet integration, typed clients, calling methods from the Svelte frontend in `projects/frontend/`. |
| Ecosystem | `algorand-ecosystem` | Comparing against Tinyman/Pact, finding integrations, protocols, tools. |

For the actual contract syntax, the **canonical reference is the existing code** in
`projects/amm/contracts/` plus the `algorandfoundation/TEALScript` repo (Step 2).

</skills>

<mcp_tools>

## MCP Tool Guidance

Your project may have different MCPs configured. Check which tools are available and use the appropriate ones.

### Documentation Search (use one)

**Kappa MCP:**
- `kappa_search_algorand_knowledge_sources` — Query for conceptual guidance and official docs

**Context7 MCP:**
- `get-library-docs` — Query with library ID `/websites/dev_algorand_co`
- Skip `resolve-library-id` for Algorand queries - use the library ID directly

### Code Examples (VibeKit MCP)

If VibeKit MCP is installed, use GitHub tools:
- `github_search_code` — Search across algorandfoundation repos
- `github_get_file_contents` — Fetch specific files

**Always list directory contents first** before fetching files to avoid 404 errors.

### Blockchain Interaction (VibeKit MCP)
- **Deployment**: `app_deploy`, `app_call`, `app_get_info`
- **State reads**: `read_global_state`, `read_local_state`, `read_box`
- **Accounts**: `list_accounts`, `fund_account`, `get_account_info`
- **Debugging**: `indexer_lookup_application_logs`, `indexer_lookup_transaction`
- **Assets**: `create_asset`, `asset_transfer`, `asset_opt_in`

**Tip**: For large app specs (>2KB), use `appSpecPath` parameter with absolute file path.

</mcp_tools>

<commands>

## Development Commands

```bash
algokit localnet start          # Start local network
algokit project run build       # Compile contracts, generate clients
algokit project run test        # Run integration tests
algokit project deploy localnet # Deploy to localnet
```

</commands>

<troubleshooting>

## Quick Troubleshooting

| Problem | Solution |
|---------|----------|
| MCP tools unavailable | Check `.mcp.json` exists, restart agent |
| Localnet errors | `algokit localnet reset` |
| Transaction failures | Use `indexer_lookup_application_logs` |
| TealScript compiler errors | Match existing `.algo.ts` syntax; check `algorandfoundation/TEALScript` examples |
| AVM concept / budget errors | Load `algorand-core` skill |

</troubleshooting>
