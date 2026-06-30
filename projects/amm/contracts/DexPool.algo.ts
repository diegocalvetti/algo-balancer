import { Contract } from '@algorandfoundation/tealscript';

const TOTAL_LP_SUPPLY = 10 ** 16;
const AMOUNT_LP_DEPLOYER = 1_000_000 * 10 ** 6;
const SCALE = 1_000_000;
const MIN_WEIGHT = 10_000;

/**
 * Maximum fee rate the arbitrageur can set for traders (10% = 100_000 / SCALE).
 * Protects traders from an adversarial or misconfigured arbitrageur effectively
 * halting organic trading by setting an unreasonably high fee.
 */
const MAX_FEE_RATE = 100_000;

/**
 * Default fee rate applied when no arbitrageur is active — e.g. during the
 * bidding window before the first settled epoch, or after an uncontested auction.
 * Set to 0.3% to match the Uniswap v2 convention.
 */
const DEFAULT_FEE_RATE = 3_000;

export class DexPool extends Contract {
  // ─── Pool state ───────────────────────────────────────────────────────────

  manager = GlobalStateKey<Address>({ key: 'manager' });

  token = GlobalStateKey<AssetID>({ key: 'token' });

  burned = GlobalStateKey<uint64>({ key: 'burned' });

  assets = GlobalStateKey<AssetID[]>({ key: 'assets' });

  weights = BoxMap<uint64, uint64>({ prefix: 'weights_' });

  targetWeights = BoxMap<uint64, uint64>({ prefix: 'target_weights_' });

  balances = BoxMap<AssetID, uint64>({ prefix: 'balances_' });

  provided = BoxMap<Address, uint64[]>({ prefix: 'provided_', dynamicSize: true });

  startRound = GlobalStateKey<uint64>({ key: 'start_round' });

  endRound = GlobalStateKey<uint64>({ key: 'end_round' });

  // ─── Auction state ────────────────────────────────────────────────────────

  /**
   * Length of each arbitrageur epoch in blocks. Stored at bootstrap so that
   * settleAuction() can schedule the next epoch without external input.
   */
  epochDuration = GlobalStateKey<uint64>({ key: 'epoch_duration' });

  /**
   * Length of the bidding window in blocks. Stored so that settleAuction()
   * can open the next auction window without requiring a manager call.
   */
  auctionDuration = GlobalStateKey<uint64>({ key: 'auction_duration' });

  /**
   * Round at which the current bidding window closes.
   * Bids are rejected once globals.round > auctionEnd.
   */
  auctionEnd = GlobalStateKey<uint64>({ key: 'auction_end' });

  /**
   * Round at which the current epoch ends. The arbitrageur's exclusive rights
   * (fee-free swaps, fee-rate control) expire after this round.
   */
  epochEnd = GlobalStateKey<uint64>({ key: 'epoch_end' });

  /**
   * Address of the arbitrageur who won the most recently settled auction.
   * Set to zeroAddress when no auction has been settled yet or when an
   * auction received no bids.
   */
  currentArbitrageur = GlobalStateKey<Address>({ key: 'current_arbitrageur' });

  /** Highest ALGO bid (in microALGO) received during the current bidding window. */
  highestBid = GlobalStateKey<uint64>({ key: 'highest_bid' });

  /**
   * Address of the current highest bidder. The corresponding ALGO is escrowed
   * in the contract until either outbid (refunded immediately) or the auction
   * is settled (added to rewardPool for LP holders to claim).
   */
  highestBidder = GlobalStateKey<Address>({ key: 'highest_bidder' });

  /**
   * Fee rate (scaled by SCALE) applied to ordinary trader swaps during the
   * current epoch. Controlled by the active arbitrageur via setFeeRate().
   * Falls back to DEFAULT_FEE_RATE when no arbitrageur is active.
   */
  feeRate = GlobalStateKey<uint64>({ key: 'fee_rate' });

