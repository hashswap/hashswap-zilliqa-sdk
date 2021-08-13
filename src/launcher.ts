import 'isomorphic-fetch'
import { Zilliqa } from '@zilliqa-js/zilliqa'
import { Wallet, Transaction, TxReceipt as _TxReceipt } from '@zilliqa-js/account'
import { Contract, Value, CallParams } from '@zilliqa-js/contract'
import { fromBech32Address, toBech32Address } from '@zilliqa-js/crypto'
import { StatusType, MessageType, NewEventSubscription } from '@zilliqa-js/subscriptions'
import { BN, Long, units } from '@zilliqa-js/util'
import { BigNumber } from 'bignumber.js'
import { Mutex } from 'async-mutex'

import { APIS, WSS, CONTRACTS, LAUNCHER, CHAIN_VERSIONS, BASIS, Network, ZIL_HASH, HUSD_HASH, ZERO_HASH } from './constants'
import { unitlessBigNumber, toPositiveQa, isLocalStorageAvailable } from './utils'
import { sendBatchRequest, BatchRequest } from './batch'

import { Options, OnUpdate, ObservedTx, TxStatus, TxReceipt, TxParams, Rates, WalletProvider, RPCBalanceResponse } from './index'

BigNumber.config({ EXPONENTIAL_AT: 1e9 }) // never!

export type TokenDetails = {
  contract: Contract // instance
  address: string
  hash: string
  symbol: string
  decimals: number
  registered: boolean // is in default token list
  whitelisted: boolean // is a verified token
}

export type ContractState = {
  influencer: { [key in string]?: string }
  launchs: { [key in string]?: { arguments: ReadonlyArray<string> } }
  sponsors: { [key in string]?: { [key2 in string]?: { arguments: ReadonlyArray<any> } } }
  zero_sponsor: { [key in string]?: { [key2 in string]?: { arguments: ReadonlyArray<any> } } }
  total_sponsorship: { [key in string]?: string }
}

export type AppState = {
  contractState: ContractState
  tokens: { [key in string]: TokenDetails }
  pools: { [key in string]?: Pool }
  currentUser: string | null
  currentNonce: number | null
  currentBalance: BigNumber | null
}

export type SponsorToken = {
  sponsorHusd: BigNumber
  removeHusd: BigNumber
  transactionFee: BigNumber
  entryBlock: BigNumber
  lockIn: BigNumber
}

export enum LaunchState {
  Undefined = 'Undefined',
  Validation = 'Validation',
  Open = 'Open',
  ToLaunch = 'ToLaunch',
  Launched = 'Launched',
  OnHold = 'OnHold',
  Dissolve = 'Dissolve',
}

export type Pool = {
  hashReserve: BigNumber
  tokenReserve: BigNumber
  exchangeRate: BigNumber // price set by influencer
  deadline: BigNumber
  state: LaunchState
  userSponsor: SponsorToken
  zeroSponsor: SponsorToken
  totalSponsor: BigNumber
}

export class Launcher {
  /* Zilliqa SDK */
  readonly zilliqa: Zilliqa

  /* Internals */
  private readonly rpcEndpoint: string
  private readonly walletProvider?: WalletProvider // zilpay
  private readonly tokens: { [key in string]: string } // symbol => hash mappings
  private appState?: AppState // cached blockchain state for dApp and user

  /* Txn observers */
  private subscription: NewEventSubscription | null = null
  private observer: OnUpdate | null = null
  private observerMutex: Mutex
  private observedTxs: ObservedTx[] = []

  /* Deadline tracking */
  private deadlineBuffer: number = 3
  private currentBlock: number = -1

  /* Zilswap contract attributes */
  readonly contract: Contract
  readonly contractAddress: string
  readonly contractHash: string

  /* Transaction attributes */
  readonly _txParams: TxParams = {
    version: -1,
    gasPrice: new BN(0),
    gasLimit: Long.fromNumber(5000),
  }

  /**
   * Creates the Zilswap SDK object. {@linkcode initalize} needs to be called after
   * the object is created to begin watching the blockchain's state.
   *
   * @param network the Network to use, either `TestNet` or `MainNet`.
   * @param walletProviderOrKey a Provider with Wallet or private key string to be used for signing txns.
   * @param options a set of Options that will be used for all txns.
   */
  constructor(readonly network: Network, walletProviderOrKey?: WalletProvider | string, options?: Options) {
    console.log('test1111')
    this.rpcEndpoint = options?.rpcEndpoint || APIS[network]
    if (typeof walletProviderOrKey === 'string') {
      this.zilliqa = new Zilliqa(this.rpcEndpoint)
      this.zilliqa.wallet.addByPrivateKey(walletProviderOrKey)
    } else if (walletProviderOrKey) {
      this.zilliqa = new Zilliqa(this.rpcEndpoint, walletProviderOrKey.provider)
      this.walletProvider = walletProviderOrKey
    } else {
      this.zilliqa = new Zilliqa(this.rpcEndpoint)
    }

    this.contractAddress = LAUNCHER[network]
    this.contract = (this.walletProvider || this.zilliqa).contracts.at(this.contractAddress)
    this.contractHash = fromBech32Address(this.contractAddress).toLowerCase()
    this.tokens = {}
    this._txParams.version = CHAIN_VERSIONS[network]

    if (options) {
      if (options.deadlineBuffer && options.deadlineBuffer > 0) this.deadlineBuffer = options.deadlineBuffer
      if (options.gasPrice && options.gasPrice > 0) this._txParams.gasPrice = toPositiveQa(options.gasPrice, units.Units.Li)
      if (options.gasLimit && options.gasLimit > 0) this._txParams.gasLimit = Long.fromNumber(options.gasLimit)
    }

    this.observerMutex = new Mutex()
    console.log('test11111122222222')
  }

