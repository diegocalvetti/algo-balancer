# 🧮 Balancer-style AMM on Algorand

## 🛠️ Installation

```bash
# Prerequisites:
# - Node.js 22+
# - AlgoKit CLI

# Install dependencies
npm i
```
## ⚙️ Compile & Setup

```bash
# Compile all the contracts
npm run build
```

```bash
# Clone the example env
cp .env.example .env
```


**Balancer** is a lightweight Automated Market Maker (AMM) smart contract built on Algorand, designed for local testing and experimentation.

---

## 🚀 Run

You can try the Balancer in two different ways:

---

### 1. Manual mode with a LocalNet account

> Ideal to explore and interact with the contract manually.

#### 🔧 Requirements
- Algorand LocalNet running
- A funded account on LocalNet
- A `.env` file containing your private key:

```env
# .env
SECRET_KEY="your_mnemonic_or_private_key"
```

#### 🧑‍💻 Launch interactive shell

```bash
npm run execute
```

This opens a custom interactive shell where you can call contract functions and observe the AMM logic in action.

---

### 🧪 2. Automated test execution with Jest

> Ideal to verify that everything works with minimal setup.

#### ▶️ Run the tests

```bash
npm run test
```

During test execution:

- Test accounts are automatically created
- The contract is deployed on LocalNet
- Core logic is verified without requiring a `.env` file or manual setup


> **Important:** The tests must be executed in the defined order.

- The **first test** is responsible for **deploying the Factory contract**, which is then used by the **following tests** to deploy and interact with various AMM pools.
- Skipping or isolating tests without the Factory deployment will result in failures or undefined behavior.
If you're running individual tests, make sure the factory has already been deployed — or run the full suite in sequence.
---
The test suite included in this project should be considered **feature tests**, not unit tests.

- ✅ They **deploy real smart contracts** on a running LocalNet instance, they perform **real transactions** and **state changes**.
- ❌ They do **not use mocks or stubs** — the behavior tested reflects actual contract execution on Algorand's local environment.

## 📁 Project Structure

```bash
/contracts       → Smart contract code (TEALScript)
/scripts         → Runnable scripts
/helpers         → Helpers method to interact with the chain
/__test__        → Jest test suite
```

