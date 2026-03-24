# 🧮 Balancer-style AMM on Algorand

An experimental AMM protocol built with [AlgoKit](https://github.com/algorandfoundation/algokit-cli),
inspired by Balancer's weighted pool model and extended with a novel
**auction-based arbitrage mechanism**. See the [Main README](./../README.md) for a
full overview of the protocol design.

---

## 🛠️ Prerequisites

- [Node.js 22+](https://nodejs.org/)
- [AlgoKit CLI](https://github.com/algorandfoundation/algokit-cli) — installation [official guide](https://developer.algorand.org/docs/get-started/algokit/)

---

## ⚙️ Setup
```bash
# Install dependencies
npm i

# Compile all contracts
npm run build

# Copy the example environment file
cp .env.example .env
```

---

## 🌐 Start the local network

This project runs against **Algorand LocalNet** — a local single-node Algorand network managed by AlgoKit.
```bash
# Start LocalNet (first time may take some minutes to pull Docker images)
algokit localnet start

# Check status
algokit localnet status

# Stop when done
algokit localnet stop
```

> LocalNet requires Docker to be running. Make sure Docker Desktop is open before starting.

---

## 🚀 Run

### 1. Interactive shell (manual exploration)

Ideal for exploring and interacting with the contracts manually.

Add your LocalNet account mnemonic to `.env`:
```env
SECRET_KEY="word1 word2 word3 ..."
```

Then launch the interactive shell:
```bash
npm run execute
```

This opens a custom CLI where you can deploy pools, provide liquidity, execute swaps, and observe the AMM logic in action step by step.

---

### 2. Automated tests with Jest

> ⚠️ The automated test suite is currently broken while the auction mechanism (AWP) is being finalised. It will be restored in a future release.

Ideal to verify that everything works with minimal setup — no `.env` or manual configuration required.
```bash
npm run test
```

During test execution:
- Test accounts are automatically created and funded
- The Factory contract is deployed on LocalNet
- All core pool logic is verified through real on-chain transactions

> **Important:** tests must run in order. The first test deploys the Factory contract, which all subsequent tests depend on. Skipping or isolating individual tests without a deployed Factory will cause failures.

The test suite should be considered **feature tests**, not unit tests:
- ✅ Real smart contracts deployed on LocalNet, real transactions, real state changes
- ❌ No mocks or stubs — behavior reflects actual AVM execution

---

## 📁 Project Structure
```
/contracts     → Smart contract source code (TEALScript)
/helpers       → Chain interaction helpers
/scripts       → Runnable utility scripts
/__test__      → Jest feature test suite
```