  /**
   * Intializes the SDK, fetching a cache of the Zilswap contract state and
   * subscribing to subsequent state changes. You may optionally pass an array
   * of ObservedTx's to subscribe to status changes on any of those txs.
   *
   * @param subscription is the callback function to call when a tx state changes.
   * @param observedTx is the array of txs to observe.
   */
  public async initialize(subscription?: OnUpdate, observeTxs: ObservedTx[] = []) {
    console.log('test22222222')
    console.log(this)
    console.log('test22222222')
    this.observedTxs = observeTxs
    if (subscription) this.observer = subscription
    if (this._txParams.gasPrice.isZero()) {
      const minGasPrice = await this.zilliqa.blockchain.getMinimumGasPrice()
      if (!minGasPrice.result) throw new Error('Failed to get min gas price.')
      this._txParams.gasPrice = new BN(minGasPrice.result)
    }
    this.subscribeToAppChanges()
    await this.loadTokenList()
    await this.updateBlockHeight()
    await this.updateAppState()
    await this.updateBalanceAndNonce()
    console.log('test22222222')
    console.log(this)
    console.log('test22222222')
  }

  /**
   * Stops watching the Zilswap contract state.
   */
  public async teardown() {
    console.log('test5555555555555')
    this.subscription?.stop()

    const stopped = new Promise<void>(resolve => {
      const checkSubscription = () => {
        if (this.subscription) {
          setTimeout(checkSubscription, 100)
        } else {
          resolve()
        }
      }
      checkSubscription()
    })
    await stopped
  }

  /**
   * Gets the latest Zilswap app state.
   */
  public getAppState(): AppState {
    console.log('test6666666666666')
    if (!this.appState) {
      throw new Error('App state not loaded, call #initialize first.')
    }
    return this.appState
  }

  /**
   * Gets the contract with the given address that can be called by the default account.
   */
  public getContract(address: string): Contract {
    console.log('test777777777777777')
    return (this.walletProvider || this.zilliqa).contracts.at(address)
  }

  /**
   * Gets the pool details for the given `tokenID`.
   *
   * @param tokenID is the token ID for the pool, which can be given by either it's symbol (defined in constants.ts),
   * hash (0x...) or bech32 address (zil...).
   * @returns {Pool} if pool exists, or `null` otherwise.
   */
  public getPool(tokenID: string): Pool | null {
    console.log('test888888888888888888')
    if (!this.appState) {
      throw new Error('App state not loaded, call #initialize first.')
    }
    console.log(this.appState.pools[this.getTokenAddresses(tokenID).hash])
    return this.appState.pools[this.getTokenAddresses(tokenID).hash] || null
  }

  /**
   * Gets the currently observed transactions.
   */
  public async getObservedTxs(): Promise<ObservedTx[]> {
    const release = await this.observerMutex.acquire()
    try {
      return [...this.observedTxs]
    } finally {
      release()
    }
  }

  /**
   * Converts an amount to it's unitless representation (integer, no decimals) from it's
   * human representation (with decimals based on token contract, or 12 decimals for ZIL).
   * @param tokenID is the token ID related to the conversion amount, which can be given by either it's symbol (defined in constants.ts),
   * hash (0x...) or bech32 address (zil...). The hash for ZIL is represented by the ZIL_HASH constant.
   * @param amountHuman is the amount as a human string (e.g. 4.2 for 4.2 ZILs) to be converted.
   */
  public toUnitless(tokenID: string, amountHuman: string): string {
    const token = this.getTokenDetails(tokenID)
    const amountUnitless = new BigNumber(amountHuman).shiftedBy(token.decimals)
    if (!amountUnitless.integerValue().isEqualTo(amountUnitless)) {
      throw new Error(`Amount ${amountHuman} for ${token.symbol} has too many decimals, max is ${token.decimals}.`)
    }
    return amountUnitless.toString()
  }

  /**
   * Converts an amount to it's human representation (with decimals based on token contract, or 12 decimals for ZIL)
   * from it's unitless representation (integer, no decimals).
   * @param tokenID is the token ID related to the conversion amount, which can be given by either it's symbol (defined in constants.ts),
   * hash (0x...) or bech32 address (zil...). The hash for ZIL is represented by the ZIL_HASH constant.
   * @param amountStr is the unitless amount as a string (e.g. 42000000000000 for 42 ZILs) to be converted.
   */
  public toUnit(tokenID: string, amountStr: string): string {
    const token = this.getTokenDetails(tokenID)
    const amountBN = new BigNumber(amountStr)
    if (!amountBN.integerValue().isEqualTo(amountStr)) {
      throw new Error(`Amount ${amountStr} for ${token.symbol} cannot have decimals.`)
    }
    return amountBN.shiftedBy(-token.decimals).toString()
  }

  /**
   * Sets the number of blocks to use as the allowable buffer duration before transactions
   * are considered invalid.
   *
   * When a transaction is signed, the deadline block by adding the buffer blocks to
   * the latest confirmed block height.
   *
   * @param bufferBlocks is the number of blocks to use as buffer for the deadline block.
   */
  public setDeadlineBlocks(bufferBlocks: number) {
    if (bufferBlocks <= 0) {
      throw new Error('Buffer blocks must be greater than 0.')
    }
    this.deadlineBuffer = bufferBlocks
  }

  /**
   * Observes the given transaction until the deadline block.
   *
   * Calls the `OnUpdate` callback given during `initialize` with the updated ObservedTx
   * when a change has been observed.
   *
   * @param observedTx is the txn hash of the txn to observe with the deadline block number.
   */
  public async observeTx(observedTx: ObservedTx) {
    const release = await this.observerMutex.acquire()
    try {
      this.observedTxs.push(observedTx)
    } finally {
      release()
    }
  }