  /**
   * Cumulative ALGO reward available to LP holders from all settled auctions.
   * Each settled auction adds the winning bid here. LP holders withdraw their
   * proportional share via claimAuctionReward().
   *
   * Using an explicit accumulator (rather than inferring from app.address.balance)
   * prevents contamination from minimum-balance changes or unrelated ALGO deposits.
   */
  rewardPool = GlobalStateKey<uint64>({ key: 'reward_pool' });

  // ─────────────────────────────────────────────────────────────────────────

  @allow.bareCreate('NoOp')
  createApplication() {
    this.manager.value = this.app.creator;
    this.startRound.value = 0;
    this.endRound.value = 0;
    this.feeRate.value = DEFAULT_FEE_RATE;
    this.highestBid.value = 0;
    this.highestBidder.value = globals.zeroAddress;
    this.currentArbitrageur.value = globals.zeroAddress;
    this.epochEnd.value = 0;
    this.auctionEnd.value = 0;
    this.rewardPool.value = 0;
  }

  // ─── Bootstrap ───────────────────────────────────────────────────────────

  /**
   * Initialise the pool, create the LP token, and open the first bidding window.
   *
   * The auction window opens immediately after bootstrap: arbitrageurs can start
   * bidding straight away. The first epoch begins only once settleAuction() is
   * called after the bidding window closes.
   *
   * Called by the Factory (the manager at entry); control is handed to `admin`,
   * who becomes the pool manager.
   *
   * @param assetIds        - Ordered list of ASA IDs to include in the pool.
   * @param weights         - Normalised weights for each asset (must sum to SCALE).
   * @param epochDuration   - Length of each arbitrageur epoch in blocks.
   * @param auctionDuration - Length of each bidding window in blocks (< epochDuration).
   * @param admin           - Account that becomes the pool manager.
   * @returns The ASA ID of the newly created LP token.
   */
  bootstrap(
    assetIds: AssetID[],
    weights: uint64[],
    epochDuration: uint64,
    auctionDuration: uint64,
    admin: Address
  ): AssetID {
    this.assertIsManager();

    assert(assetIds.length > 0, 'pool must have at least one asset');
    assert(assetIds.length <= SCALE / MIN_WEIGHT, 'too many tokens');
    assert(epochDuration > 0, 'epoch duration must be positive');
    assert(auctionDuration > 0, 'auction duration must be positive');
    assert(auctionDuration < epochDuration, 'auction window must be shorter than epoch');

    let sumOfWeights: uint64 = 0;

    for (let i = 0; i < assetIds.length; i += 1) {
      assert(weights[i] >= MIN_WEIGHT, 'weight too small');
      this.optIn(assetIds[i]);
      this.addToken(i, assetIds[i], weights[i]);
      sumOfWeights += weights[i];
    }

    assert(this.absDiff(sumOfWeights, SCALE) <= 1, 'weights must sum to 1');

    this.burned.value = 0;
    this.assets.value = assetIds;
    this.epochDuration.value = epochDuration;
    this.auctionDuration.value = auctionDuration;

    this.createToken();
    this.openAuction();

    // Hand control from the Factory to the human admin.
    this.manager.value = admin;

    return this.token.value;
  }

  // ─── Auction ──────────────────────────────────────────────────────────────

  /**
   * Submit a bid to become the next epoch's arbitrageur.
   *
   * The caller attaches an ALGO payment equal to their bid. If the bid exceeds
   * the current highest, the previous highest bidder is refunded immediately
   * and the new bid is escrowed in the contract. The bidding window must be open.
   *
   * Rational bidders will bid up to their expected epoch profit:
   *   E[profit] = E[arbitrage surplus] + E[fee revenue] - bid
   * The winning bid is therefore a market estimate of the arbitrage value that
   * would otherwise leak as uncontrolled MEV.
   *
   * @param payment - ALGO payment carrying the bid (receiver must be app address).
   */
  bid(payment: PayTxn): void {
    this.assertIsBootstrapped();
    assert(payment.receiver === this.app.address, 'payment must go to the pool');
    assert(payment.amount > this.highestBid.value, 'bid must exceed current highest bid');

    // First bid starts the countdown. Subsequent bids just replace the leader.
    if (this.highestBid.value === 0) {
      this.auctionEnd.value = globals.round + this.auctionDuration.value;
    }

    if (this.highestBidder.value !== globals.zeroAddress) {
      sendPayment({
        receiver: this.highestBidder.value,
        amount: this.highestBid.value,
      });
    }

    this.highestBid.value = payment.amount;
    this.highestBidder.value = payment.sender;
  }

