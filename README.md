# 🧮 Algokit AMM Balancer

This project is an experimental [AlgoKit](https://github.com/algorandfoundation/algokit-cli)-based smart contract implementing a **Balancer-inspired Automated Market Maker (AMM)** on Algorand.

It allows the creation of multi-asset liquidity pools with weighted assets, LP token minting, and proportional burning mechanics.

> ⚠️ This project is a technical prototype and not production-ready.

##  Features

- **Weighted Liquidity Pools** — Create pools with arbitrary weights (e.g. 80/20, 50/50, etc.)
- **LP Token Minting**
  - Proportional multi-asset contribution (Balancer-style)
  - Single-asset liquidity support (simulates internal swap penalty)
- **Token Swapping** — Constant mean market maker logic with weight-aware pricing
- **Liquidity Burn** — Burn LP tokens to redeem a proportional share of all pool assets

This root directory is an orchestrated collection of standalone projects (backends, smart contracts, frontend apps and etc).

## Getting Started

To get started refer to `README.md` files in respective sub-projects in the `projects` directory.