  /**
   * Approves allowing the Zilswap contract to transfer ZRC-2 token with `tokenID`, if the current
   * approved allowance is less than `amount`. If the allowance is sufficient, this method is a no-op.
   *
   * The approval is done by calling `IncreaseAllowance` with the allowance amount as the entire
   * token supply. This is done so that the approval needs to only be done once per token contract,
   * reducing the number of approval transactions required for users conducting multiple swaps.
   *
   * Non-custodial control of the token is ensured by the Zilswap contract itself, which does not
   * allow for the transfer of tokens unless explicitly invoked by the sender.
   *
   * The transaction is added to the list of observedTxs, and the observer will be notified on
   * a confirmation or rejection event. The transation will be assumed to be expired after the default
   * deadline buffer, even though there is no deadline block for this transaction.
   *
   * @param tokenID is the token ID for the pool, which can be given by either it's symbol (defined in constants.ts),
   * hash (0x...) or bech32 address (zil...).
   * @param amountStrOrBN is the required allowance amount the Zilswap contract requires, below which the
   * `IncreaseAllowance` transition is invoked, as a unitless string or BigNumber.
   * @param spenderHash (optional) is the spender contract address, defaults to the ZilSwap contract address.
   *
   * @returns an ObservedTx if IncreaseAllowance was called, null if not.
   */
  public async approveTokenTransferToLauncherIfRequired(tokenID: string, amountStrOrBN: BigNumber | string): Promise<ObservedTx | null> {
    // Check logged in
    this.checkAppLoadedWithUser()

    const spenderHash = this.contractHash
    const _spenderHash = this.parseRecipientAddress(spenderHash)
    const token = this.getTokenDetails(tokenID)
    const tokenState = await token.contract.getSubState('allowances', [this.appState!.currentUser!, _spenderHash])
    const allowance = new BigNumber(tokenState?.allowances[this.appState!.currentUser!]?.[_spenderHash] || 0)
    const amount: BigNumber = typeof amountStrOrBN === 'string' ? unitlessBigNumber(amountStrOrBN) : amountStrOrBN

    if (allowance.lt(amount)) {
      try {
        console.log('sending increase allowance txn..')
        const approveTxn = await this.callContract(
          token.contract,
          'IncreaseAllowance',
          [
            {
              vname: 'spender',
              type: 'ByStr20',
              value: _spenderHash,
            },
            {
              vname: 'amount',
              type: 'Uint128',
              value: amount.minus(allowance).toString(),
            },
          ],
          {
            amount: new BN(0),
            ...this.txParams(),
          },
          true
        )

        const observeTxn = {
          hash: approveTxn.id!,
          deadline: this.deadlineBlock(),
        }
        await this.observeTx(observeTxn)

        return observeTxn
      } catch (err) {
        if (err.message === 'Could not get balance') {
          throw new Error('No ZIL to pay for transaction.')
        } else {
          throw err
        }
      }
    }

    return null
  }

  /**
   * Remove liquidity from the pool with the given `tokenID`. The given `zilsToAddHuman` represents the exact quantity of ZIL
   * that will be contributed, while the given `tokensToAddHuman` represents the target quantity of ZRC-2 tokens to be
   * contributed.
   *
   * To ensure the liquidity contributor does not lose value to arbitrage, the target token amount should be strictly
   * derived from the current exchange rate that can be found using {@linkcode getPool}.
   *
   * The maximum fluctuation in exchange rate from the given parameters can be controlled through `maxExchangeRateChange`,
   * to protect against changes in pool reserves between the txn submission and txn confirmation on the Zilliqa blockchain.
   *
   * If the pool has no liquidity yet, the token amount given will be the exact quantity of tokens that will be contributed,
   * and the `maxExchangeRateChange` is ignored.
   *
   * The transaction is added to the list of observedTxs, and the observer will be notified on change in tx status.
   *
   * Note that all amounts should be given with decimals in it's human represented form, rather than as a unitless integer.
   *
   * @param tokenID is the token ID for the pool, which can be given by either it's symbol (defined in constants.ts),
   * hash (0x...) or bech32 address (zil...).
   * @param zilsToAddStr is the exact amount of zilliqas to contribute to the pool in ZILs as a unitless string.
   * @param tokensToAddStr is the target amount of tokens to contribute to the pool as a unitless string.
   * @param maxExchangeRateChange is the maximum allowed exchange rate flucuation
   * given in {@link https://www.investopedia.com/terms/b/basispoint.asp basis points}. Defaults to 200 = 2.00% if not provided.
   */
  public async ReplaceSponsor(tokenID: string, husdAmountStr: string): Promise<ObservedTx> {
    // Check logged in
    this.checkAppLoadedWithUser()

    // Calculate contribution
    const token = this.getTokenDetails(tokenID)
    const husdAmount = new BigNumber(husdAmountStr)
    const pool = this.getPool(token.hash)
    if (!pool) {
      throw new Error('Pool not found.')
    }

    console.log('77777777777777777777777777')
    console.log('77777777777777777777777777')
    console.log(pool)
    console.log('77777777777777777777777777')
    console.log('77777777777777777777777777')

    const { hashReserve, tokenReserve, zeroSponsor, state } = pool
    const { sponsorHusd, removeHusd, transactionFee, entryBlock, lockIn } = zeroSponsor

    // Set Deadline
    const deadline = this.deadlineBlock()

    console.log(state)

    let validReplaceTransaction = false
    let replaceSponsorToken = husdAmount
    if (sponsorHusd.isPositive() && state === LaunchState.Launched) {
      validReplaceTransaction = true
      console.log('Inside check zero sponsor and state')
      if (sponsorHusd.lt(husdAmount)) {
        console.log('Inside too much replace aponsor')
        replaceSponsorToken = sponsorHusd
      }
    }

    if (!validReplaceTransaction) {
      console.log('Inside launched state')
      throw new Error('Not a valid replace sponsorship transaction!')
    }

    // Sending Transaction
    console.log(replaceSponsorToken)
    console.log('sending replace sponsor txn..')
    const replaceSponsorTxn = await this.callContract(
      this.contract,
      'ReplaceSponsor',
      [
        {
          vname: 'token',
          type: 'ByStr20',
          value: token.hash,
        },
        {
          vname: 'husd_amount',
          type: 'Uint128',
          value: replaceSponsorToken.toString(),
        },
        {
          vname: 'deadline_block',
          type: 'BNum',
          value: deadline.toString(),
        },
      ],
      {
        amount: new BN(0), // _amount
        ...this.txParams(),
      },
      true
    )

    if (replaceSponsorTxn.isRejected()) {
      throw new Error('Submitted transaction was rejected.')
    }

    const observeTxn = {
      hash: replaceSponsorTxn.id!,
      deadline,
    }
    await this.observeTx(observeTxn)

    return observeTxn
  }