  /**
   * Settle the auction after the bidding window closes and start the new epoch.
   *
   * Can be called by anyone once globals.round > auctionEnd. The open-call
   * design avoids a keeper role: any participant (including the winning bidder)
   * can trigger settlement.
   *
   * Steps:
   *   1. Install the highest bidder as the active arbitrageur for the new epoch.
   *   2. Add the winning bid to rewardPool, claimable by LP holders proportionally
   *      via claimAuctionReward().
   *   3. Start the new epoch (epochEnd) and immediately open the next bidding
   *      window so arbitrageurs can start competing for the following epoch.
   *
   * If no bid was received the pool runs without a designated arbitrageur:
   * DEFAULT_FEE_RATE applies and all traders interact freely.
   */
  settleAuction(): void {
    this.assertIsBootstrapped();
    assert(globals.round > this.auctionEnd.value, 'bidding window still open');

    if (this.highestBid.value > 0) {
      this.currentArbitrageur.value = this.highestBidder.value;
      this.rewardPool.value = this.rewardPool.value + this.highestBid.value;
    } else {
      // No bids: epoch runs without a designated arbitrageur.
      this.currentArbitrageur.value = globals.zeroAddress;
      this.feeRate.value = DEFAULT_FEE_RATE;
    }

    this.epochEnd.value = globals.round + this.epochDuration.value;

    // Reset bid state and immediately open the next bidding window,
    // so competition for epoch N+2 begins while epoch N+1 is running.
    this.highestBid.value = 0;
    this.highestBidder.value = globals.zeroAddress;
    this.openAuction();
  }

  /**
   * Claim a proportional share of the accumulated ALGO reward pool.
   *
   * LP holders prove their entitlement by transferring LP tokens to the contract.
   * The tokens are returned immediately — this is a balance-proof pattern, not a
   * burn. The claimable ALGO is:
   *
   *   claimable = rewardPool * (lpAmount / totalLP)
   *
   * This is a cumulative claim: waiting several epochs before claiming collects
   * the proportional share of all accumulated rewards. Per-epoch snapshots would
   * require storing LP balances at every epoch boundary, which is not feasible
   * on the AVM without external indexing, and are left as future work.
   *
   * @param lpTransfer - LP token transfer to the app address (balance proof).
   */
  claimAuctionReward(lpTransfer: AssetTransferTxn): void {
    this.assertIsBootstrapped();

    assert(lpTransfer.xferAsset === this.token.value, 'must transfer LP token');
    assert(lpTransfer.assetReceiver === this.app.address, 'LP tokens must go to the pool');
    assert(lpTransfer.assetAmount > 0, 'must transfer a positive LP amount');

    const callerLP = lpTransfer.assetAmount;
    const totalLP = this.totalLP();
    const pool = this.rewardPool.value;

    assert(pool > 0, 'no rewards to claim');

    const claimable = wideRatio([callerLP, pool], [totalLP]);
    assert(claimable > 0, 'claimable amount rounds to zero');

    // Deduct before sending: AVM is synchronous but the pattern is still correct.
    this.rewardPool.value = pool - claimable;

    // Return the LP tokens — sent only as a balance proof.
    sendAssetTransfer({
      assetReceiver: lpTransfer.sender,
      assetAmount: callerLP,
      xferAsset: this.token.value,
    });

    sendPayment({
      receiver: lpTransfer.sender,
      amount: claimable,
    });
  }

  // ─── Fee rate control ─────────────────────────────────────────────────────

  /**
   * Set the fee rate for ordinary trader swaps during the current epoch.
   * Only the active arbitrageur may call this, and only while their epoch is live.
   * Capped at MAX_FEE_RATE to prevent the arbitrageur from eliminating organic flow.
   *
   * @param rate - New fee rate scaled by SCALE (e.g. 3_000 = 0.3%).
   */
  setFeeRate(rate: uint64): void {
    this.assertIsArbitrageur();
    assert(rate <= MAX_FEE_RATE, 'fee rate exceeds maximum allowed');
    this.feeRate.value = rate;
  }

  // ─── Core pool operations ─────────────────────────────────────────────────

  addLiquidity(index: uint64, txn: AssetTransferTxn) {
    this.assertIsBootstrapped();
    this.tryFinalizeWeights();

    const sender = txn.sender;
    const amount = txn.assetAmount;
    const assetId = this.assets.value[index];

    this.optIn(assetId);
    this.balances(assetId).value += amount;

    if (!this.provided(sender).exists) {
      this.provided(sender).create((this.assets.value.length + 1) * 8);
    }

    this.provided(sender).value[index] += amount;
  }

  getLiquidity(): uint64 {
    this.assertIsBootstrapped();
    this.tryFinalizeWeights();

    const sender = this.txn.sender;
    let amount: uint64 = 0;

    if (this.totalLP() === 0) {
      // First deposit sets the initial pool; every asset must be seeded so the
      // pool never starts with a zero balance (which would break swaps and joins).
      for (let i = 0; i < this.assets.value.length; i += 1) {
        assert(this.balances(this.assets.value[i]).value > 0, 'first deposit must seed every asset');
      }
      amount = AMOUNT_LP_DEPLOYER;
    } else {
      amount = this.computeNAssetsLiquidity(sender);
    }

    for (let i = 0; i < this.provided(sender).value.length; i += 1) {
      this.provided(sender).value[i] = 0;
    }

    sendAssetTransfer({
      assetReceiver: sender,
      assetAmount: amount,
      xferAsset: this.token.value,
    });

    return amount;
  }

  burnLiquidity(transferTxn: AssetTransferTxn) {
    this.assertIsBootstrapped();
    this.tryFinalizeWeights();

    const sender = this.txn.sender;
    const amountLP = transferTxn.assetAmount;

    assert(amountLP > 0, 'must burn positive amount');

    // Redeem against the supply circulating before this burn. The incoming LP is
    // already in the reserve (so totalLP() excludes it); add it back as the denominator.
    const totalLP = this.totalLP() + amountLP;
    const numAssets = this.assets.value.length;

    for (let i = 0; i < numAssets; i += 1) {
      const assetId = this.assets.value[i];
      const poolBalance = this.balances(assetId).value;
      const assetAmount = wideRatio([amountLP, poolBalance], [totalLP]);

      this.balances(assetId).value = poolBalance - assetAmount;

      sendAssetTransfer({
        assetReceiver: sender,
        assetAmount: assetAmount,
        xferAsset: assetId,
      });
    }
  }