  /**
   * Remove liquidity from the pool with the given `tokenID`. The given `zilsToAddHuman` represents the exact quantity of ZIL
   * that will be contributed, while the given `tokensToAddHuman` represents the target quantity of ZRC-2 tokens to be
   * contributed.
   *
   * To ensure the liquidity contributor does not lose value to arbitrage, the target token amount should be strictly
   * derived from the current exchange rate that can be found using {@linkcode getPool}.
   *
   * The maximum fluctuation in exchange rate from the given parameters can be controlled through `maxExchangeRateChange`,
   * to protect against changes in pool reserves between the txn submission and txn confirmation on the Zilliqa blockchain.
   *
   * If the pool has no liquidity yet, the token amount given will be the exact quantity of tokens that will be contributed,
   * and the `maxExchangeRateChange` is ignored.
   *
   * The transaction is added to the list of observedTxs, and the observer will be notified on change in tx status.
   *
   * Note that all amounts should be given with decimals in it's human represented form, rather than as a unitless integer.
   *
   * @param tokenID is the token ID for the pool, which can be given by either it's symbol (defined in constants.ts),
   * hash (0x...) or bech32 address (zil...).
   * @param zilsToAddStr is the exact amount of zilliqas to contribute to the pool in ZILs as a unitless string.
   * @param tokensToAddStr is the target amount of tokens to contribute to the pool as a unitless string.
   * @param maxExchangeRateChange is the maximum allowed exchange rate flucuation
   * given in {@link https://www.investopedia.com/terms/b/basispoint.asp basis points}. Defaults to 200 = 2.00% if not provided.
   */

  public async RemoveSponsor(tokenID: string, sponsorTokensStr: string): Promise<ObservedTx> {
    // Check logged in
    this.checkAppLoadedWithUser()

    // Calculate contribution
    const token = this.getTokenDetails(tokenID)
    const sponsorToken = new BigNumber(sponsorTokensStr)
    const pool = this.getPool(token.hash)
    if (!pool) {
      throw new Error('Pool not found.')
    }

    console.log('77777777777777777777777777')
    console.log('77777777777777777777777777')
    console.log(pool)
    console.log('77777777777777777777777777')
    console.log('77777777777777777777777777')

    const { hashReserve, tokenReserve, userSponsor, state } = pool
    const { sponsorHusd, removeHusd, transactionFee, entryBlock, lockIn } = userSponsor

    // Set Deadline
    const deadline = this.deadlineBlock()

    const currentBlock = new BigNumber(this.getCurrentBlock())

    console.log(state)

    console.log(lockIn)

    console.log(currentBlock)

    let validRemoveTransaction = false
    let removeSponsorToken = new BigNumber(0)
    if (state === LaunchState.Dissolve && sponsorHusd.lt(sponsorToken)) {
      console.log('Inside Dissolve state')
      validRemoveTransaction = true
      removeSponsorToken = sponsorToken
    }

    if (state === LaunchState.Launched) {
      if (lockIn.isZero()) {
        if (sponsorToken.lte(sponsorHusd)) {
          console.log('Inside Launched state first remove')
          validRemoveTransaction = true
          removeSponsorToken = sponsorToken
        } else {
          throw new Error('Remove amount is more than sponsorship amount! ')
        }
      } else if (lockIn.lt(currentBlock)) {
        if (sponsorToken.lte(removeHusd)) {
          console.log('Inside Launched state lockin period')
          validRemoveTransaction = true
          removeSponsorToken = removeHusd
        } else {
          throw new Error('Remove amount is more than sponsorship amount but lockin is over! ')
        }
      } else {
        throw new Error('Remove sponsor loackin period is not over! ')
      }
    }

    if (!validRemoveTransaction) {
      console.log('Inside open state')
      throw new Error('Not a valid remove sponsorship transaction!')
    }

    // Sending Transaction
    console.log(removeSponsorToken)
    console.log('sending remove sponsor txn..')
    const removeSponsorTxn = await this.callContract(
      this.contract,
      'RemoveSponser',
      [
        {
          vname: 'token',
          type: 'ByStr20',
          value: token.hash,
        },
        {
          vname: 'sponser_tokens',
          type: 'Uint128',
          value: removeSponsorToken.toString(),
        },
        {
          vname: 'deadline_block',
          type: 'BNum',
          value: deadline.toString(),
        },
      ],
      {
        amount: new BN(0), // _amount
        ...this.txParams(),
      },
      true
    )

    if (removeSponsorTxn.isRejected()) {
      throw new Error('Submitted transaction was rejected.')
    }

    const observeTxn = {
      hash: removeSponsorTxn.id!,
      deadline,
    }
    await this.observeTx(observeTxn)

    return observeTxn
  }

  /**
   * Adds liquidity to the pool with the given `tokenID`. The given `zilsToAddHuman` represents the exact quantity of ZIL
   * that will be contributed, while the given `tokensToAddHuman` represents the target quantity of ZRC-2 tokens to be
   * contributed.
   *
   * To ensure the liquidity contributor does not lose value to arbitrage, the target token amount should be strictly
   * derived from the current exchange rate that can be found using {@linkcode getPool}.
   *
   * The maximum fluctuation in exchange rate from the given parameters can be controlled through `maxExchangeRateChange`,
   * to protect against changes in pool reserves between the txn submission and txn confirmation on the Zilliqa blockchain.
   *
   * If the pool has no liquidity yet, the token amount given will be the exact quantity of tokens that will be contributed,
   * and the `maxExchangeRateChange` is ignored.
   *
   * The transaction is added to the list of observedTxs, and the observer will be notified on change in tx status.
   *
   * Note that all amounts should be given with decimals in it's human represented form, rather than as a unitless integer.
   *
   * @param tokenID is the token ID for the pool, which can be given by either it's symbol (defined in constants.ts),
   * hash (0x...) or bech32 address (zil...).
   * @param zilsToAddStr is the exact amount of zilliqas to contribute to the pool in ZILs as a unitless string.
   * @param tokensToAddStr is the target amount of tokens to contribute to the pool as a unitless string.
   * @param maxExchangeRateChange is the maximum allowed exchange rate flucuation
   * given in {@link https://www.investopedia.com/terms/b/basispoint.asp basis points}. Defaults to 200 = 2.00% if not provided.
   */
  public async AddSponsor(tokenID: string, husdToAddStr: string): Promise<ObservedTx> {
    // Check logged in
    this.checkAppLoadedWithUser()

    // Format token amounts
    const token = this.getTokenDetails(tokenID)
    const husd = this.getTokenDetails(HUSD_HASH)
    const husdToAdd = new BigNumber(husdToAddStr)

    // Calculate allowances
    const pool = this.getPool(token.hash)
    const zilAmount = new BN(0)

    // Check HUSD balances
    await this.checkAllowedBalance(husd, husdToAdd)

    // Set Deadline
    const deadline = this.deadlineBlock()

    // Sending Transaction
    console.log('sending add liquidity txn..')
    const addSponsorTxn = await this.callContract(
      this.contract,
      'AddSponser',
      [
        {
          vname: 'token',
          type: 'ByStr20',
          value: token.hash,
        },
        {
          vname: 'husd_amount',
          type: 'Uint128',
          value: husdToAdd.toString(),
        },
        {
          vname: 'deadline_block',
          type: 'BNum',
          value: deadline.toString(),
        },
      ],
      {
        amount: zilAmount, // _amount
        ...this.txParams(),
      },
      true
    )

    if (addSponsorTxn.isRejected()) {
      throw new Error('Submitted transaction was rejected.')
    }

    const observeTxn = {
      hash: addSponsorTxn.id!,
      deadline,
    }
    await this.observeTx(observeTxn)

    return observeTxn
  }

  public async callContract(
    contract: Contract,
    transition: string,
    args: Value[],
    params: CallParams,
    toDs?: boolean
  ): Promise<Transaction> {
    if (this.walletProvider) {
      // ugly hack for zilpay provider
      const txn = await (contract as any).call(transition, args, params, toDs)
      txn.id = txn.ID
      txn.isRejected = function (this: { errors: any[]; exceptions: any[] }) {
        return this.errors.length > 0 || this.exceptions.length > 0
      }
      return txn
    } else {
      return await contract.callWithoutConfirm(transition, args, params, toDs)
    }
  }

  private subscribeToAppChanges() {
    // clear existing subscription, if any
    this.subscription?.stop()

    const subscription = this.zilliqa.subscriptionBuilder.buildEventLogSubscriptions(WSS[this.network], {
      addresses: [this.contractHash],
    })

    subscription.subscribe({ query: MessageType.NEW_BLOCK })

    subscription.emitter.on(StatusType.SUBSCRIBE_EVENT_LOG, event => {
      console.log('ws connected: ', event)
    })

    subscription.emitter.on(MessageType.NEW_BLOCK, event => {
      // console.log('ws new block: ', JSON.stringify(event, null, 2))
      this.updateBlockHeight().then(() => this.updateObservedTxs())
    })

    subscription.emitter.on(MessageType.EVENT_LOG, event => {
      if (!event.value) return
      // console.log('ws update: ', JSON.stringify(event, null, 2))
      this.updateAppState()
    })

    subscription.emitter.on(MessageType.UNSUBSCRIBE, event => {
      console.log('ws disconnected: ', event)
      this.subscription = null
    })

    subscription.start()

    this.subscription = subscription
  }

  private async loadTokenList() {
    if (this.network === Network.TestNet) {
      this.tokens['ZIL'] = 'zil1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq9yf6pz'
      this.tokens['ZWAP'] = 'zil1k2c3ncjfduj9jrhlgx03t2smd6p25ur56cfzgz'
      this.tokens['gZIL'] = 'zil1fytuayks6njpze00ukasq3m4y4s44k79hvz8q5'
      this.tokens['SWTH'] = 'zil1d6yfgycu9ythxy037hkt3phc3jf7h6rfzuft0s'
      this.tokens['XSGD'] = 'zil10a9z324aunx2qj64984vke93gjdnzlnl5exygv'
      this.tokens['ZLP'] = 'zil1du93l0dpn8wy40769raza23fjkvm868j9rjehn'
      this.tokens['PORT'] = 'zil10v5nstu2ff9jsm7074wer6s6xtklh9xga7n8xc'
      this.tokens['REDC'] = 'zil14jmjrkvfcz2uvj3y69kl6gas34ecuf2j5ggmye'
      this.tokens['STREAM'] = 'zil10w9gdtaau3d5uzqescshuqn9fd23gpa82myjqc'
      this.tokens['zDAI'] = 'zil1nnga67uer2vk0harvu345vz7vl3v0pta6vr3sf'
      this.tokens['zETH'] = 'zil1j53x0y8myrcpy6u4n42qe0yuxn5t2ttedah8jp'
      return
    }

    const res = await fetch('https://api.zilstream.com/tokens')
    const tokens = await res.json()

    interface ZilStreamToken {
      symbol: string
      address_bech32: string
    }

    tokens.forEach((token: ZilStreamToken) => (this.tokens[token.symbol] = token.address_bech32))
  }

  private async updateBlockHeight(): Promise<void> {
    const response = await this.zilliqa.blockchain.getNumTxBlocks()
    const bNum = parseInt(response.result!, 10)
    this.currentBlock = bNum
  }

  private readOptionalState(optString: string, argString: string[]): BigNumber {
    if (optString === 'Some') {
      return new BigNumber(argString[0])
    }

    return new BigNumber(0)
  }