  /**
   * Execute a token swap against the pool.
   *
   * Fee logic:
   *   - The active arbitrageur trades fee-free (effectiveFee = 0), allowing
   *     profitable correction of price discrepancies with external markets.
   *   - All other callers pay feeRate (set by the arbitrageur; DEFAULT_FEE_RATE
   *     when no arbitrageur is active).
   *
   * Fee revenue stays inside the pool: the full amountIn enters the balance,
   * growing the invariant V. The arbitrageur captures this growth indirectly
   * by holding LP tokens or by withdrawing via burnLiquidity at epoch end.
   *
   * @param from         - Index of the input asset.
   * @param to           - Index of the output asset.
   * @param minAmountOut - Slippage guard: reverts if computed output < this value.
   * @param transferTxn  - Asset transfer carrying the input amount.
   * @returns The output amount transferred to the caller.
   */
  swap(from: uint64, to: uint64, minAmountOut: uint64, transferTxn: AssetTransferTxn): uint64 {
    this.assertIsBootstrapped();
    this.tryFinalizeWeights();
    increaseOpcodeBudget();

    const sender = transferTxn.sender;
    const amount = transferTxn.assetAmount;

    const assetIn = this.assets.value[from];
    const assetOut = this.assets.value[to];

    const balanceIn = this.balances(assetIn).value;
    const balanceOut = this.balances(assetOut).value;

    const weightIn = this.getCurrentWeight(from);
    const weightOut = this.getCurrentWeight(to);

    // Arbitrageur gets fee-free access; everyone else pays the current feeRate.
    const effectiveFee = sender === this.currentArbitrageur.value ? 0 : this.feeRate.value;

    const amountOut = this.calcOut(balanceIn, weightIn, balanceOut, weightOut, amount, effectiveFee);

    assert(amountOut >= minAmountOut, 'slippage exceeded');

    this.balances(assetIn).value = balanceIn + amount;
    this.balances(assetOut).value = balanceOut - amountOut;

    sendAssetTransfer({
      assetReceiver: sender,
      assetAmount: amountOut,
      xferAsset: assetOut,
    });

    return amountOut;
  }

  changeWeights(duration: uint64, newWeights: uint64[]): uint64 {
    this.assertIsManager();
    this.assertIsBootstrapped();
    this.assertNoWeightTransition();

    assert(newWeights.length === this.assets.value.length, 'weights length must match assets');

    let sumOfWeights: uint64 = 0;
    for (let i = 0; i < newWeights.length; i += 1) {
      assert(newWeights[i] >= MIN_WEIGHT, 'weight too small');
      sumOfWeights += newWeights[i];
    }
    assert(this.absDiff(sumOfWeights, SCALE) <= 1, 'weights must sum to 1');

    if (duration === 0) {
      this.startRound.value = 0;
      this.endRound.value = 0;
      for (let i = 0; i < newWeights.length; i += 1) {
        this.weights(i).value = newWeights[i];
      }
    } else {
      const currentRound = globals.round;
      this.startRound.value = currentRound;
      this.endRound.value = currentRound + duration;
      for (let i = 0; i < newWeights.length; i += 1) {
        this.targetWeights(i).value = newWeights[i];
      }
    }

    return this.endRound.value;
  }