  private readLaunchState(stateString: string): LaunchState {
    const constructorHash = this.contractHash
    const validationString = constructorHash + '.' + 'Validation'
    const openString = constructorHash + '.' + 'Open'
    const toLaunchString = constructorHash + '.' + 'ToLaunch'
    const launchedString = constructorHash + '.' + 'Launched'
    const onHoldString = constructorHash + '.' + 'OnHold'
    const dissolveString = constructorHash + '.' + 'Dissolve'

    if (stateString === validationString) {
      return LaunchState.Validation
    }
    if (stateString === openString) {
      return LaunchState.Open
    }
    if (stateString === toLaunchString) {
      return LaunchState.ToLaunch
    }
    if (stateString === launchedString) {
      return LaunchState.Launched
    }
    if (stateString === onHoldString) {
      return LaunchState.OnHold
    }
    if (stateString === dissolveString) {
      return LaunchState.Dissolve
    }
    return LaunchState.Undefined
  }

  private async updateAppState(): Promise<void> {
    // Get user address
    const currentUser = this.walletProvider
      ? // ugly hack for zilpay provider
        this.walletProvider.wallet.defaultAccount.base16.toLowerCase()
      : this.zilliqa.wallet.defaultAccount?.address?.toLowerCase() || null

    // Get the launcher contract state - only POOLS and TOTAL_SPONSORSHIP
    const requests: BatchRequest[] = []
    const address = this.contractHash.replace('0x', '')
    requests.push({ id: '1', method: 'GetSmartContractSubState', params: [address, 'launchs', []], jsonrpc: '2.0' })
    requests.push({ id: '2', method: 'GetSmartContractSubState', params: [address, 'total_sponsorship', []], jsonrpc: '2.0' })
    requests.push({ id: '3', method: 'GetSmartContractSubState', params: [address, 'influencer', []], jsonrpc: '2.0' })
    const result = await sendBatchRequest(this.rpcEndpoint, requests)
    const contractState = Object.values(result).reduce((a, i) => ({ ...a, ...i }), { sponsors: {}, zero_sponsor: {} }) as ContractState

    console.log('666666666666666666')
    console.log('666666666666666666')
    console.log('666666666666666666')
    console.log('666666666666666666')
    console.log('666666666666666666')
    console.log(contractState)
    console.log('666666666666666666')
    console.log('666666666666666666')
    console.log('666666666666666666')
    console.log('666666666666666666')
    console.log('666666666666666666')

    // Get the launcher contract state - SPONSORS(Balances)
    if (currentUser) {
      const requests3: BatchRequest[] = []
      Object.keys(contractState.launchs).forEach(token => {
        requests3.push({
          id: token,
          method: 'GetSmartContractSubState',
          params: [address, 'sponsors', [token, currentUser]],
          jsonrpc: '2.0',
        })
      })
      const result3 = await sendBatchRequest(this.rpcEndpoint, requests3)
      console.log('55555555555555555555')
      console.log('55555555555555555555')
      console.log('55555555555555555555')
      console.dir(result3, { depth: null })
      console.log(result3)
      console.log('55555555555555555555')
      console.log('55555555555555555555')
      console.log('55555555555555555555')
      Object.entries(result3).forEach(([token, mapOrNull]) => {
        contractState.sponsors[token] = mapOrNull ? mapOrNull.sponsors[token] : {}
      })
    }

    // Get the launcher contract state - ZERO SPONSORS(Balances)
    if (currentUser) {
      const requests4: BatchRequest[] = []
      Object.keys(contractState.launchs).forEach(token => {
        requests4.push({
          id: token,
          method: 'GetSmartContractSubState',
          params: [address, 'sponsors', [token, ZERO_HASH]],
          jsonrpc: '2.0',
        })
      })
      const result4 = await sendBatchRequest(this.rpcEndpoint, requests4)
      console.log('55555555555555555555')
      console.log('55555555555555555555')
      console.log('55555555555555555555')
      console.dir(result4, { depth: null })
      console.log(result4)
      console.log('55555555555555555555')
      console.log('55555555555555555555')
      console.log('55555555555555555555')
      Object.entries(result4).forEach(([token, mapOrNull]) => {
        contractState.zero_sponsor[token] = mapOrNull ? mapOrNull.sponsors[token] : {}
      })
    }

    // Get id of tokens that have sponsor pools
    const poolTokenHashes = Object.keys(contractState.launchs)
    const tokenHashes = poolTokenHashes.concat(HUSD_HASH)

    // Get token hashes from this.tokens
    // const defaultTokenHashes = Object.values(this.tokens).map((bech32: string) => this.getTokenAddresses(bech32).hash)
    // const tokenHashes = poolTokenHashes.concat(defaultTokenHashes.filter((item: string) => poolTokenHashes.indexOf(item) < 0))

    // Get token details
    const tokens: { [key in string]: TokenDetails } = {}
    const promises = tokenHashes.map(async hash => {
      const d = await this.fetchTokenDetails(hash)
      tokens[hash] = d
    })
    await Promise.all(promises)

    console.log('666666666666666666')
    console.log('666666666666666666')
    console.log(this.tokens)
    console.log('666666666666666666')
    console.log(poolTokenHashes)
    console.log('666666666666666666')
    console.log(tokenHashes)
    console.log('666666666666666666')
    console.log(tokens)
    console.log('666666666666666666')
    console.log(contractState)
    console.log('666666666666666666')
    console.log('666666666666666666')
    // Get Sponsortoken
    const sponsors: { [key in string]: SponsorToken } = {}
    poolTokenHashes.forEach(tokenHash => {
      const poolSponsors = contractState.sponsors[tokenHash]
      const userSponserToken = poolSponsors![currentUser!]
      console.log('888888888888888888888')
      console.log('888888888888888888888')
      console.log(tokenHash)
      console.dir(userSponserToken!, { depth: null })
      console.log(userSponserToken!)
      console.log('888888888888888888888')
      console.log('888888888888888888888')

      let sponsorHusd = new BigNumber(0)
      let removeHusd = new BigNumber(0)
      let transactionFee = new BigNumber(0)
      let entryBlock = new BigNumber(0)
      let lockIn = new BigNumber(0)

      if (userSponserToken !== undefined) {
        const [sp, rp, tp, fb, l] = userSponserToken!.arguments
        sponsorHusd = new BigNumber(sp)
        removeHusd = new BigNumber(rp)
        transactionFee = new BigNumber(tp)
        entryBlock = this.readOptionalState(fb.constructor.toString(), fb.arguments)
        lockIn = this.readOptionalState(l.constructor.toString(), l.arguments)
      }

      sponsors[tokenHash] = {
        sponsorHusd,
        removeHusd,
        transactionFee,
        entryBlock,
        lockIn,
      }
    })

    // Get zeroSponsortoken
    const zerosponsor: { [key in string]: SponsorToken } = {}
    poolTokenHashes.forEach(tokenHash => {
      const poolZeroSponsors = contractState.zero_sponsor[tokenHash]
      const zeroSponserToken = poolZeroSponsors![ZERO_HASH]
      console.log('888888888888888888888')
      console.log('888888888888888888888')
      console.log(tokenHash)
      console.dir(zeroSponserToken!, { depth: null })
      console.log('888888888888888888888')
      console.log('888888888888888888888')

      let sponsorHusd = new BigNumber(0)
      let removeHusd = new BigNumber(0)
      let transactionFee = new BigNumber(0)
      let entryBlock = new BigNumber(0)
      let lockIn = new BigNumber(0)

      if (zeroSponserToken !== undefined) {
        const [sp, rp, tp, fb, l] = zeroSponserToken!.arguments
        sponsorHusd = new BigNumber(sp)
        removeHusd = new BigNumber(rp)
        transactionFee = new BigNumber(tp)
        entryBlock = this.readOptionalState(fb.constructor.toString(), fb.arguments)
        lockIn = this.readOptionalState(l.constructor.toString(), l.arguments)
      }

      zerosponsor[tokenHash] = {
        sponsorHusd,
        removeHusd,
        transactionFee,
        entryBlock,
        lockIn,
      }
    })

    // Get pool details
    const pools: { [key in string]: Pool } = {}
    poolTokenHashes.forEach(tokenHash => {
      if (!contractState.launchs[tokenHash]) return

      const [x, y, p, s, d] = contractState.launchs[tokenHash]!.arguments
      const hashReserve = new BigNumber(x)
      const tokenReserve = new BigNumber(y)
      const exchangeRate = new BigNumber(p)
      const deadline = new BigNumber(d)
      const state = this.readLaunchState(s.constructor.toString())
      const userSponsor = sponsors[tokenHash]
      const zeroSponsor = zerosponsor[tokenHash]
      const totalSponsor = new BigNumber(contractState.total_sponsorship[tokenHash]!)

      pools[tokenHash] = {
        hashReserve,
        tokenReserve,
        exchangeRate,
        deadline,
        state,
        userSponsor,
        zeroSponsor,
        totalSponsor,
      }
    })

    // Set new state
    this.appState = {
      contractState,
      tokens,
      pools,
      currentUser,
      currentNonce: this.appState?.currentNonce || null,
      currentBalance: this.appState?.currentBalance || null,
    }

    console.log('999999999999999999999999')
    console.log('999999999999999999999999')
    console.log('999999999999999999999999')
    console.log('999999999999999999999999')
    console.dir(this.appState, { depth: null })
    console.log('888888888888888888888')
    console.log('999999999999999999999999')
    console.log('999999999999999999999999')
    console.log('999999999999999999999999')
    console.log('999999999999999999999999')
    console.log('999999999999999999999999')
  }

  private async updateBalanceAndNonce() {
    if (this.appState?.currentUser) {
      try {
        const res: RPCBalanceResponse = (await this.zilliqa.blockchain.getBalance(this.appState.currentUser)).result
        if (!res) {
          this.appState.currentBalance = new BigNumber(0)
          this.appState.currentNonce = 0
          return
        }
        this.appState.currentBalance = new BigNumber(res.balance)
        this.appState.currentNonce = parseInt(res.nonce, 10)
      } catch (err) {
        // ugly hack for zilpay non-standard API
        if (err.message === 'Account is not created') {
          this.appState.currentBalance = new BigNumber(0)
          this.appState.currentNonce = 0
        }
      }
    }
  }

  private async updateObservedTxs() {
    const release = await this.observerMutex.acquire()
    try {
      const removeTxs: string[] = []
      const promises = this.observedTxs.map(async (observedTx: ObservedTx) => {
        try {
          const result = await this.zilliqa.blockchain.getTransactionStatus(observedTx.hash)

          if (result && result.modificationState === 2) {
            // either confirmed or rejected
            const confirmedTxn = await this.zilliqa.blockchain.getTransaction(observedTx.hash)
            const receipt = confirmedTxn.getReceipt()
            const txStatus = confirmedTxn.isRejected() ? 'rejected' : receipt?.success ? 'confirmed' : 'rejected'
            if (this.observer) this.observer(observedTx, txStatus, receipt)
            removeTxs.push(observedTx.hash)
            return
          }
        } catch (e) {
          if (e.code === -20) {
            // "Txn Hash not Present"
            console.warn(`tx not found in mempool: ${observedTx.hash}`)
          } else {
            console.warn('error fetching tx state')
            console.error(e)
          }
        }
        if (observedTx.deadline < this.currentBlock) {
          // expired
          console.log(`tx exceeded deadline: ${observedTx.deadline}, current: ${this.currentBlock}`)
          if (this.observer) this.observer(observedTx, 'expired')
          removeTxs.push(observedTx.hash)
        }
      })

      await Promise.all(promises)

      this.observedTxs = this.observedTxs.filter((tx: ObservedTx) => !removeTxs.includes(tx.hash))

      await this.updateBalanceAndNonce()
    } finally {
      release()
    }
  }

  private parseRecipientAddress(addr: string | null): string {
    const address: string = addr === null ? this.getAppState().currentUser! : addr
    if (address.substr(0, 2) === '0x') {
      return address.toLowerCase()
    } else if (address.length === 32) {
      return `0x${address}`.toLowerCase()
    } else if (address.substr(0, 3) === 'zil') {
      return fromBech32Address(address).toLowerCase()
    } else {
      throw new Error('Invalid recipient address format!')
    }
  }