  addAsset(asset: AssetID, w: uint64): uint64 {
    const newIndex = this.assets.value.length;
    this.assets.value[newIndex] = asset;

    for (let i = 0; i < newIndex; i += 1) {
      this.weights(i).value = wideRatio([this.weights(i).value, SCALE - w], [SCALE]);
    }

    this.weights(newIndex).value = w;
    return w;
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  /** Open a new bidding window from the current round. */
  private openAuction(): void {
    // Reset to 0 = open indefinitely until the first bid arrives.
    this.auctionEnd.value = 0;
  }

  private tryFinalizeWeights() {
    if (this.endRound.value !== 0 && globals.round >= this.endRound.value) {
      for (let i = 0; i < this.assets.value.length; i += 1) {
        this.weights(i).value = this.targetWeights(i).value;
      }
      this.startRound.value = 0;
      this.endRound.value = 0;
    }
  }

  private optIn(assetId: AssetID): void {
    if (this.app.address.isOptedInToAsset(assetId)) return;
    sendAssetTransfer({
      assetReceiver: this.app.address,
      xferAsset: assetId,
      assetAmount: 0,
    });
  }

  private addToken(index: uint64, assetID: AssetID, weight: uint64): void {
    if (!this.weights(index).exists) this.weights(index).create(8);
    if (!this.balances(assetID).exists) this.balances(assetID).create(8);
    this.weights(index).value = weight;
    this.balances(assetID).value = 0;
  }

  private createToken(): void {
    if (this.token.value === AssetID.zeroIndex) {
      this.token.value = sendAssetCreation({
        configAssetTotal: TOTAL_LP_SUPPLY,
        configAssetDecimals: 6,
        configAssetReserve: this.app.address,
        configAssetManager: this.app.address,
        configAssetClawback: globals.zeroAddress,
        configAssetFreeze: globals.zeroAddress,
        configAssetDefaultFrozen: 0,
        configAssetName: 'DexPool-' + this.app.id.toString(),
        configAssetUnitName: 'LP',
      });
    }
  }

  private assertIsManager(): void {
    assert(this.txn.sender === this.manager.value, 'only the manager can call this method');
  }

  private assertIsBootstrapped(): void {
    assert(this.token.value !== AssetID.zeroIndex, 'pool not bootstrapped');
  }

  private assertNoWeightTransition(): void {
    assert(this.startRound.value === 0 && this.endRound.value === 0, 'weight transition in progress');
  }

  private assertIsArbitrageur(): void {
    assert(this.currentArbitrageur.value !== globals.zeroAddress, 'no active arbitrageur');
    assert(this.txn.sender === this.currentArbitrageur.value, 'only the arbitrageur can call this');
    assert(globals.round <= this.epochEnd.value, 'arbitrageur epoch has ended');
  }

  private lnWithSign(x: uint64): uint64[] {
    assert(x > 0, 'log undefined for x <= 0');

    let negative: uint64 = 0;
    let z: uint64;

    if (x < SCALE) {
      negative = 1;
      const invX = wideRatio([SCALE, SCALE], [x]);
      z = wideRatio([invX - SCALE, SCALE], [invX]);
    } else {
      z = wideRatio([x - SCALE, SCALE], [x]);
    }

    let result = z;
    let term = z;
    let neg = false;

    increaseOpcodeBudget();

    for (let i = 2; i <= 10; i = i + 1) {
      term = wideRatio([term, z], [SCALE]);
      const delta = wideRatio([term], [i]);
      result = neg ? result - delta : result + delta;
      neg = !neg;
    }

    return [negative, result];
  }

  private exp(x: uint64): uint64 {
    let result = SCALE;
    let term = SCALE;

    for (let i = 1; i <= 10; i = i + 1) {
      term = wideRatio([term, x], [i * SCALE]);
      result += term;
    }

    return result;
  }

  private pow(x: uint64, y: uint64): uint64 {
    if (x === 0) return 0;

    const lnXResult = this.lnWithSign(x);
    const negativeLn = lnXResult[0];
    const lnX = lnXResult[1];

    const ylnX = wideRatio([y, lnX], [SCALE]);
    const expResult = this.exp(ylnX);

    if (negativeLn === 1) {
      return wideRatio([SCALE, SCALE], [expResult]);
    }

    return expResult;
  }

  /**
   * Core swap output formula derived from the weighted constant mean invariant:
   *
   *   amountOut = balanceOut * (1 - (balanceIn / (balanceIn + amountInWithFee)) ^ (wIn/wOut))
   *
   * fee is passed explicitly so the same function serves both the arbitrageur
   * (fee = 0) and ordinary trader (fee = feeRate) code paths.
   */
  private calcOut(
    balanceIn: uint64,
    weightIn: uint64,
    balanceOut: uint64,
    weightOut: uint64,
    amountIn: uint64,
    fee: uint64
  ): uint64 {
    const amountInWithFee = fee === 0 ? amountIn : wideRatio([amountIn, SCALE - fee], [SCALE]);

    const ratio = wideRatio([balanceIn, SCALE], [balanceIn + amountInWithFee]);
    const power = wideRatio([weightIn, SCALE], [weightOut]);
    const ratioPow = this.pow(ratio, power);

    return wideRatio([balanceOut, SCALE - ratioPow], [SCALE]);
  }

  private computeNAssetsLiquidity(sender: Address): uint64 {
    const totalAssets = this.assets.value.length;
    assert(totalAssets >= 1, 'provide at least one asset');

    let ratio = SCALE;
    let referenceRatio: uint64 = 0;

    for (let i = 0; i < totalAssets - 1; i += 1) {
      increaseOpcodeBudget();
    }

    for (let i = 0; i < totalAssets; i += 1) {
      const assetId = this.assets.value[i];
      const poolBalance = this.balances(assetId).value;
      const providedAmount = this.provided(sender).value[i];
      const weight = this.getCurrentWeight(i);

      assert(poolBalance > 0, 'pool balance must be > 0');

      // Fraction by which this asset's balance grows.
      const assetRatio = wideRatio([providedAmount, SCALE], [poolBalance - providedAmount]);

      // All assets must grow by the same fraction (0.5% tolerance for rounding),
      // otherwise the deposit is not invariant-preserving and is rejected — which
      // also blocks single-sided deposits.
      if (i === 0) {
        referenceRatio = assetRatio;
      } else {
        assert(
          this.absDiff(assetRatio, referenceRatio) <= referenceRatio / 200,
          'deposit must be proportional to pool balances'
        );
      }

      const powed = this.pow(assetRatio, weight);
      ratio = wideRatio([ratio, powed], [SCALE]);

      this.provided(sender).value[i] = 0;
    }

    return wideRatio([this.totalLP(), ratio], [SCALE]);
  }

  private totalLP(): uint64 {
    return this.token.value.total - this.token.value.reserve.assetBalance(this.token.value) - this.burned.value;
  }

  private absDiff(a: uint64, b: uint64): uint64 {
    return a > b ? a - b : b - a;
  }

  // ─── Read-only interface ──────────────────────────────────────────────────

  @abi.readonly
  getTotalAssets(): uint64 {
    return this.assets.value.length;
  }

  @abi.readonly
  getToken(): AssetID {
    return this.token.value;
  }

  @abi.readonly
  getWeight(index: uint64): uint64 {
    return this.weights(index).value;
  }

  @abi.readonly
  getBalance(index: uint64): uint64 {
    return this.balances(this.assets.value[index]).value;
  }

  @abi.readonly
  estimateSwap(from: uint64, to: uint64, amount: uint64): uint64 {
    const assetIn = this.assets.value[from];
    const assetOut = this.assets.value[to];
    return this.calcOut(
      this.balances(assetIn).value,
      this.getCurrentWeight(from),
      this.balances(assetOut).value,
      this.getCurrentWeight(to),
      amount,
      this.feeRate.value
    );
  }

  @abi.readonly
  getCurrentWeight(index: uint64): uint64 {
    const current = globals.round;
    const start = this.startRound.value;
    const end = this.endRound.value;

    if (current <= start || start === 0 || end === 0) return this.weights(index).value;
    if (current >= end) return this.targetWeights(index).value;

    const elapsed = current - start;
    const total = end - start;
    const w0 = this.weights(index).value;
    const w1 = this.targetWeights(index).value;
    const delta = w1 > w0 ? w1 - w0 : w0 - w1;
    const offset = wideRatio([delta, elapsed], [total]);

    return w1 > w0 ? w0 + offset : w0 - offset;
  }

  @abi.readonly
  getTimes(): uint64[] {
    return [this.startRound.value, this.endRound.value, globals.round];
  }

  /**
   * Returns current auction and epoch state.
   * [auctionEnd, epochEnd, highestBid, feeRate, rewardPool, currentRound]
   */
  @abi.readonly
  getAuctionState(): uint64[] {
    return [
      this.auctionEnd.value,
      this.epochEnd.value,
      this.highestBid.value,
      this.feeRate.value,
      this.rewardPool.value,
      globals.round,
    ];
  }

  opUp(): void {}
}