  private getTokenAddresses(id: string): { hash: string; address: string } {
    let hash, address

    if (id.substr(0, 2) === '0x') {
      hash = id.toLowerCase()
      address = toBech32Address(hash)
    } else if (id.substr(0, 3) === 'zil' && id.length > 3) {
      address = id
      hash = fromBech32Address(address).toLowerCase()
    } else {
      address = this.tokens[id]
      hash = fromBech32Address(address).toLowerCase()
    }

    return { hash, address }
  }

  private getTokenDetails(id: string): TokenDetails {
    const { hash } = this.getTokenAddresses(id)
    if (!this.appState) {
      throw new Error('App state not loaded, call #initialize first.')
    }
    if (!this.appState.tokens[hash]) {
      throw new Error(`Could not find token details for ${id}`)
    }
    return this.appState.tokens[hash]
  }

  public async fetchContractInit(contract: Contract): Promise<any> {
    // try to use cache first
    const lsCacheKey = `contractInit:${contract.address!}`
    if (isLocalStorageAvailable()) {
      const result = localStorage.getItem(lsCacheKey)
      if (result && result !== '') {
        try {
          return JSON.parse(result)
        } catch (e) {
          console.error(e)
        }
      }
    }
    // motivation: workaround api.zilliqa.com intermittent connection issues.
    try {
      const init = await contract.getInit()
      if (isLocalStorageAvailable()) {
        localStorage.setItem(lsCacheKey, JSON.stringify(init))
      }
      return init
    } catch (error) {
      if (error?.message === 'Network request failed') {
        // make another fetch attempt after 800ms
        return this.fetchContractInit(contract)
      } else {
        throw error
      }
    }
  }

  private async fetchTokenDetails(id: string): Promise<TokenDetails> {
    const { hash, address } = this.getTokenAddresses(id)

    if (!!this.appState?.tokens[hash]) return this.appState.tokens[hash]

    const contract = this.getContract(address)

    if (hash === ZIL_HASH) {
      return { contract, address, hash, symbol: 'ZIL', decimals: 12, whitelisted: true, registered: true }
    }

    const init = await this.fetchContractInit(contract)

    const decimalStr = init.find((e: Value) => e.vname === 'decimals').value as string
    const decimals = parseInt(decimalStr, 10)
    const symbol = init.find((e: Value) => e.vname === 'symbol').value as string
    const registered = this.tokens[symbol] === address
    const whitelisted = registered && (symbol === 'ZWAP' || symbol === 'XSGD' || symbol === 'gZIL') // TODO: make an actual whitelist

    return { contract, address, hash, symbol, decimals, whitelisted, registered }
  }

  private async checkAllowedBalance(token: TokenDetails, amount: BigNumber) {
    // Check init
    this.checkAppLoadedWithUser()
    const user = this.appState!.currentUser!

    if (token.hash === ZIL_HASH) {
      // Check zil balance
      const zilBalance = this.appState!.currentBalance!
      if (zilBalance.lt(amount)) {
        throw new Error(`Insufficent ZIL in wallet.
        Required: ${this.toUnit(token.hash, amount.toString()).toString()},
        have: ${this.toUnit(token.hash, zilBalance.toString()).toString()}.`)
      }
    } else {
      // Check zrc-2 balance
      const requests: BatchRequest[] = []
      const address = token.contract.address!.replace('0x', '')
      requests.push({ id: 'balances', method: 'GetSmartContractSubState', params: [address, 'balances', [user!]], jsonrpc: '2.0' })
      requests.push({
        id: 'allowances',
        method: 'GetSmartContractSubState',
        params: [address, 'allowances', [user!, this.contractHash]],
        jsonrpc: '2.0',
      })
      const result = await sendBatchRequest(this.rpcEndpoint, requests)
      const balance = new BigNumber(result.balances?.balances[user] || 0)
      if (balance.lt(amount)) {
        throw new Error(`Insufficent tokens in wallet.
        Required: ${this.toUnit(token.hash, amount.toString()).toString()},
        have: ${this.toUnit(token.hash, balance.toString()).toString()}.`)
      }
      const allowance = new BigNumber(result.allowances?.allowances[user]?.[this.contractHash] || 0)
      if (allowance.lt(amount)) {
        throw new Error(`Tokens need to be approved first.
        Required: ${this.toUnit(token.hash, amount.toString()).toString()},
        approved: ${this.toUnit(token.hash, allowance.toString()).toString()}.`)
      }
    }
  }

  public checkAppLoadedWithUser() {
    // Check init
    if (!this.appState) {
      throw new Error('App state not loaded, call #initialize first.')
    }

    // Check user address
    if (this.appState!.currentUser === null) {
      throw new Error('No wallet connected.')
    }

    // Check wallet account
    if (this.walletProvider && this.walletProvider.wallet.defaultAccount.base16.toLowerCase() !== this.appState!.currentUser) {
      throw new Error('Wallet user has changed, please reconnect.')
    }

    // Check network is correct
    if (this.walletProvider && this.walletProvider.wallet.net.toLowerCase() !== this.network.toLowerCase()) {
      throw new Error('Wallet is connected to wrong network.')
    }
  }

  public txParams(): TxParams & { nonce: number } {
    return {
      nonce: this.nonce(),
      ...this._txParams,
    }
  }

  public getCurrentBlock(): number {
    return this.currentBlock
  }

  public deadlineBlock(): number {
    return this.currentBlock + this.deadlineBuffer!
  }

  private nonce(): number {
    return this.appState!.currentNonce! + this.observedTxs.length + 1
  }

  private validateMaxExchangeRateChange(maxExchangeRateChange: number) {
    if (maxExchangeRateChange % 1 !== 0 || maxExchangeRateChange >= BASIS || maxExchangeRateChange < 0) {
      throw new Error(`MaxExchangeRateChange ${maxExchangeRateChange} must be an integer between 0 and ${BASIS + 1}.`)
    }
  }
}
